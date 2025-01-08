---
title: Redis zset的应用
description: |
    该文章讲解了redis zset的应用场景例子，分别给出排行榜和推荐系统的应用
    实例，并给出完整的实现
date: 2025/01/08
---

# reids zset的应用
  该文章讲解了redis zset的应用场景例子，分别给出排行榜和推荐系统的应用
  实例，并给出完整的实现

## 排行榜

zset会按照score进行排序，对于插入或更新，删除操作都是 $\log_2 N$ 复杂度，同时支持范围查询，很适合排行榜的需求

排行榜在日常生活还是比较常见的需求之一，如粉丝投票，比赛奖牌或积分，游戏中就更加常见各种数值的排行榜。下面以一个比赛奖牌数量为列做一个排行榜设计。

### score状态压缩

比赛中有金牌、银牌、铜牌三种奖牌，排名按照金牌数量，若金牌数量相等按照银牌，前俩者相等就按照铜牌。

redis中的score是double类型，这里假设各个类型的奖牌数量不会超过三位数，那么score可以怎么计算

__score = 金牌 * 1000000 + 银牌 * 1000 + 铜牌__

```python
class MedalBoard:
  def __init__(self, host="localhost", port=6379, db=0):
    """
    初始化Redis连接
    """
    self.r = redis.Redis(host=host, port=port, db=db)
    self.key = "medal_standings"
    self.cache = None

  def CalScore(self, gold:int, silver:int, bronze:int) -> int:
      """
      将奖牌数量转化成排序分数
      """
      return gold * 1000000 + silver * 1000 + bronze
  
  def GetMedalByScore(self, score:float) -> tuple[int, int, int]:
      """
      将排序分数转化为奖牌数量
      """
      gold = int(score // 1000000)
      silver = int((score % 1000000) // 1000)
      bronze = int(score % 1000)
      return gold, silver, bronze
```

### 本地缓存

对于并发量大的场景下，每次查询排行榜直接从redis进行查询，对于redis有性能影响，因此需要考虑多级缓存，减少对redis的查询压力，在本地增加排行榜数据进行缓存。排行榜对象增加cache列表缓存排行榜内容，将score重新转化成奖牌数量

```python
class BoardEle:
  def __init__(self, country:str, gold:int, silver:int, bronze:int):
    self.country = country
    self.gold = gold
    self.silver = silver
    self.bronze = bronze

def ReloadMedalBoardCache(self):
  """
  重新从redis中加载排行榜数据到本地缓存
  """
  self.cache = []
  standings = self.r.zrevrange(self.key, 0, -1, withscores=True)
  for i, (country, score) in enumerate(standings, 1):
    gold, silver, bronze = self.GetMedalByScore(score)
    self.cache.append(BoardEle(country, gold, silver, bronze))
```

### 更新奖牌的数量

```python
def UpdateMedal(self, country: str, gold=0, silver=0, bronze=0):
  """
  更新国家的奖牌数量
  """
  # 获取当前的分数
  current_score = self.r.zscore(self.key, country)
  if current_score is None:
    current_score = 0
  else:
    current_score = int(current_score)

  # 计算新的分数
  new_score = current_score + self.CalScore(gold, silver, bronze)
  result = self.r.zadd(self.key, {country: new_score})
  if result >= 0:
    # 更新成功同时更新缓存
    self.ReloadMedalBoardCache()
```
::: tip
增加了本地缓存后，那么需要考虑本地缓存和redis一致性问题, 这里考虑到现实奖牌更新频率很小，因此
采用同步更新的方式，还有其他方式可以查阅相关资料进行学习。
:::
### 查询排行榜

查询直接从本地缓存返回即可

```python
def GetMedalBoard(self) -> list[BoardEle]:
  for i, ele in enumerate(self.cache):
    print(f"{i}. {ele.country.decode("utf-8")}: Gold={ele.gold}, Silver={ele.silver}, Bronze={ele.bronze}")
```

### 查询特定成员信息

使用zscore指令进行查询，得益于redis zset结构中使用dict存储member:score的映射，因此该查询的复杂为O(1)

```python
def GetMedalByCountry(self, country:str) -> tuple[int, int,int]:
  score = self.r.zscore(self.key, country)
  print("score ", score)
  if score:
    return self.GetMedalByScore(score)
  else:
    return None
```

### 查询特定排名的成员信息

查询复杂度为(log(N))

```python
def GetTop(self, rank:int) -> tuple[str, int]:
  members = self.r.zrevrange(self.key, 1, 1, withscores=True)
  if members:
    return members[0]
  else:
    return "", -1
```

## 推荐系统[^1]

