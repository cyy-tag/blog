---
title: C++并发设计：线程池设计（一）— 项目代码分析
description: |
    本篇文章通过介绍和总结当前开源的C++线程池（按照讲解顺序，依次为CTPL、thread-pool)  
    设计代码实现、分析单队列和多队列俩者的实现方式，以及异步执行获取结果方式
    C++20 binary_semaphore和jthread新特性使用和讨论。
date: 2024/12/29
---
# C++并发设计：线程池设计（一）— 项目代码分析
本篇文章通过介绍和总结当前开源的C++线程池（按照讲解顺序，依次为CTPL、thread-pool）
设计代码实现、分析单队列和多队列俩者的实现方式，以及异步执行获取结果方式
C++20 binary_semaphore和jthread新特性使用和讨论。

## 单队列形式

采用单一队列，作为同步存储和分配待执行函数的数据结构

## CTPL 项目

+ 项目地址：https://github.com/vit-vit/CTPL
	C++标准：C++11
	代码结构设计简介：
	1.采用单队列（mutex + queue）形式进行派发
	2.函数形式：ReturnType (int, Args...) {...}，需要预留第一个int参数，线程执行时会将自身索引id作为参数传入,
	使用bind对函数和参数进行封装返回function<void(int)>形式。
	4.异步执行获取结果方式：采用future和promise进行实现
	5.提供void resize(int) 可动态调整线程数量
	6.线程间同步方式：mutex+condition_variable
	7.提供boost无锁队列版本（这里只分析stl模板）
+ __主要代码实现__

​	队列的push和pop函数

```cpp
bool push(T const & value) {
    std::unique_lock<std::mutex> lock(this->mutex);
    this->q.push(value);
    return true;
}

bool pop(T & v) {
    std::unique_lock<std::mutex> lock(this->mutex);
    if (this->q.empty())
        return false;
    v = this->q.front(); //笔者注：queue存储是function<void(int id)>* 指针类型
    this->q.pop();		//这里复制地址，不需要考虑失效pop后对象失效问题
    return true;
}

//笔者注：在这里pop可以优化锁的粒度， 如以下代码
bool pop(T& v) {
    {
        std::unique_lock<std::mutex> lock(this->mutex);
        if(this->q.empty())
            return false;
        v = this->q.front();
    } // 采用大括号{}包含临界资源，退出时释放锁
    this->q.pop();
    return true;
}
```
​	线程池push函数实现

```cpp
template<typename F, typename... Rest>
auto push(F && f, Rest&&... rest) ->std::future<decltype(f(0, rest...))> {
    //这里因为C++11 function是需要可拷贝构造限制，packaged_task是不可拷贝的，因此采用共享指针指向packaged_task对象
    //直到 C++23支持move_only_function，去掉指针，使用值形式，如以下形式写法
    /*
    	auto pck = std::packaged_task<decltype(f(0, rest...))(int)>>(
        std::bind(std::forward<F>(f), std::placeholders::_1, std::forward<Rest>(rest)...)
        );
        auto future = pck.future();
        this->q.push([pck_f = std::move(pck)](int id) mutable {
        	pck_f(id);
        });
        q队列存储对象为move_only_function， 其他函数也需要进行调整
    */
    auto pck = std::make_shared<std::packaged_task<decltype(f(0, rest...))(int)>>(
        std::bind(std::forward<F>(f), std::placeholders::_1, std::forward<Rest>(rest)...)
        );
    auto _f = new std::function<void(int id)>([pck](int id) {
        (*pck)(id);
    });
    this->q.push(_f);#1
    std::unique_lock<std::mutex> lock(this->mutex);
    this->cv.notify_one();
    return pck->get_future();
}
```
#1处将_f函数添加进队列，虽然q队列是线程安全的，但对于线程信号同步来说存在无效唤醒问题：
为了更方便分析，下面代码是set_thread函数中的对线程同步逻辑（全部代码在下面）

