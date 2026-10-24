## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Chat is a temporary complete-theme rendering preset

The tracked template SHALL accept internal presentation/chat-width inputs through Rust emission. Chat SHALL overlay the full existing theme, not supply a partial theme dictionary. It SHALL leave authored source and output preset parameters unchanged.

#### Scenario: Chat presentation is generated

- GIVEN valid chat width in logical units
- WHEN the same authored MMT is emitted through the chat preset
- THEN page height MUST be auto and left/right/top/bottom margins MUST be12pt
- AND body size MUST be16pt, avatar40pt, avatar gap8pt, message gap12pt, continued gap4pt and bubble radius12pt
- AND generated header/footer MUST NOT be emitted
- AND explicit authored pagebreak, body, names, expressions, images, inline styling, line breaks and advanced content MUST continue through the same rendering/source-map chain
- AND preset-specific background injection MUST NOT hide or delete authored graphics

#### Scenario: Output presentation is generated after chat

- GIVEN the author switches to layout or an omitted/output render request
- WHEN the template runs
- THEN original output template parameters, page/header/footer and white-background behavior MUST remain unchanged
- AND chat MUST NOT have modified @document, document overrides, source bytes or persistent author settings

### Requirement: Chat scale is measured in SVG logical units rather than fitted paper

Chat SHALL center a content slot with maximum width720 CSS px and use one SVG logical unit per CSS px. It SHALL NOT use fit-width, paper shadow, page-number or zoom chrome. Output SHALL retain normal user zoom, fit and page controls.

#### Scenario: A panel changes the actual chat content width

- GIVEN a visible chat canvas and an auxiliary panel
- WHEN the content-slot ResizeObserver reports a new size
- THEN the host MUST derive an integer logical width constrained to240–720 and request that chat preset
- AND unchanged effective width MUST NOT cause recompilation
- AND window width guesses MUST NOT replace real container measurement
- AND actual glyph/container measurements MUST establish the intended16px reading scale rather than assume CSS point conversion

#### Scenario: Explicit pagebreak or advanced content is rendered

- GIVEN authored content contains pagebreak or advanced @typ
- WHEN chat is rendered
- THEN authored content MUST remain present with its real mapping and permissions
- AND failed advanced layout MUST report its genuine error with layout/local-source recovery, not crop, silently omit or rewrite content
- AND dark Workbench theme MUST NOT invert SVG or change author colors
