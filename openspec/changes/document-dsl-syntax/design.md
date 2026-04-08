## Overview

这次 change 的目标是记录当前行为，而不是提出新的语言特性。这里的事实来源是 parser 和 compiler 的实现，而不是现有的语法帮助文本。

## Key Decisions

### 实现真相优先于理想化说明

仓库里已有一些 prose 文档描述的能力，比当前代码真实支持的范围更大。这份 spec 会刻意以 parser / compiler 当前实现为准，即使某些行为看起来有点反直觉。

### 把语法表面与编译保证拆开

现有的 `dsl-compilation` spec 仍然适合描述稳定性和兼容性；新的 `dsl-syntax` spec 则专注于“作者现在究竟可以写什么”以及“系统当前会如何解释它”。

### 保留关键边角语义

这份 spec 会把一些实际很重要的边缘行为保留下来，包括正文里的 `#` 行会变成 continuation、Typst 模式下空行的处理方式，以及内联表达式 target 命名空间比对话 selector 更窄等事实。
