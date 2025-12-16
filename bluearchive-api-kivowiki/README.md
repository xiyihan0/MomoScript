# api.kivo.wiki 使用方法(非官方)
***在箭头指向内的参数任选其一***

## 验证脚本（全异步）
校验所有学生 `id` 的详情接口是否可访问：

`python bluearchive-api-kivowiki/validate_all_students.py --concurrency 25 --out bluearchive-api-kivowiki/validate_report.json`

只跑前 N 个：

`python bluearchive-api-kivowiki/validate_all_students.py --limit 100 --concurrency 25 --out bluearchive-api-kivowiki/validate_report_100.json`

## 下载脚本：学生初始立绘差分（全异步）
提取每个学生详情里的 `gallery` 中 `title == "初始立绘差分"` 的全部图片链接，并下载到：

`images/students/{data.id}/{filename}`

运行：

`python bluearchive-api-kivowiki/download_student_gallery_images.py --gallery-title \"初始立绘差分\" --out-root images --detail-concurrency 15 --download-concurrency 25 --report bluearchive-api-kivowiki/download_report.json`

只试跑一小部分：

`python bluearchive-api-kivowiki/download_student_gallery_images.py --limit-students 5 --max-per-student 2 --report bluearchive-api-kivowiki/download_report_sample.json`

## 批量打标（LLM）
使用 OpenAI 兼容 API（例如 `https://gcli.ggchan.dev/v1`）对 `images/students/{id}` 下的图片按文件名顺序分批（默认 8 张）打标，并在每个学生文件夹输出 `tags.json`。也可以通过环境变量 `OPENAI_BASE_URL`（或 `GCLI_BASE_URL`）设置默认端点。

先设置环境变量（不要把密钥写进代码/提交到仓库）：

`$env:GCLI_API_KEY="你的密钥"`

也可以放到项目根目录的 `.env`（脚本会自动读取）：

`GCLI_API_KEY=你的密钥`

运行（模型名按需调整）：

`python batch_tag_students.py --model gemini-3-pro-preview-maxthinking --base-url https://gcli.ggchan.dev/v1 --resume`（或设置 `OPENAI_BASE_URL` 后省略 `--base-url`）
###  1.获取角色列表
### GET
#### 基础URL:
```https://api.kivo.wiki/api/v1/data/students```


