## 1. 收敛 DSL 下一版的设计原则

- [x] 1.1 明确核心 DSL、表情/资源引用标记与 `@typ` 的职责分层
- [x] 1.2 明确节点头部局部 patch 的目标与边界
- [x] 1.3 明确人物配置需要转向聚合声明
- [x] 1.4 明确 `@char` 的 template / instance / handle 三层修改模型

## 2. 形成初版语法草案

- [x] 2.1 给出 `@char` 的候选聚合声明写法
- [x] 2.2 给出 `@asset` 的候选块状配置与短行简写方向
- [x] 2.3 给出 statement / `@reply` / `@bond` 的头部 patch 草案
- [x] 2.4 给出正文资源引用向 `[:...:]` 标记收敛的方向
- [x] 2.5 给出统一资源路径、`avatar` / `sticker` slot 与资源贡献消歧规则
- [x] 2.6 给出 `[:...:]` 表情/资源引用标记的参数列表、确定性失败规则与渲染参数后缀
- [x] 2.7 给出 `#n` 编号 selector 规则，并暂缓自然语言查询
- [x] 2.8 明确 statement continuation、fenced body 与 `@reply` 显式列表项规则
- [x] 2.9 明确 `t` / `T` / `rt` / `rT` 正文模式与 Typst AST overlay macro 处理策略
- [x] 2.10 明确字段列表分隔符使用引号保护与反斜杠转义
- [x] 2.11 明确 `@mode` 当前文件、正文节点限定作用域
- [x] 2.12 明确裸 subject selector 只在有明确 speaker 的 message 中可用
- [x] 2.13 明确旧 inline target forms 在下一版主 parser 中 deprecated

## 3. 留出待决问题

- [x] 3.1 记录 `@asset` 是否长期保留短行简写
- [x] 3.2 记录 `@bond` / `@bond:` 的收敛问题
- [x] 3.3 记录短行参数与字面量系统的待定点
- [x] 3.4 记录 pack manifest 中是否允许 handle 形式资源路径的问题
- [x] 3.5 记录旧 `[]` / `[expr](target)` 写法的兼容或废弃问题
- [x] 3.6 记录第一版不在 patch 中启用 slot 上下文简写

## 4. 后续实现准备

- [ ] 4.1 将语法草案进一步细化为 parser 级规则
- [ ] 4.2 明确 patch 的 AST 约束和 source map 需求
- [ ] 4.3 基于新语法草案拆出渲染管线重构任务
