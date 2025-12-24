# api.kivo.wiki 使用方法(非官方)
***在箭头指向内的参数任选其一***

## MMT 文本对话 DSL（纯文本简版）
用于把“旁白 + 聊天气泡”的内容写成易手写、易脚本解析的纯文本格式（暂不含图片/表情）。

### 头部指令（`@key: value`）
只在文件开头解析（遇到第一条语句行后不再识别），用于填写元信息与 Typst 全局代码：

- `@title: ...` / `@author: ...` / `@created_at: ...`（任意 key 都会写进输出 JSON 的 `meta`）
- `@width: 300pt|120mm|12cm|30em|8.5in`（可选：页面宽度，影响最终导出图片/ PDF 的版面）
- `@bubble_inset: 7pt|3mm|0.8em`（可选：气泡内边距，越大气泡越“胖”）
- `@typst_global: ...`（单行）或 `@typst_global: """ ... """`（多行块）
- `@typst: on|off`（仅作为元信息写入 `meta.typst`，解析模式仍以命令行 `--typst` 为准）
- `@asset.<name>: https://...`（可选：声明一个外链图片资源，resolve 后可在 Typst 模式中用 `#asset_img("<name>")` 复用）

注：文档中的 `...` 仅表示“任意内容占位”，不是语法的一部分；实际写法是 `@key: value`。

### 分页（`@pagebreak`）
可出现在正文任意位置（单独一行）：插入一个分页点，Typst 渲染时会从新的一页开始。

### 动态别名（`@alias`）
`@alias` 可以出现在文件任意位置，用来修改**显示名**，但不改变用于查找学生 `id` 的名字：

- 语法：`@alias 角色名=显示名`
- 显示名会写入该角色后续气泡的 `yuzutalk.nameOverride`（包括显式指定、`_:` / `~n:` 回溯、以及省略说话人），用于渲染时显示
- 注意：显式写 `> 晴(露营): ...` 这类“皮肤括号名”只用于选中对应角色 `id`，不会自动变成显示名；需要显示皮肤名请用 `@alias 晴(露营)=晴(露营)`
- 可用 `@alias 角色名=` 清空该角色的显示名覆盖

注意：`@alias` 按“解析出的角色 id”生效；如果你显式写了另一个皮肤名（例如 `星野(临战)`）并解析成了另一个学生 id，那么它是另一个角色，需要单独 `@alias`。

### 临时别名（`@tmpalias`）
`@tmpalias` 用于做“局部作用域”的显示名覆盖：

- 语法：`@tmpalias 角色名=显示名`（清空：`@tmpalias 角色名=`）
- 会在**该方向（`>` 或 `<`）**下一次出现该角色的第一条对话开始生效（显式或隐式均可）
- 生效期间，后续同方向的该角色气泡都会使用该显示名（包括显式、`_:` / `~n:`、省略说话人）
- 一旦该方向切换到别的说话人（显式或隐式），临时别名作用域结束并回退到 `@alias`（或无覆盖）

### 别名 ID（`@aliasid` / `@unaliasid`）
用于给“说话人标记”添加一个短 id（便于打字），并映射到真实角色名：

- `@aliasid <id> <角色名>`：把 `<id>` 映射到 `<角色名>`（可重复定义以覆盖旧映射）
- `@unaliasid <id>`：撤销一个已存在的 `<id>` 映射（必须存在，且 `<id>` 不能是原本就能解析的角色名）

### 自定义人物 ID（`@charid` / `@uncharid`）
当你希望用一个稳定的短 id 表示“非学生库角色”（避免被 `custom-<hash>` 哈希化）时使用。

- `@charid <id> <显示名>`：声明一个自定义人物 id（例如 `@charid yz 柚子`）
- `@uncharid <id>`：撤销一个已声明的自定义人物 id

之后正文可直接用该 `<id>` 作为说话人：`> yz: 你好` / `< yz: 你好`，渲染时会显示为对应的“显示名”。

### 自定义头像（`@avatarid` / `@unavatarid`）
在你已经用 `@asset.<name>` 声明了图片资源的前提下，可以把它绑定为某个自定义人物（`@charid`）的头像。

- `@avatarid <id> <asset_name>`：把自定义人物 `<id>` 的头像设置为 `@asset.<asset_name>`
- `@unavatarid <id>`：撤销该头像绑定
 - 也可以直接复用学生库头像：`@avatarid <id> <学生名>` 或 `@avatarid <id> kivo-288`（等价于 `avatar/288.png`）

示例：
```text
@charid yz 柚子
@asset.yz_ava: https://.../avatar.png
@avatarid yz yz_ava
> yz: 你好！
```

### 标准库角色换头像（`@avatar`）
给学生库（kivo）角色临时换头像（仅对本次文本生效），依赖 `@asset`：

- `@avatar <角色名>=<asset_name>`：把该角色头像改为 `@asset.<asset_name>`
- `@avatar <角色名>=`：清空头像覆盖
 - 作用域：从该指令出现之后开始，对后续该角色气泡生效；直到再次 `@avatar` 修改或清空为止
 - 也可以复用另一个学生的标准头像：`@avatar 角色A=角色B` 或 `@avatar 角色A=kivo-288`

