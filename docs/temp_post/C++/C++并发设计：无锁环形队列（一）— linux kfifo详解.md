## 摘要
该文章介绍Linux v6.13-rc5内核的kfifo实现细节，介绍如何使用内存屏障来保证执行顺序，以及如何采用位运算来替换取余运算提高效率。
## 背景知识
+ 缓存一致性 和 MESI协议
+ 内存屏障
## Linux内核的kfifo
具体文件位置：
仓库地址：https://github.com/torvalds/linux/tree/master
版本标签：Tags v6.13-rc5
文件位置：linux/include/linux/kfifo.h  lib/kfifo.c

在看具体实现前，思考下一般实现单生产单消费者无锁环形队列：
+ 初始化：先分配一个固定大小size的缓冲区，初始化读写指针都指向开头，表示为空
+ 写队列操作：队列不为满情况，写指针write向前移动，write = (write + len) % size，当写指针到环形尾部时取余指向开头。
+ 读队列操作跟写队列类似：队列不为空， read = (read + len) % size;
+ 队列为空情形：读写指针相等：read == write
+ 队列为满情形：写指针下一个位置等于读指针：write + len == read
+ 无锁实现：先操作数据，再更新指针值，可以使用内存屏障[^1]来避免乱序执行。

接下来具体分析 __kfifo__ 的实现跟一般情况有什么区别，以及分析为什么如此实现。
__kfifo的数据结构__
```c
//file: include/linuc/kfifo.h
struct __kfifo {
	unsigned int	in; /* 数组写指针 */
	unsigned int	out; /* 数组读指针 */
	unsigned int	mask; /* = size - 1 */
	unsigned int	esize; /* element size 每个元素的大小 */
	void		*data; /* 指向一个元素大小为esize的数组 */
};
```

__kfifo初始化__
```c
//file: lib/kfifo.c
int __kfifo_alloc(struct __kfifo *fifo, unsigned int size,
		size_t esize, gfp_t gfp_mask)
{
	/*
	 * round up to the next power of 2, since our 'let the indices
	 * wrap' technique works only in this case.
	 */
	/*向上2的幂拓展*/
	size = roundup_pow_of_two(size);

	fifo->in = 0;
	fifo->out = 0;
	fifo->esize = esize;

	if (size < 2) {
		//size 至少为2
		fifo->data = NULL;
		fifo->mask = 0;
		return -EINVAL;
	}
	/* 分配一个size个esize大小元素的数据 */
	fifo->data = kmalloc_array(esize, size, gfp_mask);

	if (!fifo->data) {
		//没有可用内存分配
		fifo->mask = 0;
		return -ENOMEM;
	}
	fifo->mask = size - 1;

	return 0;
}
```
kmalloc_array文档[^2]
kfifo要求缓冲区的长度必须为2的幂，这是为了将 kfifo->in % kfifo->size 转化为 kfifo->in & (kfifo->size - 1)，避免计算代价高的求余运算。

__入队操作__
```c
static inline unsigned int kfifo_unused(struct __kfifo *fifo)
{
	return (fifo->mask + 1) - (fifo->in - fifo->out);
}

static void kfifo_copy_in(struct __kfifo *fifo, const void *src,
		unsigned int len, unsigned int off)
{
	unsigned int size = fifo->mask + 1;
	unsigned int esize = fifo->esize;
	unsigned int l;

	off &= fifo->mask;
	if (esize != 1) {
		off *= esize;
		size *= esize;
		len *= esize;
	}
	//先计算缓冲当前位置到尾部有多少空间
	l = min(len, size - off);

	memcpy(fifo->data + off, src, l);
	memcpy(fifo->data, src + l, len - l);
	/*
	 * make sure that the data in the fifo is up to date before
	 * incrementing the fifo->in index counter
	 */
	smp_wmb();
}

unsigned int __kfifo_in(struct __kfifo *fifo,
		const void *buf, unsigned int len)
{
	unsigned int l;

	l = kfifo_unused(fifo);
	if (len > l)
		len = l;

	kfifo_copy_in(fifo, buf, len, fifo->in);
	fifo->in += len;
	return len;
}

```
__kfifo_unused__
这里的kfifo->int和kfifo->out都是无符号整形变量，以下关系总是成立的
$\qquad\qquad$__已用缓冲区长度= 写指针 - 读指针__
即使写指针到了无符号整形的上界，上溢出后写指针小于读指针，上述关系仍然成立，因此可以由此计算剩余空间长度：
$\qquad\qquad$ __剩余空间长度 = 总缓冲区长度 - 已用缓冲区长度__
__kfifo_copy_in__ 
+ 先使用off & (kfifo->size) 计算出可写缓冲区索引位置，再根据每个元素的大小esize计算出要写入的位置 off *= esize
+ 先计算当前位置off到缓冲区尾部剩余空间 __l = min(len, size - off)__ ;
+ 先填充剩余空间 __memcpy(fifo->data + off, src, l)__;
+ 再从缓冲区头部开始填充数据 __memcpy(fifo->data, src + l, len - l)__ 若 len - l == 0则表达尾部缓冲区足够填充所有数据，这里不会进行操作;
+ 为了保证先填充数据，再修改写指针位置的操作顺序，这里使用 __smp_wmd[^3]写
  内存屏障进行保证：写屏障不允许其前后的写操作越过屏障__

