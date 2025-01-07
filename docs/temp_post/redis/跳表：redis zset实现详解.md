## 跳表：redis zset实现详解

## 摘要

该篇文章主要描述了跳表的实际应用例子：redis zset的功能的实现，对于跳表的理论和实现可以观看上一篇文章，该篇文章不再讲解原理内容，主要关注于redis zset的结构以及操作实现。

## 代码位置

redis版本：redis 8.0

文件位置：头文件redis/src/server.h 源文件redis/src/t_zset.c

## 结构体定义

```c
//file: redis/src/server.h
/* ZSETs use a specialized version of Skiplists */
typedef struct zskiplistNode {
    sds ele;
    double score;
    struct zskiplistNode *backward;
    struct zskiplistLevel {
        struct zskiplistNode *forward;
        unsigned long span;
    } level[];
} zskiplistNode;

typedef struct zskiplist {
    struct zskiplistNode *header, *tail;
    unsigned long length;
    int level;
} zskiplist;

typedef struct zset {
    dict *dict;
    zskiplist *zsl;
} zset;
```

+ struct zskiplistNode是跳表中的节点信息
  + sds ele，字符串指针，指向zset成员的字符串，sds(Simple Dynamic String，简单动态字符串)由sdslib进行管理（代码文件在 src/sds.c)。
  + double score，用来对跳表排序的分数信息
  + struct zskiplistNode *backward; 指向上一个节点，实现一个双向链表，提供尾部遍历
  + struct zskiplistLevel 跳表中的层级数组，这里除了指向下一个节点forward指针外，增加span字段记录了从当前节点到该层下一个节点之间包含的节点数。用于快速计算跳表的位置，提供范围查询
+ struct zskiplist 跳表结构信息
  + struct zskiplistNode *header, *tail; 跳表的头指针和尾指针
  + unsigned long length; 跳表长度，总共有多个节点，初始为0
  + level当前跳表的层级，初始为1
+ struct zset zset的结构信息
  + dict 字典指针，存放成员名称和分数{ele: score}，用来优化成员查找分数的查询
  + zskiplist *zsl；跳表结构指针

