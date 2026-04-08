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

系统在渲染与资源查找过程中，SHALL 阻止任意资源路径穿越。

#### Scenario: Resolving a referenced asset

- GIVEN 脚本或模板通过名字引用某个资源
- WHEN 流水线解析这个资源时
- THEN 解析后的路径被限制在允许的 pack 资源范围内
- AND 原始任意文件系统路径不会被直接信任

### Requirement: Pack-driven visual output

系统对于渲染行为的决定，SHALL 来自已跟踪的模板和 pack 元数据，而不是隐藏的运行时状态。

#### Scenario: Rendering with a selected pack

- GIVEN 一次面向特定 pack 的渲染请求
- WHEN 流水线准备 Typst 输入时
- THEN 由所选 pack 的元数据和已跟踪模板决定输出行为
- AND 渲染结果不依赖未文档化的本地私有配置