示例：
```text
@asset.hoshino_ava: https://.../hoshino.png
@avatar 星野=hoshino_ava
> 星野: 早上好
```
- 解析时若遇到 `> <id>:` / `< <id>:`，会按映射替换成对应角色名；因此同一个角色的多个 id 不会导致头像/名称刷新

示例：
```text
> 星野: 你好！
@alias 星野=星野(一年级)
> 1!
@alias 星野=星野(临战)
> 2!
> 星野(临战): 这才是我!
```

### 图片占位（可选）
若素材缺失，可用 `"[图片]"` 作为占位：解析器会把它转成一个待 resolve 的表达式，并用“全局前后 N 句”生成 query（`--ctx-n`，默认 2），用于后续 reranker 推断该角色应使用的反应表情。

### Typst 模式（可选）
解析器支持 `--typst`：所有文本内容（包括旁白、多行块、无表情标记的普通文本）都会按 Typst markup 通过 `eval(..., mode: "markup")` 渲染；表情/图片标记只识别 `[:...]`（避免与 Typst 的 `[...]` 内容块冲突）。

注意：
- Typst 模式下，会保留语句内的空行（作为段落分隔）；非 Typst 模式下空行默认会被忽略（兼容旧行为）。
- Typst markup 里 `[` / `]` 等字符有语法含义，纯文本需要用 `\\[` / `\\]` 等方式转义。
- `eval` 的作用域不会跨气泡/旁白持久化；若要“全局可用”的定义，请写在文件头部的 `@typst_global`，或把 `#let ...` 和使用放在同一个气泡/旁白（例如三引号多行块里）。
- 外链图片：可以写 `[:https://...]`，resolve 阶段会把它下载到缓存目录并作为图片渲染（避免 Typst 直接访问网络）。

### 语句行
忽略行首空白后，满足以下前缀之一的行称为“语句行”：

- `- `：旁白（居中/系统文本）
- `> `：对方气泡
- `< `：自己（Sensei）气泡

### 续行
不以 `- ` / `> ` / `< ` 开头的行，视为上一条语句的“续行”，追加到上一条内容末尾（推荐用 `\n` 连接）。

文件开头若出现续行（前面没有任何语句行）应报错。

### 多行块（`"""..."""`）
对于需要在同一个气泡/旁白里写多行原文（例如公式/列表/代码），支持三引号块：

- 在 `- ` / `> ` / `< ` 的内容部分以 `"""` 开头时，进入多行块模式
- 直到遇到**单独一行**的 `"""` 才结束
- 块内内容原样保留，不再识别 `-` / `>` / `<` 前缀，也不作为续行规则处理
- 目前块内不会做表情/图片占位解析（当纯文本）

示例：
```text
> 优香: """计算下面的表达式:
- 37*21
- $(partial (x^2+y^2))/(partial x)-(partial (x^2+y^2))/(partial x)$
"""
```

### 说话人标记（`>` / `<`）
`>` 与 `<` 的内容可以选择性携带“说话人切换”标记：

- 显式指定：`> {name}: {content}`（或 `< {name}: {content}`）
- 历史回溯：`> _{n}: {content}`（或 `< _{n}: {content}`）
  - `_:` 等价于 `_1:`；`n` 为正整数
  - 语义：切换到同方向（仅 `>` 或仅 `<`）说话人历史中“往回第 n 个”说话人
  - 历史不足时建议直接报错（更安全）

若 `>` / `<` 后没有 `{name}:` 或 `_{n}:`，则视为“沿用当前说话人”（不改变当前说话人）。

### 命名空间（可选）
为避免“同名角色”冲突，`{name}` 支持写成 `namespace.character`：

- `ba.梦`：蔚蓝档案学生库角色（等价于原来的直接写 `梦`）
- `custom.yz`：自定义人物 id（等价于 `yz`）

未写命名空间时，会按“默认导入顺序”解析：`ba` 与 `custom`（目前固定为两者）。

### 说话人状态
`>` 与 `<` 分别维护独立的说话人状态与历史（互不影响）。

### 示例
```text
> 星野: 第一行
续行（仍然是星野）

> 梦: 插话

> _:
回到上一个对方说话人（星野）

- 旁白一行
旁白续行
```

## 下载脚本：学生头像（全异步）
从 `https://api.kivo.wiki/api/v1/data/students` 拉取学生列表，生成：

- `avatar/name_to_id.json`：`"{given_name_cn}({skin_cn})" -> id` 的映射（`skin_cn` 为空则不带括号）
- `avatar/{id}.png`：头像文件（默认优先 PNG；如源格式非 PNG 且安装了 Pillow，会尝试转成 PNG；否则保存原始后缀如 `.webp`）

运行：

`python tools/download_student_avatars.py --out-dir avatar --resume`

只写映射不下载：

`python tools/download_student_avatars.py --out-dir avatar --dry-run`

优先保存 PNG（需要 Pillow 才能把 webp/jpg 转 png）：

