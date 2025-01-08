## 摘要
该文章主要讲解了C++11 atomic库中的六种内存模型，以及设计。

# C++并发设计：背景基础知识-C++内存模型（atomic）
## 六种内存序
+ memory_order_relaxed
  不提供任何同步或顺序保证
+ memory_order_release
  确保之前的读取和写入不会被重排到当前操作之后，并且写入操作可以被之后其他线程
  之前acquire语义所看到
+ memory_order_acquire
  确保后续的读取和写入操作不会被重排到当前操作之前，且之前使用release语义操作的写入
  都是可以看到的
+ memory_order_acq_rel
  结合了memory_order_acquire和memory_order_release的特性，对之前和之后的读取和写入
  都提供顺序保证。
+ memory_order_seq_cst

## atomic 类型的设计