```cpp
std::unique_lock<std::mutex> lock(this->mutex);
auto pre = 
...
this->cv.wait(lock, [this, &_f, &isPop, &_flag]()
					{ isPop = this->q.pop(_f); return isPop || this->isDone || _flag; });
//当接收到信号且队列不为空或停止时唤醒线程，这里等价转换成while(pre()){ cv.wait()} 形式，唤醒wake()表示
//push函数				   				   //set_thread 函数
											std::unique_lock<std::mutex> lock(this->mutex);
											auto pre = [this, &_f, &isPop, &_flag]()
											{ isPop = this->q.pop(_f); return isPop || this->isDone || _flag; };
											while(!pre()) {//当q队列为空时，且不停止，进入循环
 this->q.push(_f); #1							//此时
     											lock.lock() #2
 lock(this->mutex);	 #3							wait()//阻塞直到接收到信号;
 this->cv.notify_one();	 #4                         
 						    					std::unique_lock<std::mutex> lock(this->mutex); #5
 return pck->get_future(); #6                   //当前锁在push持有，当前线性阻塞
 //函数返回释放锁								    //当push释放锁时，获取锁，开始运行
											}
```
可以看到当notify_one发送信号，但同时持有锁时，此时被唤醒的线程会尝试获取锁再一次阻塞，优化下代码问题

```cpp
//push函数				   				   //set_thread 函数
											std::unique_lock<std::mutex> lock(this->mutex);
											auto pre = [this, &_f, &isPop, &_flag]()
											{ isPop = this->q.pop(_f); return isPop || this->isDone || _flag; };
											while(!pre()) {//当q队列为空时，且不停止，进入循环
 						    				    lock.lock() #2
 {                                              wait()//阻塞直到接收到信号;
    std::unique_lock lk(this->mutex);
 }
 //释放锁再通知线程，这样唤醒线程也不会立马没获取到锁再次阻塞，
 this->cv.notify_one();	 #4                         
 						    					std::unique_lock<std::mutex> lock(this->mutex); #5
 return pck->get_future(); #6                   //当前锁在push持有，当前线性阻塞
 //函数返回释放锁								    //当push释放锁时，获取锁，开始运行
											}	
```

线程池分配执行实现set_thread

```cpp
void set_thread(int i) {
    std::shared_ptr<std::atomic<bool>> flag(this->flags[i]); // a copy of the shared ptr to the flag
    auto f = [this, i, flag/* a copy of the shared ptr to the flag */]() {
        std::atomic<bool> & _flag = *flag;
        std::function<void(int id)> * _f;
        bool isPop = this->q.pop(_f);
        while (true) {
            while (isPop) {  // if there is anything in the queue
                //采用unique_ptr封装函数指针, 并管理生命周期
                //执行结束或异常离开作用域, 会释放函数指针指向地址
                std::unique_ptr<std::function<void(int id)>> func(_f); // at return, delete the function even if an exception occurred
                (*_f)(i);
                if (_flag)
                    return;  // the thread is wanted to stop, return even if the queue is not empty yet
                else
                    isPop = this->q.pop(_f); //调用队列获取一个指向待执行函数的地址
            }
            // the queue is empty here, wait for the next command
            std::unique_lock<std::mutex> lock(this->mutex);
            ++this->nWaiting;
            this->cv.wait(lock, [this, &_f, &isPop, &_flag](){ isPop = this->q.pop(_f); return isPop || this->isDone || _flag; }); #2
            --this->nWaiting; //减少等待线程数
            if (!isPop)
                return;  // if the queue is empty and this->isDone == true or *flag then return
        }
    };
    this->threads[i].reset(new std::thread(f)); // compiler may not support std::make_unique()
}
```

+ __分析总结__
  + 对于库的使用，添加待执行函数，都需要额外注意第一次参数需要预留给线程回调，这会是一个额外的负担。
  + 线程同步mutex+condition以及队列自身也有一个同步锁，这俩者可以封装合并成一个通知队列， 可以减少一个锁消耗。
  + 函数采用指针形式进行存储，需要显示new分配，以及显示delete进行释放（项目采用unique_ptr进行封装），在管理上也是存在额外负担，到C++23有move_only_function支持移动，可以优化成值形式，不再需要显示管理对象生命周期。

## 多队列形式

采用多个队列作为同步存储和分配待执行函数的数据结构

##  thread_pool 项目

