---
title: C++notify_one：何时需要加锁
description: |
    该文章主要分析对std::condition_variable中notify_one和wait的使用以及分析notify_one需要加锁和不需要加锁的俩种情况，以及虚假唤醒处理，并给出最佳实现方式。
date: 2024/12/28
---
# C++notify_one：何时需要加锁
该文章主要分析对std::condition_variable中notify_one和wait的使用，以及分析notify_one
需要加锁和不需要加锁的俩种情况，以及虚假唤醒处理，并给出最佳实现方式。

## notify_one
+ notify_one 唤醒一个由wait/wait_for/wait_until被阻塞的线程， 当存在多个被阻塞的线程时，由内核调度决定唤醒哪一个线程，在多核服务器上，会存在唤醒多个被阻塞的线程（虚假唤醒[^1][^2]情况）。
+ 当notify_one在 wait/wait_for/wait_until 之前执行时，信号会被忽略，后续线程执行到wait/wait_for/wait_until条件不满足时会进行阻塞。
## wait
wait 阻塞的线程除了会被notify_one/notify_all唤醒外，还会被虚假唤醒[^1][^2]
```cpp
std::unique_lock lk(lock);
wait(lk) // 原子调用 lock.unlock() 和 阻塞当前线程

std::unique_lock lk(lock);
cv.wait_for(lock, pre);
//相当于
std::unique_lock lk(lock);
while(!pre()) {
	wait(lock)
}
```
## notify_one 加锁-无效唤醒的情况
```cpp
#include<thread>
#include<mutex>
#include<condition_variable>

bool flag = false;
std::mutex m;
std::condition_variable cv;

//run in consumer thread
void Consumer(void)
{
  std::unique_lock lk(m);
  cv.wait(lk, [&](){ return flag; }); //#3
}

//run in producer thread
void Producer(void)
{
	{
		std::unique_lock lk(m);
		flag = true;
		cv.notify_one(); //#1
	}
	//#2
	//....
}
```
存在无效唤醒的情况：当consumer thread 执行到#3处于阻塞状态时，producer thread执行到#1时，notify_one唤醒consumer thread时需要获取锁，__但此时锁m被producer thread持有，再次阻塞等到producer thread执行到#2释放锁(这一阻塞过程相当于一次无效唤醒)__，consumer thread才会持有锁。
## notify_one 不加锁-信号丢失情况
如果notify_one不加锁情况，会出现信号丢失问题。
```cpp
#include<chrono>
#include<condition_variable>
#include<thread>
#include<mutex>

bool flag = false;
std::mutex m;
std::condition_variable cv;

//run in consumer thread
void Consumer(void)
{
  std::unique_lock lk(m); //#1
  //cv.wait(lk, [&](){ return !flag; });
  //等同下面代码
  while(!flag) { //producer线程还没有执行到#4, flag为false
    std::this_thread::sleep_for(std::chrono::seconds(1)); //#2
    //采用sleep方式模拟以下情况
    //在Consumer执行到时, producer线程执行#4和#5发送信号
    //此时的信号会被忽略，因为此时并没有阻塞线程
    cv.wait(lk); //#3 此时之前的信号被忽略，会一直阻塞状态
  }
}

//run in producer thread
void Producer(void)
{
  flag = true; //#4
  cv.notify_one(); //#5
}

int main()
{
  std::thread consumer(Consumer), producer(Producer);
  consumer.join();
  producer.join();
  return 0;
}

```
## 正确的写法
在更新 __临界区资源(在这里指的是wait需要判定的变量，wait(lock, \[](){临界区资源}))__ 时需要进行加锁，在完成更新临界区资源后，释放锁后在执行notify_one唤醒以避免无效唤醒，cppreference关于notify_one是否加锁：在精确调度情况下是需要锁的，其中也提到对于加锁是“pessimization”[cppreference notify_one](https://en.cppreference.com/w/cpp/thread/condition_variable/notify_one)。这里个人观点是在处理临界资源时，加锁是必须的，后面也会给出Sean Parent对于notify_one应用的例子，也是对临界资源操作加锁。
```cpp
#include<chrono>
#include<condition_variable>
#include<thread>
#include<mutex>

bool flag = false;
std::mutex m;
std::condition_variable cv;

//run in consumer thread
void Consumer(void)
{
  std::unique_lock lk(m); //#1
  cv.wait(lk, [&](){ return flag; });
}

//run in producer thread
void Producer(void)
{
  {
    //采用{}将临界区资源封装起来
    //当退出到作用域时, 销毁局部变量lk,根据RAII释放锁
    std::unique_lock lk(m);
    flag = true; //#2 修改临界资源flag
  }
  //#3 释放锁
  cv.notify_one(); //#4
}

int main()
{
  std::thread consumer(Consumer), producer(Producer);
  consumer.join();
  producer.join();
  return 0;
}
```
## 实际应用代码例子
这里是stlab/libraries仓库中关于notify_queue的实现代码
+ 代码地址 https://github.com/stlab/libraries/include/stlab/concurrency/default_executor.hpp 作者：Sean Parent
+ notify_queue功能和代码设计简要介绍：
	+ 将临界资源(队列，状态)和锁，信号量封装在一起，外部无需操心同步问题。
	+ 采用优先级队列存放待执行的函数，并提供push加入函数，pop返回待执行函数等操作接口。
+ 这里主要关注下pop和push函数实现以及观察是如何处理临界资源，先从pop函数中wait中确定哪些是临界资源。
```cpp
class notification_queue {
	//优先队列cmp结构，按照_priority属性进行排序
    struct element_t {
        std::size_t _priority;
        task<void() noexcept> _task;

        template <class F>
        element_t(F&& f, std::size_t priority) : _priority{priority}, _task{std::forward<F>(f)} {}

        struct greater {
            bool operator()(const element_t& a, const element_t& b) const {
                return b._priority < a._priority;
            }
        };
    };

    std::mutex _mutex;
    using lock_t = std::unique_lock<std::mutex>;
    std::condition_variable _ready;
    std::vector<element_t> _q; // can't use priority queue because top() is const
    std::size_t _count{0};
    bool _done{false};
    bool _waiting{false};

    static constexpr std::size_t merge_priority_count(std::size_t priority, std::size_t count) {
        assert((priority < 4) && "Priority must be in the range [0, 4).");
        return (priority << (sizeof(std::size_t) * CHAR_BIT - 2)) | count;
    }

    // Must be called under a lock with a non-empty _q, always returns a valid task
    auto pop_not_empty() -> task<void() noexcept> {
        auto result = std::move(_q.front()._task);
        std::pop_heap(begin(_q), end(_q), element_t::greater());
        _q.pop_back();
        return result;
    }

public:
    auto try_pop() -> task<void() noexcept> {
        lock_t lock{_mutex, std::try_to_lock};
        if (!lock || _q.empty()) return nullptr;
        return pop_not_empty();
    }

    // If waiting in `pop()`, wakes and returns true. Otherwise returns false.
    bool wake() {
        {
            lock_t lock{_mutex, std::try_to_lock};
            if (!lock || !_waiting) return false;
            _waiting = false; // triggers wake
        }
        _ready.notify_one();
        return true;
    }

    auto pop() -> std::pair<bool, task<void() noexcept>> {
        lock_t lock{_mutex};
        _waiting = true;
		//笔者注：下面while结构等价于
		//_ready.wait(lock, [&](){ return _q.empty() && !_done && _waiting})
		//临界资源为 _q队列，_done和_waiting变量
        while (_q.empty() && !_done && _waiting)
            _ready.wait(lock);
        _waiting = false;
        if (_q.empty()) return {_done, nullptr};
        return {false, pop_not_empty()};
    }

    void done() {
        {
			//更新临界资源_done变量，用{}括起来并加锁
            lock_t lock{_mutex};
            _done = true;
        }
		//释放锁并发送信号唤醒阻塞线程
        _ready.notify_one();
    }

    template <typename F>
    bool try_push(F&& f, std::size_t priority) {
        {
            lock_t lock{_mutex, std::try_to_lock};
            if (!lock) return false;
            _q.emplace_back(std::forward<F>(f), merge_priority_count(priority, _count++));
            std::push_heap(begin(_q), end(_q), element_t::greater());
        }
        _ready.notify_one();
        return true;
    }

    template <typename F>
    void push(F&& f, std::size_t priority) {
        {
			//操作_q队列，用{}括起来并加锁
            lock_t lock{_mutex};
            _q.emplace_back(std::forward<F>(f), merge_priority_count(priority, _count++));
            std::push_heap(begin(_q), end(_q), element_t::greater());
        }
		//释放锁并发送信号
        _ready.notify_one();
    }
};

```

## notify_one 函数总结
在需要使用notify_one进行同步的时候，需要先设置好哪些是属于临界资源（wait等待判断资源），对于临界资源操作使用{}括起来并加锁后进行操作，避免无效唤醒和信号丢失情形。
## 引用资料
[^1]:[虚假唤醒wiki](https://en.wikipedia.org/wiki/Spurious_wakeup)
[^2]:[Multiple Awakenings by Condition Signal](https://pubs.opengroup.org/onlinepubs/009604599/functions/pthread_cond_signal.html)