|查询参数|参数值/参数类型|必填|描述|
|----|----|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示角色的数量|
|`character_data_search`|string|×|学生姓名模糊搜索|
|↓↓↓
|`name_sort`|`asc`升序<br>`desc`降序|×|按姓名排序|
|`id_sort`|`asc`升序<br>`desc`降序|×|按上传顺序排序|
|`height_sort`|`asc`升序<br>`desc`降序|×|按身高排序|
|`birthday_sort`|`asc`升序<br>`desc`降序|×|按生日排序|
|`release_date_sort`|`asc`升序<br>`desc`降序|×|按日服发布日期排序|
|`release_date_global_sort`|`asc`升序<br>`desc`降序|×|按国际服发布日期排序|
|`release_date_cn_sort`|`asc`升序<br>`desc`降序|×|按国服发布日期排序|
|↑↑↑|
|`battlefield_position`|`STRIKER`前排<br>`SPECIAL`后排|×|按部队类型筛选
|`attack_attribute`|`Explosive`爆炸<br>`Piercing`贯穿<br>`Mystic`神秘<br>`Vibration`震动|×|按攻击类型筛选|
|`type`|`Tank`坦克<br>`Dealer`输出<br>`Healer`治疗<br>`Support`辅助<br>`T.S.`载具支援|×|按职能定位筛选|
|`school`|int|×|筛选指定学校的学生，参数值为学校ID
|`is_npc`|bool|×|筛选是否为NPC的角色|
|`is_install`|bool|×|筛选日服是否实装的角色|
|`is_install_global`|bool|×|筛选国际服是否实装的角色|
|`is_install_cn`|bool|×|筛选国服是否实装的角色|
|`is_group_control`|bool|×|筛选是否具有群控能力的角色|
|`is_skin`|bool|×|筛选是否换装的角色(是否原皮)|
|`special_apperance`|bool|×|筛选是否特殊装扮的角色(?)|
|`rarity`|int(1~3)|×|筛选不同稀有度的学生|
|`limited`|bool|×|筛选是否来自限定池的学生|
|`defensive_attributes`|`Light`轻装甲<br>`Heavy`重装甲<br>`Special`特殊装甲<br>`Elastic`弹性装甲|×|按防御属性筛选
|`team_position`|`FRONT`前排<br>`MIDDLE`中排<br>`BACK`后排|×|按站位筛选|
|`weapon_type`|`SG`霰弹枪<br>`SMG`冲锋枪<br>`AR`突击步枪<br>`GL`榴弹发射器<br>`HG`手枪<br>`RL`导弹发射器<br>`SR`狙击枪<br>`RG`轨道炮<br>`MG`重机枪<br>`MT`迫击炮<br>`FT`喷火器|×|按武器类型筛选|
|`eqipment`|`2`护符<br>`3`手表<br>`4`项链<br>`5`徽章<br>`6`发夹<br>`7`帽子<br>`8`手套<br>`9`鞋子<br>`10`背包|×|按装备类型筛选|
|`birthday`|int-int(MM-DD)|×|按生日筛选|
|`body_shape`|`Shape`娇小<br>`Medium`普通<br>`Large`高挑|×|按身材筛选
|`designer`|`7peach` `9ml` `CHILD` `Crab D` `DoReMi`<br>`dydldidl` `Doremsan2j` `Empew` `eno` `Fame`<br>`GULIM` `Hwansang` `kokosando` `koo3473` `mery`<br>`MISOM150` `mona` `Mx2J` `NAMYO` `nemoga`<br>`ni02` `nino` `OSUK2` `Owa` `Paruru`<br>`RONOPU` `seicoh` `tokki` `tonito` `Vinoker`<br>`whoisshe` `YutokaMizu` `あやみ` `イコモチ` `カンザリン`<br>`キキ` `にぎりうさぎ` `ヌードル` `はねこと` `ビョルチ`<br>`ぶくろて` `ポップキュン` `まきあっと` `ミミトケ` `ミモザ`<br>`やまかわ` `春夏冬ゆう` `二色こぺ` `桧野ひなこ`<br>`日下雲` `三脚たこ`|×|按角色设计师筛选|
|`illustrator`|`7peach` `9ml` `CHILD` `Crab D` `DoReMi`<br>`dydldidl` `Doremsan2j` `Empew` `eno` `Fame`<br>`GULIM` `Hwansang` `kokosando` `koo3473` `mery`<br>`MISOM150` `mona` `Mx2J` `NAMYO` `nemoga`<br>`ni02` `nino` `OSUK2` `Owa` `Paruru`<br>`RONOPU` `seicoh` `tokki` `tonito` `Vinoker`<br>`whoisshe` `YutokaMizu` `あやみ` `イコモチ` `カンザリン`<br>`キキ` `にぎりうさぎ` `ヌードル` `はねこと` `ビョルチ`<br>`ぶくろて` `ポップキュン` `まきあっと` `ミミトケ` `ミモザ`<br>`やまかわ` `春夏冬ゆう` `二色こぺ` `桧野ひなこ`<br>`日下雲` `三脚たこ`|×|按角色原画师筛选|
|`outdoor_adaptability`|`D` `C` `B` `A` `S` `SS`|×|按角色野外适应性筛选|
|`indoor_adaptability`|`D` `C` `B` `A` `S` `SS`|×|按角色室内适应性筛选|
|`street_adaptability`|`D` `C` `B` `A` `S` `SS`|×|按角色街区适应性筛选|



---
### 2.获取角色信息
```https://api.kivo.wiki/api/v1/data/students/[学生ID]```

---

### 3.获取学校列表
### GET
#### 基础URL
```https://api.kivo.wiki/api/v1/data/schools```
|查询参数|参数值/参数类型|必填|描述|
|----|----|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示学校的数量|
|`name`|String|×|学校名称模糊搜索|

### 4.获取学校信息
```https://api.kivo.wiki/api/v1/data/schools/[学校ID]```

---