项目地址：[DeveloperPaul123/thread-pool: A modern, fast, lightweight thread pool library based on C++20](https://github.com/DeveloperPaul123/thread-pool)

C++标准：C++20

__代码结构设计简介__：

1.采用多队列形式进行分配函数， 再通过简单的窃取算法，空闲时从其他队列获取执行对象进行调用，避免“一核有难，多核围观”情形。

2.函数形式：相比较ctpl项目不再需要预留参数，std::function，同时支持C++23 move_only_function特性

3.异步执行获取结果方式：采用future和promise进行实现

4.采用原子信号量 C++20 binary_semaphore 替代 condition_variable 进行信号同步

5.C++20 std::jtrhead替代 std::thread作为线程对象，相对于thread, jthread在析构时会自动调用join, 且增加stop_token来管理线程状态。

__主要代码实现__

项目分为俩个文件thread_safe_queue.h实现一个线程安全队列，thread_pool.h实现线程调度，

thread_safe_queue.h实现跟ctpl实现基本一致，异步结果获取也是使用future和promise不再过多描述，这里只关注以下问题

+ 线程之间是怎么同步的，是否有同样无效锁或信号丢失问题
+ 以及线程如何保证所有任务执行完，再进行退出，同上一个

+ 以及关注下C++20 binary_semaphore和jthread的应用
+ 多队列相对于单队列的好处

__thread_pool的成员__

```cpp
class thread_pool {
    ...
    private:
    //再增加一个结构task_item将信号量和队列封装在一起，这里没有ctpl项目额外mutex的消耗。
    struct task_item {
        dp::thread_safe_queue<FunctionType> tasks{};
        std::binary_semaphore signal{0};
    };
    std::vector<ThreadType> threads_; //ThreadType默认是jthread类型
    std::deque<task_item> tasks_; //多队列
    //threads_ 和 tasks_ 的对应关系是 threads_[i] <-> tasks_[i]
    dp::thread_safe_queue<std::size_t> priority_queue_;
    //priority_queue_, 每次从前面取取出一个tasks_的下标，然后添加到tasks_[i]并发送信号，将当前i添加到队尾
    //想当于 i = (i++) % size;
    // guarantee these get zero-initialized
    std::atomic_int_fast64_t unassigned_tasks_{0}/*未开始的任务*/, in_flight_tasks_{0}/*未开始的任务数+正在执行的任务数 = 总的未完成任务数*/;
    std::atomic_bool threads_complete_signal_{false};//是否都完成信号
}
```

__线程间同步关键函数enqueue_task 和  thread_pool__

__enqueue_task 以及附带注释说明__

```cpp
template <typename Function>
void enqueue_task(Function &&f) {
    //取出一个下标，这里作者考虑到可能线程数为0的情况，从而使用std::optional<T>以及多一些特判
    auto i_opt = priority_queue_.copy_front_and_rotate_to_back();
    if (!i_opt.has_value()) {
        // would only be a problem if there are zero threads
        return;
    }
    // get the index
    auto i = *(i_opt);
	
    // increment the unassigned tasks and in flight tasks
    unassigned_tasks_.fetch_add(1, std::memory_order_release);    //待执行的任务数增加1
    const auto prev_in_flight = in_flight_tasks_.fetch_add(1, std::memory_order_release);// 获取未完成的任务数
    // reset the in flight signal if the list was previously empty
    if (prev_in_flight == 0) {
        //如果为0，那么当前所有线程都已经完成，有添加新任务，需要改变完成状态
        threads_complete_signal_.store(false, std::memory_order_release);
    }

    // assign work
    tasks_[i].tasks.push_back(std::forward<Function>(f));
    //注意:这里的singnal是std::binary_semaphore类型，release会唤醒调用tasks_[i].acquire()阻塞的线程
    //且别于condition_variable类型，binary_semaphore并不会持有锁。因此不会出现无效唤醒情况，只需要考虑好是否会存在信号丢失问题。
    tasks_[i].signal.release();
}
```

__thread_pool 附带注释说明__

```cpp
template <typename InitializationFunction = std::function<void(std::size_t)>>
    requires std::invocable<InitializationFunction, std::size_t> &&
             std::is_same_v<void, std::invoke_result_t<InitializationFunction, std::size_t>>
explicit thread_pool(
    const unsigned int &number_of_threads = std::thread::hardware_concurrency(),
    InitializationFunction init = [](std::size_t) {})
    : tasks_(number_of_threads) {
    std::size_t current_id = 0;
    for (std::size_t i = 0; i < number_of_threads; ++i) {
        //设置可执行task的下标
        priority_queue_.push_back(size_t(current_id));
        try {
            threads_.emplace_back([&, id = current_id,
                                   init](const std::stop_token &stop_tok) {
                // invoke the init function on the thread
                try {
                    //执行初始化函数
                    std::invoke(init, id);
                } catch (...) {
                    // suppress exceptions
                }

                do {
                    // wait until signaled
                    //阻塞，等待信号
                    tasks_[id].signal.acquire();

                    do {
                        // invoke the task
                        //遍历整个task_[id].tasks队列，获取任务并执行
                        while (auto task = tasks_[id].tasks.pop_front()) {
                            // decrement the unassigned tasks as the task is now going
                            // to be executed
                            //总的未执行任务数减少1
                            unassigned_tasks_.fetch_sub(1, std::memory_order_release);
                            // invoke the task
                            std::invoke(std::move(task.value()));
                            // the above task can push more work onto the pool, so we
                            // only decrement the in flights once the task has been
                            // executed because now it's now longer "in flight"
                            //未完成任务减少1
                            in_flight_tasks_.fetch_sub(1, std::memory_order_release);
                        }
						
                        //当前队列已经执行完，那么表示当前线程比较空闲，遍历其他队列
                        //从其他队列获取任务进行执行，每次最多从其他队列偷取一个任务进行执行。
                        for (std::size_t j = 1; j < tasks_.size(); ++j) {
                            const std::size_t index = (id + j) % tasks_.size();
                            if (auto task = tasks_[index].tasks.steal()) {
                                // steal a task
                                unassigned_tasks_.fetch_sub(1, std::memory_order_release);
                                std::invoke(std::move(task.value()));
                                in_flight_tasks_.fetch_sub(1, std::memory_order_release);
                                // stop stealing once we have invoked a stolen task
                                break;
                            }
                        }
                        // check if there are any unassigned tasks before rotating to the
                        // front and waiting for more work
                        // 如果还存在未开始的任务，那么继续遍历队列获取任务执行
                    } while (unassigned_tasks_.load(std::memory_order_acquire) > 0);
					//当前线程空闲，将对应索引移动到队列头，提高优先级。
                    priority_queue_.rotate_to_front(id);
                    // check if all tasks are completed and release the "barrier"
                    if (in_flight_tasks_.load(std::memory_order_acquire) == 0) {
                        //如果全部任务都完成，那么改变线程状态为true，“完成”状态
                        // in theory, only one thread will set this
                        threads_complete_signal_.store(true, std::memory_order_release);
                        threads_complete_signal_.notify_one();
                    }
			 	//jthread stop_requested获取当前线程是否处于退出请求状态。
                } while (!stop_tok.stop_requested());
            });
            // increment the thread id
            ++current_id;

        } catch (...) {
            // catch all

            // remove one item from the tasks
            tasks_.pop_back();

            // remove our thread from the priority queue
            std::ignore = priority_queue_.pop_back();
        }
    }
}

```

__~thread_pool 关闭操作__

```cpp
~thread_pool() {
    wait_for_tasks();
	//先等待所有任务被执行完
    // stop all threads
    for (std::size_t i = 0; i < threads_.size(); ++i) {
        //改变jthread的状态
        threads_[i].request_stop();
        //再唤醒所有线程,当所有线程执行到stop_requested返回true，退出循环函数
        tasks_[i].signal.release();
        //join
        threads_[i].join();
    }
}
```

回到开头的问题：

+ 线程是如何同步：
  + binary_semaphore采用的是计数方式而不是condition_variable信号方式，并不会出现先release再acquire，会出现信号丢失问题
  + 在enqueue_task, push_back执行完释放锁，在执行release()，也避免了无效唤醒情况。
  + 采用in_flight_tasks_统计未完成任务数，当减少到0时，才执行request_stop改变jthread线程状态，然后唤醒线程，退出循环函数。
+ 多队列和单队列比较
  + 这个可以从实现方式上来看，多队列可以有效减少锁冲突，减少线程阻塞的概率。

__note:__ binary_semaphore实现：如果平台支持__platform_wait，则使用平台执行等待，否则使用spin lock实现等待，若使用

spin lock实现，那么在空闲时线程空转等待和负载高，cpu使用率都会接近到100，对于运维监控和问题排查来说是一个问题，不能很好根据cpu使用率来

判断当前系统负载。

## 总结

+ 使用多队列相对于单队列形式，可以减少锁冲突的概率，减少线程阻塞的概率。
+ 使用condition_variable.notify_one时需要注意无效唤醒状态
+ 在操作临界资源时，可以使用{}和loack_guard或unique_lock，将临界资源单独一个作用域，可以减少锁粒度
+ binary_semaphore阻塞依赖于平台实现，标准库使用spin lock进行实现会进行忙等状态。