`python tools/download_student_avatars.py --out-dir avatar --prefer-png --resume`

保留原始后缀（不尝试转 PNG）：

`python tools/download_student_avatars.py --out-dir avatar --no-prefer-png --resume`

## 解析器：MMT 文本 DSL -> Typst JSON
把 `-` / `>` / `<` 的 MMT 文本对话 DSL 转成 `mmt.typ` 可直接 `json(...)` 读取的格式，并自动尝试用 `avatar/name_to_id.json` + `avatar/{id}.*` 绑定头像。

运行（输入 `mmt_format_test.txt`，输出同名 `.json`）：

`python mmt_text_to_json.py mmt_format_test.txt`

输出转换报告（未解析到头像/名字冲突等）：

`python mmt_text_to_json.py mmt_format_test.txt --report mmt_format_test.report.json`

在 `mmt.typ` 中渲染生成的 JSON（示例）：

`#parse_moetalk_file(json("mmt_format_test.json"))`

## 一键流水线（parse -> resolve -> render）
把 `mmt.txt` 一键转成 JSON，并可选调用 SiliconFlow reranker 把 `[表情描述]` resolve 成具体图片，最后可选渲染 PDF：

`python mmt_pipeline.py mmt_format_test.txt --resolve --pdf`

### Typst 渲染安全（可选）
如果你允许用户输入参与 Typst 渲染（例如 `--typst`），建议对 Typst 进程做资源限制（防止恶意 payload 导致 OOM/卡死）：

- `MMT_TYPST_TIMEOUT_S`：默认 `30`（秒）
- `MMT_TYPST_MAXMEM_MB`：默认 `2048`
- `MMT_TYPST_RAYON_THREADS`：默认 `4`（设置 `RAYON_NUM_THREADS`）
- `MMT_PROCGOV_BIN`：Windows 下可选，指向 `procgov`（Process Governor）
- `MMT_TYPST_ENABLE_PROCGOV`：默认 `1`（Windows 下优先用 procgov 强制限制）

## 前端：本地预览页（FastAPI）
提供一个本地网页：粘贴/选择 MMT 文本 -> 调用后端解析 -> 在浏览器里预览气泡与头像，并可一键下载 JSON。

启动：

`python -m uvicorn app:app --reload`

打开：

`http://127.0.0.1:8000/`

PDF 预览：

- 需要本机安装 `typst`（命令行可用：`typst --version`）
- 页面里点“生成 PDF”即可（服务端会缓存到 `.cache/pdf`）
- 默认示例：页面打开时会自动加载 `mmt_format_test.txt` 到输入框（仅在输入框为空时）

## 批量打标（LLM）
使用 OpenAI 兼容 API（例如 `https://gcli.ggchan.dev/v1`）对 `images/students/{id}` 下的图片按文件名顺序分批（默认 8 张）打标，并在每个学生文件夹输出 `tags.json`。也可以通过环境变量 `OPENAI_BASE_URL`（或 `GCLI_BASE_URL`）设置默认端点。

先设置环境变量（不要把密钥写进代码/提交到仓库）：

`$env:GCLI_API_KEY="你的密钥"`

也可以放到项目根目录的 `.env`（脚本会自动读取）：

`GCLI_API_KEY=你的密钥`

运行（模型名按需调整）：

`python batch_tag_students.py --model gemini-3-pro-preview-maxthinking --base-url https://gcli.ggchan.dev/v1 --resume`（或设置 `OPENAI_BASE_URL` 后省略 `--base-url`）

## Reranker（SiliconFlow）
用于把“自然语言表情描述”在某个角色的 `tags.json` 候选中做重排（命中缓存/请求都会输出日志）。

环境变量：

`SILICON_API_KEY=...`（也兼容 `SILICONFLOW_API_KEY`；端点可用 `SILICONFLOW_BASE_URL`/`SILICONFLOW_RERANK_URL`/`SILICONFLOW_EMBED_URL` 覆盖）

默认模型：`Qwen/Qwen3-Reranker-8B`，默认缓存：`.cache/siliconflow_rerank.sqlite3`。

## 两阶段检索（Embedding -> Rerank）
当单个角色的候选图较多时（上百张），直接对全部候选做 rerank 可能较慢。`resolve_expressions.py` 支持先用 embedding 做召回，再对召回的 top-k 进行 rerank 精排：

- Embedding 模型：`Qwen/Qwen3-Embedding-8B`（SiliconFlow OpenAI 兼容 `/v1/embeddings`）
- 默认召回：top 50（`--embed-top-k 50`）
- Embedding 会写入缓存：`.cache/siliconflow_embed.sqlite3`（只缓存候选文档，不缓存 query）

## 外链图片缓存（resolve_expressions.py）
`resolve_expressions.py` 支持把 `[:https://...]` 与 `@asset.*` 下载到本地缓存：

- 默认缓存目录：环境变量 `MMT_ASSET_CACHE_DIR` 或 `.cache/mmt_assets`
- `--redownload-assets`：强制重新下载（URL 内容可能变化时使用）
- `--asset-max-mb`：限制单图最大下载体积（默认 10MB）
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