### 5.获取社团(?)列表
*这东西是用来表示学生关系的，说是社团可能也对？*
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/data/relations`
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示社团的数量|
|`name`|String|×|社团名称模糊搜索|

---

### 6.获取社团(?)信息
`https://api.kivo.wiki/api/v1/data/relations/[社团ID]`

---

### 7.获取物品列表
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/data/items`

|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示物品的数量|
|`type`|`gift`礼物<br>`furniture`家具|×|筛选礼物或家具|
|`is_bind_article`|bool|×|是否筛选词条|
|`id_sort`|`asc`升序<br>`desc`降序|×|按新旧排序|


*礼物，家具，词条都是分类，`type`和`is_bind_article`这俩应该可以同时使用*

---

### 8.获取物品信息
`https://api.kivo.wiki/api/v1/data/items/[物品ID]`


---

### 9.获取报刊亭列表
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/articles`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示文章的数量|
|`summary_size`|int|√|内容摘要的长度
|`title`|String|×|模糊搜索文章标题|

---

### 10.获取报刊亭文章
`https://api.kivo.wiki/api/v1/articles/[文章ID]`

---

### 11.获取漫画屋列表
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/comics`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示漫画的数量|
|`title`|String|×|模糊搜索文章标题|

---

### 12.获取漫画屋漫画信息
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/comics/[漫画ID]`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`chapter_sort`|`asc`升序<br>`desc`降序|×|漫画章节排序|

----

### 13.获取漫画屋漫画内容
`https://api.kivo.wiki/api/v1/comics/[漫画ID]/chapters/[章节ID]`


---

### 14.获取画廊列表
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/galleries`   
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示图集的数量|
|`title`|String|×|模糊搜索图集标题|

---

### 15.获取画廊内的图片
`https://api.kivo.wiki/api/v1/galleries/[图集ID]`

---

### 16.获取音乐列表
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/musics`   
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示图集的数量|
|`s`|String|×|模糊搜索音乐标题|
|`id_sort`|`asc`升序<br>`desc`降序|×|按新旧排序|

---

### 17.获取音乐详细信息
`https://api.kivo.wiki/api/v1/musics/[音乐ID]`


---

### 18.获取Kivo史书列表
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/timeline`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示事件的数量|
|`type`|`MainStory`主线故事<br>`OtherStory`其他剧情<br>`Event`活动<br>`Gacha`卡池<br>`Double`掉落加倍<br>`MiniBattle`小型战役<br>`Raid`总力战<br>`BigRaid`大决战<br>`AlliedOperation`联合作战<br>`ContentImprovements`内容改进<br>`Maintenance`维护<br>`Live`直播<br>`WebEvent`网页活动<br>`OutsideGame`游戏外<br>`Other`其他|×|按类型筛选(可多个)|
|`start_time_start`|int|×|筛选事件开始事件(时间戳)|
|`start_time_end`|int|×|筛选事件结束时间(时间戳)|
|`start_time_sort`|`asc`升序<br>`desc`降序|×|是否按事件排序|
|`title`|String|×|模糊搜索事件标题|

---

### 19.获取事件信息
`https://api.kivo.wiki/api/v1/timeline/[事件ID]`

---

### 20.获取配对方案列表
以后再写

---

### 21.获取详细配对信息
以后再写

---

### 22.获取卡池信息
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/data/pick_up`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`server`|`cn`国服<br>`jp`日服|√|游戏版本|

---

### 22.获取总力战/大决战信息
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/data/raid/now`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`server`|`cn`国服<br>`jp`日服|√|游戏版本|

---

### 23.获取本周生日的学生
`https://api.kivo.wiki/api/v1/data/students/birthday/week`

---

### 22.获取活动信息
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/data/event/now`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`server`|`cn`国服<br>`jp`日服|√|游戏版本|

---

### 23.获取公告列表
### GET
#### 基础URL
`https://api.kivo.wiki/api/v1/bulletins`
|查询参数|参数值/参数类型|必填|描述|
|---|---|---|---|
|`page`|int|√|当前请求的页数(从1开始)|
|`page_size`|int|√|当前页数显示公告的数量|

---

### 24.获取公告内容
`https://api.kivo.wiki/api/v1/bulletins/[公告ID]`

---

### 25.kivo统计
`https://api.kivo.wiki/api/v1/statistics/index`