____kfifo_in__ 队列入队操作：
+ 获取可用空间，若小于当前加入的大小，则按照当前剩余空间填充数据。
+ 调用 __kfifo_copy_in__ 填充数据
+ 增加写指针的位置，__kfifo_copy_in__ 填充完数据调用smp_wmd确保按照填充数据后再更新写指针顺序操作

__出队操作__
```C
static void kfifo_copy_out(struct __kfifo *fifo, void *dst,
		unsigned int len, unsigned int off)
{
	unsigned int size = fifo->mask + 1;
	unsigned int esize = fifo->esize;
	unsigned int l;

	off &= fifo->mask;
	if (esize != 1) {
		off *= esize;
		size *= esize;
		len *= esize;
	}
	l = min(len, size - off);

	memcpy(dst, fifo->data + off, l);
	memcpy(dst + l, fifo->data, len - l);
	/*
	 * make sure that the data is copied before
	 * incrementing the fifo->out index counter
	 */
	smp_wmb();
}

unsigned int __kfifo_out_peek(struct __kfifo *fifo,
		void *buf, unsigned int len)
{
	unsigned int l;

	l = fifo->in - fifo->out;
	if (len > l)
		len = l;

	kfifo_copy_out(fifo, buf, len, fifo->out);
	return len;
}

unsigned int __kfifo_out(struct __kfifo *fifo,
		void *buf, unsigned int len)
{
	len = __kfifo_out_peek(fifo, buf, len);
	fifo->out += len;
	return len;
}
```
__kfifo_copy_out__
+ 计算在缓冲区要读取的位置 off
+ 判断当前读取位置off到缓冲区尾部是否大于要读取长度，取小的值 __l = min(len, size - off)__，先从缓冲区off位置处读取l长度的数据，再判断是否剩余数据，若剩余数据则从数据缓冲区开始位置读取
$\qquad\qquad$	memcpy(dst, fifo->data + off, l)
$\qquad\qquad$memcpy(dst + l, fifo->data, len - l)
+ 读取完数据执行 __smp_wmb[^3]__ 保证先完成读取数据再更新读指针位置

____kfifo_out_peek__
+ 计算可以读取的长度 __l = fifo->in - fifo->out__
+ 调用 __kfifo_copy_out__ 读取缓冲区的数据

____kfifo_out__
+ 从队列中读取len个元素，若不足则读取所有元素，并返回读取的个数。

## 总结
+ kfifo 读写指针采用无符号整形变量，以及数组长度大小为2的幂，这样的好处：1.把读写指针变换为索引值，只需要按位与，避免求余操作。 2.在求剩余长度时，不需要考虑读写指针边界问题，即使上溢出也能保证关系成立。
+ 采用smp_wmb写内存屏障，来保证执行操作的有序性。

## 引用
[^1]:https://zh.wikipedia.org/wiki/%E5%86%85%E5%AD%98%E5%B1%8F%E9%9A%9C
[^2]:[kmalloc_array](https://www.kernel.org/doc/html/latest/core-api/mm-api.html#c.kmalloc_array)
[^3]:[kernel barriers](https://www.kernel.org/doc/Documentation/memory-barriers.txt)