在社交平台上或市场中，每个讨论的话题，新闻，或者商品都会贴上一些标签，实时情绪推荐系统会根据浏览者实时情绪来关联话题、新闻、商品等进行推荐。以下推荐系统的示例来自于[Redis Sorted Sets — Building Real-time Mood-Based Recommendation System | by Mohammad Hoseini Rad | Medium](https://medium.com/@mhrlife/redis-sorted-sets-building-real-time-mood-based-recommendation-system-0face55b4a32)

### 产品归类

在这里以一个市场为例子，将市场上的商品贴上标签进行归类，一件商品可以有多个标签，例如智能手机，可以“科技”，“工具”等标签，智能手机在“科技”，“工具”标签中更偏向于数码，因此增加一个标签权重来描述相关性，如将权重的范围设置为[0, 10]。假设智能手机在“科技”标签权重为10， “工具”便签权重为8。可以用redis中zset数据结构来进行设计。标签作为zset的key，将权重作为zset的score，“智能手机”采用编号方式将对应id作为zset的member。一开始将所有的产品进行归类划分好。

```python
import redis

class RecommendSystem:
  def __init__(self, host="localhost", port=6379, db=0):
      """
      初始化Redis连接
      """
      self.r = redis.Redis(host=host, port=port, db=db)
  
  def AddProduct(self, product_id:int, category_weight:dict):
      """
      将产品根据标签权重进行分类
      """
      for category, weight in category_weight.items():
        self.r.zadd(category, {product_id: weight})
if __name__ == "__main__":
  recommend_sys = RecommendSystem()
  # id=0 [Smartphone]
  recommend_sys.AddProduct(0, {"tag:tech": 10, "tag:gadgets": 8})
  # id=1 [Laptop]
  recommend_sys.AddProduct(1, {"tag:tech": 9, "tag:computing": 7})
  # id=2 [Smartwatch]
  recommend_sys.AddProduct(2, {"tag:tech": 7, "tag:gadgets": 9})
  # id=3 [Gaming Console]
  recommend_sys.AddProduct(3, {"tag:gaming": 10, "tag:tech": 6})
  # id=4 [Tablet]
  recommend_sys.AddProduct(4, {"tag:tech": 8, "tag:gadgets": 7})
  # id=5 [Smart Home Device]
  recommend_sys.AddProduct(5, {"tag:tech": 6, "tag:gadgets": 8, "tag:home": 9})
```

### 情绪计算和推荐产品

情绪计算的算法有很多方式，可以由用户的历史浏览记录偏好，或者当前查询记录，点击操作信息等。文章主要关注redis zset在推荐系统中的使用，因此在这里跳过情绪计算分析环节，假设当前用户对“科技”，“工具”感兴趣，且权重分别为10， 5。那么可以根据这个信息对“科技”和“工具”标签中的产品进行权重计算，然后返回推荐结果

```python
def RecommendProduct(self, mood_weight:dict):
  """
  根据当前兴趣权重推荐
  """
  print(self.r.zunion(mood_weight, "sum", True))
if __name__ == "__main__":
  recommend_sys = RecommendSystem()
  #...添加产品
  recommend_sys.RecommendProduct({"tag:tech": 10, "tag:gadgets": 5})
```

上面python代码转化为redis指令为：redis> __zunion 2 tag:tech tag:gadgets WEIGHTS 10 5 AGGREGATE sum withscores__

+ zunion 2 tag:tech tag:gadgets 合并俩个有序集合
+ WEIGHTS 10 5: 指定俩个集合的对应权重，这里redis的处理是，对tag:tech中的score*10，对tag:gadgets中的score\*5
+ AGGREGATE sum：对于都出现在俩个集合里的元素的处理，这里sum是对俩个元素的score值（被上面权重处理完）进行相加。在这里标签重合度越高越优先推荐。

+ withscores：将对应元素的score也获取到结果上。

 __zunion 2 tag:tech tag:gadgets WEIGHTS 10 5 AGGREGATE sum withscores__ 获取的结果如下

```
 1) "3" (Gaming Console)
 2) "60" (权重分数)
 3) "1"	(Laptop)
 4) "90"
 5) "5" (Smart Home Device)
 6) "100"
 7) "2"	(Smartwatch)
 8) "115"
 9) "4"	(Tablet)
10) "115"
11) "0"	(Smartphone)
12) "140"
```

score分数越高越符合用户当前的兴趣喜好。

### 推荐查询时间复杂度

产品归类这些添加到zset中时间复杂度为 log(N)，查询zunion的时间复杂度为 O(N) + O(M*log(M))，这里的N是输入有序集合总的元素个数（多个集合元素相加），M是输出结果的元素个数[^2]。

## 总结

+ redis zset是一个有序集合，使用double类型作为score进行排序，可以将一种类型数值作为score，对其进行排序，也可以同时对多个数值进行关联排序，将多个数值压缩到一个double类型上例如上面奖牌的例子。且提供了范围查询，这对于排行榜设计，或者查询TopN都是比较合适的数据结构。
+ 当将redis zset中的score作为权重概念，那么可以将产品根据标签和权重进行分类，然后再根据偏好，设计出一个推荐系统。

## 完整代码链接
  + https://github.com/cyy-tag/redis-example/tree/main/src/zset
## 引用

[^1]:[Redis Sorted Sets — Building Real-time Mood-Based Recommendation System | by Mohammad Hoseini Rad | Medium](https://medium.com/@mhrlife/redis-sorted-sets-building-real-time-mood-based-recommendation-system-0face55b4a32)
[^2]:[ZUNION | Docs](https://redis.io/docs/latest/commands/zunion/)
