---
title: C++并发设计：线程池设计（二）— 代码实现
description: |
  本文章通过C++并发设计：线程池设计（一）项目代码分析文章总结的线程池设计框架，以及代码设计的优秀之处，结合各个项目的优点，然后再进行整合，采用C++23标准最终实现自己的线程池代码，这里更关注设计，因此采用C++23标准可以直接使用move_only_function，而减少实现上的复杂性，兼容低版本可以自身实现move_only_func，并使用C++concepts对模板参数进行约束。
date: 2025/01/01
---
# C++并发设计：线程池设计（二）— 代码实现
本文章通过C++并发设计：线程池设计（一）项目代码分析文章总结的线程池设计框架，以及代码设计的优秀之处，结合各个项目的优点，然后再进行整合，采用C++23标准最终实现自己的线程池代码，这里更关注设计，因此采用C++23标准可以直接使用move_only_function，而减少实现上的复杂性，兼容低版本可以自身实现move_only_func。

## 线程池代码设计考虑和要点
+ 可以调用对象接口设计，不预设参数，减少负担
+ 采用move_only_function提供移动值语义，避免指针的使用，来进行管理可调用对象的资源。
+ 对于共享变量需要cache line对齐，避免缓存失效问题
+ 尽可能减少线程阻塞，采用多队列而不是单队列，优先采用try_lock，而不是lock。
## 通知队列设计
__NotifyQueue__
+ 互斥锁的选择，采用spinlock还是mutex，这里使用C++concepts和template约束一个锁类型，具体类型提供给使用者进行决定，尽可能通用而不是限制，默认使用std::mutex。
+ 线程池在退出时，应该把剩余的任务都执行完再退出，第一种做法是，在每个线程对象上增加状态stop，当stop为true时，遍历执行队列的所有任务，然后进行退出，这里stop类型一般为普通布尔值，依靠缓存一致性协议进行同步，或者使用jthread中自带的stop_token进行同步，第二种做法是，在队列上增加状态done，当在出队列done为true且队列为空时返回true，这时线程可以退出。第一种做法需要判断线程状态同时还需要去检查队列是否为空，而第二种只需要判断队列状态即可，更合理。上诉情形针对队列与线程的数量关系是1对1，或1对多情形，若是多队列和单线程情形，那么考虑用线程状态判断会合理，此时把若根据队列状态还需要维护统计各个队列的状态，这会增加代码复杂性以及降低性能。
+ 线程间同步方式，可以采用原子信号binary_semaphore或者条件变量condition_variable，因为这俩者接口不一致，不能采用模板来进行抽象，binary_semaphore等待依赖于平台实现，若平台不支持则是使用spinlock实现，在这里考虑到避免空转cpu使用率高情形，因此选用condition_variable，实际测试上性能没有啥差距。
## NotifyQueue具体代码实现
```cpp
#pragma once
#include <concepts>
#include <condition_variable>
#include <mutex>
#include <queue>

//对锁类型进行约束，默认mutex 可提供使用spinlock类型替换
template<typename LockType>
//is_lockable约束类型需要满足存在可调用 lock, unlock, try_lock函数
//且try_lock返回值可被转换成bool类型
concept is_lockable = requires(LockType&& lock) {
  lock.lock();
  lock.unlock();
  { lock.try_lock() } -> std::convertible_to<bool>;
};

template<typename T, typename LockType>
requires is_lockable<LockType>
class NotifyQueue {
  public:
    using value_type = T;
    using size_type = typename std::queue<T>::size_type;
    using lock_t = std::unique_lock<LockType>;

    NotifyQueue()=default;
    NotifyQueue(const NotifyQueue&)=delete;
    NotifyQueue& operator&(const NotifyQueue&)=delete;

    void Enqueue(T&& value) noexcept {
      {
        lock_t lk{mutex_};
        q_.emplace(std::forward<T>(value));
      }
      cv_.notify_one();
    }

    [[nodiscard]] bool TryEnqueue(T&& value) noexcept {
      {
        lock_t lk{mutex_, std::try_to_lock};
        if(!lk) return false;
        q_.emplace(std::forward<T>(value));
      }
      cv_.notify_one();
      return true;
    }

	//当队列为空且done为true时返回true，其他返回false
    [[nodiscard]] bool Dequeue(T& value) noexcept {
      lock_t lk{mutex_};
      while(q_.empty() && !done_) {
        cv_.wait(lk);
      }
      if(q_.empty()) return true;
      value = std::move(q_.front());
      q_.pop();
      return false
    }

    void TryDequeue(T& value) noexcept {
      lock_t lk{mutex_, std::try_to_lock};
      if(!lk || q_.empty()) return;
      value = std::move(q_.front());
      q_.pop();
      return;
    }

    [[nodiscard]] size_type Size() const noexcept {
      lock_t lk{mutex_};
      return q_.size();
    }

    void Done() noexcept {
      {
        lock_t lk{mutex_};
        done_ = true;
      }
      cv_.notify_one();
    }

  private:
    std::queue<T> q_;
    std::condition_variable cv_;
    LockType mutex_;
    bool done_{false};
};
```
## 线程池设计
+ 线程池初始化回调：可以在线程启动时需要初始化资源，或者设置线程名称属性，因此需要回调函数参数，在开始执行任务之前进行初始化操作。
+ 增加任务接口设计：第一种任务不需要获取结果，添加任务后不需要再额外联系，直接封装函数添加到队列里就可以了，第二种需要获取任务异步执行结果，或者需要等待任务执行完消息，采用future和promise来进行获取异步执行结果。
+ 是否支持异常：不支持异常，对于添加的任务做noexcept检查，上层调用自行对任务进行判断。
+ 任务调度：这里采用线程和队列对应关系为1：1，每个线程都有对应队列的id（下标），当接收到一个任务时，优先尝试获取当前id的队列的锁，若获取到锁则添加到队列中，若是获取失败，则从当前队列开始遍历其他其他队列，尝试获取到锁添加任务。当尝试一圈（环形遍历）还没有获取到锁时，则在当前id队列进行阻塞添加任务。
+ 同样的线程获取任务执行，也是优先从当前队列开始尝试获取任务，最后都没有的时候，再对当前队列等待直到被唤醒，这样减少阻塞时间。
+ 线程退出：将所有队列更新状态done为true，每个线程当执行完对应的id队列中的所有任务，返回done为true，则退出线程。
+ 线程退出时回调：这里不需要再额外增加退出回调函数，如果需要在线程退出时释放资源时，可以在对应的线程初始化回调函数中使用std::at_thread_exit函数进行注册即可。
## 线程池实现具体代码
```cpp
#pragma once
#include <functional>
#include <future>
#include <thread>
#include <vector>

#include "notify_queue.h"

template<typename Functor = std::move_only_function<void() noexcept>, 
         typename LockType = std::mutex,
         typename InitFunc = std::function<void()>>
requires is_lockable<LockType>
class ThreadPool {
public:
  explicit ThreadPool(size_t thread_num, InitFunc init = []() noexcept {}) 
  : count_(thread_num),
    index_(0),
    queues_(thread_num)
  {
    for(size_t i = 0; i < thread_num; ++i) {
      threads_.emplace_back([&, init=init, id = i](){
        init();
        while(true) {
          Functor f{nullptr};
          for(unsigned n = 0; n < count_ && !f; ++n) {
            queues_[(n + id) % count_].TryDequeue(f);
          }
          if(!f) {
            bool done = queues_[id].Dequeue(f);
            if(done) return;
          }
          if(f) f();
        }
      });
    }
  }


  ~ThreadPool()
  {
	//退出是先设置队列状态
    for(auto&& q : queues_) {
      q.Done();
    }
	//等待各个队列执行完成
    for(auto&& thread : threads_) {
      thread.join();
    }
  }
  //无需获取函数结果且不再关系。
  template<typename F, typename... Args,
  typename = std::enable_if_t<std::is_nothrow_invocable_v<F, Args...>>>
  void PostDetach(F&& func, Args&&... args) noexcept {
    Dispatch([f = std::move(func),
                        ... largs = std::move(args)] noexcept {
                          std::invoke(f, largs...);
                        });
  }
  
  //需要获取异步执行结果
  template<typename F, typename... Args, 
  typename R=std::enable_if_t<std::is_nothrow_invocable_v<F, Args...>, std::result_of_t<F&&(Args&&...)>>>
  std::future<R> Post(F&& func, Args&&... args) noexcept {
    std::promise<R> promise;
    auto future = promise.get_future();
    Dispatch([f = std::move(func),
              ... largs = std::move(args),
              p = std::move(promise)] mutable noexcept {
                if constexpr(std::is_same_v<R, void>) {
                  std::ignore = std::invoke(f, largs...);
                  p.set_value();
                } else {
                  R result = std::invoke(f, largs...);
                  p.set_value(std::move(result));
                }
              });
    return future;
  }

  void Dispatch(Functor&& func) noexcept {
    auto i = index_++;
	//任务调度，先使用try_lock尝试获取空闲锁，避免阻塞时间过长。
    for(unsigned n = 0; n < count_; ++n) {
      if(queues_[(i+n) % count_].TryEnqueue(std::forward<Functor>(func))) return;
    }
    queues_[i%count_].Enqueue(std::forward<Functor>(func));
  }

private:
  unsigned count_;
  std::atomic<unsigned> index_;
  std::vector<NotifyQueue<Functor, LockType>> queues_;
  std::vector<std::thread> threads_;
};
```
## 使用例子
```cpp
#include <iostream>

#include "thread_pool.h"

int NormalFunc(int val) noexcept {
    std::cout << "call normal func\n";
    return val;
}

struct CallObject
{
    int MemberFunc(int val) noexcept { 
        std::cout << "call member func\n";
        return val;
    }
};


int main() {
    //caution: callfunc must be noexcept
    //init four thread
    util::ThreadPool<> thread_pool{4, []() noexcept {
        std::cout << " thread init \n";
    }};

    //push lambda
    thread_pool.PostDetach([] noexcept {
        std::cout << "call lambda PostDetach\n";
    });

    //get async result
    auto future = thread_pool.Post([] noexcept {
        std::cout << "call lambda Post and return result\n";
        return 1;
    });
    //wait result
    std::cout << "get async result " << future.get() << std::endl;

    //execute normal func
    future = thread_pool.Post(NormalFunc, 1);
    std::cout << "get normal func result " << future.get() << std::endl;

    //execute member func
    auto callobject = CallObject{};
    future = thread_pool.Post(&CallObject::MemberFunc, &callobject, 1);
    std::cout << "get member func result " << future.get() << std::endl;

    return 0;
}

```
## 项目地址
+ https://github.com/cyy-tag/thread_pool.git