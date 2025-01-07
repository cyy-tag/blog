## Redis底层Dict实现

## 摘要

该文章主要描述了Redis中最为基础的数据结构Dict的底层实现细节。在Redis中，Dict被广泛用于各种功能中，主要用于存储键值对，以实现快速的数据访问和操作。

## 用途

+ 哈希类型： Redis的哈希类型（Hash)底层实现基于Dict
+ 发布/订阅模式：Dict用于存储频道和订阅者的关系
+ 过期键值管理：用于存储带有过期时间的键
+ 有序集合中(ZSet)：用于对成员和分数的映射，以及对ZSet对成员进行去重。
+ 集合（Set)：当集合以哈希表形式实现时，应用于集合中对成员查找

## 代码位置

redis版本：redis 8.0

文件位置：头文件redis/src/dict.h 源文件redis/src/dict.c

## Dict 实现

### Dict结构体定义

```c
//file: redis/src/dict.h
struct dict {
    dictType *type;

    dictEntry **ht_table[2];
    unsigned long ht_used[2];

    long rehashidx; /* rehashing not in progress if rehashidx == -1 */

    /* Keep small vars at end for optimal (minimal) struct padding */
    unsigned pauserehash : 15; /* If >0 rehashing is paused */

    unsigned useStoredKeyApi : 1; /* See comment of storedHashFunction above */
    signed char ht_size_exp[2]; /* exponent of size. (size = 1<<exp) */
    int16_t pauseAutoResize;  /* If >0 automatic resizing is disallowed (<0 indicates coding error) */
    void *metadata[];
};
```

+ dictType *type 定义当前字典属性，以及hook函数（哈希函数，销毁值函数，rehash完成回调函数等）
+ dictEntry **ht_table[2]，俩个dictEntry数组（哈希表），一般情况只有ht_table[0]指向一个dictEntry数组，存放键值对dictEntry，只有在ReHash的过程，ht_table[1]指向新的dictEntry（键值对）数组，新加的键值对直接加入到ht_table[1]中，直到ReHash完成，释放ht_table[0]，并将ht_table[1]赋值给ht_table[0]，ReHash下文会详细描述。
+ unsigned long ht_used[2];对应ht_table[2]中每个哈希表中插入的键值对数量
+ long rehashidx;当值为-1，表示没有正在ReHash过程，当值大于等于0时，表示当前正在ReHash过程中，且rehashidx表示旧 的哈希表 ht_table[0]当前遍历的下标。
+ unsigned pauserehash: 15；大于0时，暂停ReHash
+ unsigned useStoredKeyApi : 1;  值为1时使用type定义的hash，0时使用默认的哈希函数，默认为0
+ signed char ht_size_exp[2]; 哈希表大小2的指数位（如 ht_table[0]大小= 1  << ht_size_exp[0])
+ int16_t pauseAutoResize; 大于0时不允许哈希表调整大小，小于0时 表示存在错误
+ void *metadata[]; 一个可变长的数组，根据需要存储额外的信息，而不必修改字典的基本结构。

### Dict内存布局

<img src="F:\博客文章\redis_dict内存布局.drawio.svg">

redis中h_table[0]是一个dictEntry(键值对)指针数组，为什么不设计成图2为一个dictEntry的索引位置，指向dictEntry数组的位置，从内存布局上看，图2 dictEntry数组相比较redis指针数组有更优内存连续性，在遍历所有元素的时候直接遍历dictEntry数组。笔者认为redis怎么设计的原因是为兼容复杂的使用场景，如redis Dict设置了no_value属性时，Dict可以当作集合类型，又或是value优化存储在key中的情况。单单使用图2的形式已经不能满足上述的要求。

### DictEntry 结构体（键值对）定义

```c
struct dictEntry {
    void *key;
    union {
        void *val;
        uint64_t u64;
        int64_t s64;
        double d;
    } v;
    struct dictEntry *next;     /* Next entry in the same hash bucket. */
};
```

+ key 指向key（字符串）
+ v，union类型，内置类型直接存储，其他复杂类型 val 指针指向
+ struct dictEntry *next; 哈希冲突时使用链地址法，next指向下一个同hash的键值对。

###　渐进式Rehashing

+ Rehashing的原因：当字典中的键值对数量增加多，哈希冲突概率变高影响哈希表性能，而当键值对数量减少而哈希表过大，影响遍历的性能，对此redis需要在适当的时候对哈希表进行扩容和缩容。

+ 渐进式Rehashing：

  + redis在对哈希表进行扩容和缩容的时候，先将新分配的哈希表赋值给has_table[1]，并设置rehashidx为0

    ```c
    //file: redis/src/dict.c
    int _dictResize(dict *d, unsigned long size, int* malloc_failed)
    {
        //....分配新的哈希表
        d->ht_size_exp[1] = new_ht_size_exp;
        d->ht_used[1] = new_ht_used;
        d->ht_table[1] = new_ht_table;
        d->rehashidx = 0;
        //...
    }
    ```

  + 每次执行执行查询，删除操作时，如果当前键值对还没有rehash操作，那么优先进行rehash操作，这样的选择对CPU Cache局部性更优化，先rehash，后续访问大概率在CPU cache。如果当前键值对已经rehash了，那么只对下一个旧键值对进行rehash

    ```c
    //file: redis/src/dict.c
    static void _dictRehashStepIfNeeded(dict *d, uint64_t visitedIdx) {
        if ((!dictIsRehashing(d)) || (d->pauserehash != 0))
            return;
        /* rehashing not in progress if rehashidx == -1 */
        if ((long)visitedIdx >= d->rehashidx && d->ht_table[0][visitedIdx]) {
            /* If we have a valid hash entry at `idx` in ht0, we perform
             * rehash on the bucket at `idx` (being more CPU cache friendly) */
            _dictBucketRehash(d, visitedIdx); //指定当前访问先rehash
        } else {
            /* If the hash entry is not in ht0, we rehash the buckets based
             * on the rehashidx (not CPU cache friendly). */
            dictRehash(d,1); //rehash 一个旧键值对，或者遍历10个空指针。
        }
    }
    ```

  + 当全部旧键值对都rehash结束时，释放旧的哈希表ht_table[0]，将新表ht_table[1]赋值给ht_table[0]，并设置rehashidx = -1表示rehash过程结束

    ```C
    //file: redis/src/dict.c
    /* This checks if we already rehashed the whole table and if more rehashing is required */
    static int dictCheckRehashingCompleted(dict *d) {
        if (d->ht_used[0] != 0) return 0;
        
        if (d->type->rehashingCompleted) d->type->rehashingCompleted(d);
        zfree(d->ht_table[0]);
        /* Copy the new ht onto the old one */
        d->ht_table[0] = d->ht_table[1];
        d->ht_used[0] = d->ht_used[1];
        d->ht_size_exp[0] = d->ht_size_exp[1];
        _dictReset(d, 1);
        d->rehashidx = -1;
        return 1;
    }
    ```

    

