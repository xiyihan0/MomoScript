## Why

最初的 OpenSpec bootstrap 只在较高层级描述了 DSL 编译行为，但没有把“已经实现出来的语法表面”正式记录下来。仓库里虽然已有 `mmt_help_syntax.typ` 这类语法说明，但其中一些细节并不完整，或者比 parser / compiler 的真实实现更超前。

## What Changes

- 新增一个以 `mmt_core/dsl_parser.py` 为基础的 `dsl-syntax` capability spec
- 把只有结合 `mmt_core/dsl_compiler.py` 才能看清的运行时语义补充进去
- 记录若干实现相关的边角行为，方便今后做语法改动时能够对照“当前真实行为”，而不是对照零散的说明文本

## Impact

- Formal spec delta：`dsl-syntax`
- 相关实现参考：`mmt_core/dsl_parser.py`、`mmt_core/dsl_compiler.py`、`mmt_core/mmt_text_to_json.py`
- 影响代码：无
