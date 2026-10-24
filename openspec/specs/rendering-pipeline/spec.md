# rendering-pipeline 规格

## Purpose

定义编译后的 MomoScript 内容如何经由 Typst 渲染，同时保持安全性、可复现性以及 pack 驱动行为。

## Requirements

### Requirement: Sandboxed Typst execution

系统在执行 Typst 渲染时，SHALL 通过项目沙箱运行，并施加资源上限。

#### Scenario: Rendering a normal document

- GIVEN 一份已准备好进行 Typst 渲染的编译文档
- WHEN 渲染器调用 Typst
- THEN 执行通过沙箱路径进行
- AND 已配置的内存与超时限制持续生效

### Requirement: Sanitized asset resolution

系统在渲染与资源查找过程中，SHALL 阻止任意资源路径穿越。Pack 资源 SHALL 保持在允许的 pack root 内；脚本 LocalFile SHALL 相对作者文档所在目录解析，并允许安全的正斜杠分段相对路径而非仅 basename。所有既有合法 basename SHALL 继续有效；LocalFile 的语法扩展 SHALL NOT 授予任意文件系统或 URL 访问。

#### Scenario: Resolving a referenced asset

- GIVEN 脚本或模板通过名字引用某个资源
- WHEN 流水线解析这个资源时
- THEN pack 资源路径 MUST 限制在允许的 pack root，LocalFile MUST 限制在作者文档目录的受控范围内
- AND 原始任意文件系统路径不会被直接信任

#### Scenario: Source-relative local image paths retain sandbox boundaries

- GIVEN 脚本 LocalFile 或 GUI workspaceImage 引用 `assets/example.png`，或既有合法 basename
- WHEN semantic lowering、language/render projection、browser loader 或 native materializer 解析它
- THEN 各层 MUST 使用一致的相对作者文档目录基准和安全路径语法
- AND 路径 MUST 仅由非空且不为 `.`/`..` 的正斜杠分隔 segment 组成
- AND 绝对路径、反斜杠、控制字符和冒号 MUST 被拒绝，不得经宽松归一化后接受
- AND native canonical-path/root containment 检查 MUST 保留，包括拒绝 symlink 逃逸
- AND 语法验证成功 MUST NOT 绕过平台文件访问权限或使 workspaceImage 接受 URL

### Requirement: Pack-driven visual output

系统对于渲染行为的决定，SHALL 来自已跟踪的模板和 pack 元数据，而不是隐藏的运行时状态。

#### Scenario: Rendering with a selected pack

- GIVEN 一次面向特定 pack 的渲染请求
- WHEN 流水线准备 Typst 输入时
- THEN 由所选 pack 的元数据和已跟踪模板决定输出行为
- AND 渲染结果不依赖未文档化的本地私有配置
