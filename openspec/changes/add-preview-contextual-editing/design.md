## Context

Preview click navigation currently starts from a normalized page point, asks the retained location provider for a generated Typst location, then maps that location under a render/projection identity. That path may return exact authored identity、workspace Typst、read-only generated/package content、stale state or a coarse authored fallback. Only exact Identity segments authorize general Typst→MMT edits.

A preview GUI command has a different contract from projected editing. It does not map an arbitrary Typst TextEdit back into MMT. It identifies the unique authored syntax node that owns a rendered element, then asks the MMT language service to perform one allowlisted semantic mutation against the current source snapshot. The owning statement must be proven again when the mutation request executes.

The current Rust syntax AST already retains statement、patch、directive field and block ranges. Actor lowering records statement→ActorId/revision and `display-name` state. The language service already returns strict single-document versioned WorkspaceEdit for Rename and has declaration literal round-trip serialization.

## Decisions

### 1. Keep preview hit testing separate from edit authorization

The preview runtime posts only a normalized page point for a no-selection `contextmenu` event. Interactive MMT SVG MAY attach exporter-authored labels containing a deterministic opaque render target token and a visual role, but MUST NOT attach MMT ranges、actor ids、property values or edit authority. The token is only a same-artifact grouping hint.

For non-text chat surfaces, the runtime MAY use a strict `mmt:<role>:<token>` label to find another labelled region with the same token that owns rendered text, then snap the visual point to that region. The Webview message still carries only the normalized point and screen anchor; the host and language service remain unaware of the token.

The host resolves the point through the artifact's retained location provider without opening a source editor. For MMT preview it calls `mmt/previewComposerTarget` with:

```text
sourceUri
revision
sourceContent
projectDigest
projectionKey
entryUri
backendEncoding
renderer location { uri, range }
```

The server accepts a target only when all identity fields are current and the generated location has one unambiguous origin ancestry whose nearest editable owner is a left/right `StatementSyntax`. It then proves that the owner range exactly names one statement in the current parsed snapshot and that semantic lowering has one resolved speaker entry for it.

This origin walk is not `ProjectionIndex::typst_to_mmt` and does not return an editable mapped range for arbitrary use. `authoredFallback`、diagnostic fallback and raw backend location are never accepted as Composer authority. A unique current syntax/semantic node is the authority.

The result is a strict discriminated union:

```ts
type PreviewComposerTargetResult =
  | {
      kind: "Editable";
      textDocument: { uri: string; version: number };
      target: { kind: "statement"; range: Range };
      properties: {
        continued: "auto" | "true" | "false";
        actorDisplayName?: {
          current: string;
          scope: "fromStatement";
        };
      };
    }
  | {
      kind: "Unavailable";
      reason:
        | "stalePreview"
        | "nonMmtSource"
        | "unmapped"
        | "ambiguousOrigin"
        | "unsupportedNode"
        | "documentHasErrors"
        | "actorUnavailable";
    };
```

The response exposes no mutable AST object and no actor internal id. Range + document version is an ephemeral target key; every command re-resolves it.

### 2. Use one surface-independent pure Composer edit request

`mmt/composerEdit` receives:

```ts
interface ComposerEditParams {
  textDocument: { uri: string; version: number };
  target: { kind: "statement"; range: Range };
  command:
    | {
        kind: "setStatementContinued";
        value: "auto" | "true" | "false";
      }
    | {
        kind: "setActorDisplayNameFromStatement";
        value: string;
      };
}
```

The result is:

```ts
type ComposerEditResult =
  | { kind: "Edit"; edit: WorkspaceEdit }
  | {
      kind: "Rejected";
      reason:
        | "staleDocument"
        | "targetChanged"
        | "documentHasErrors"
        | "invalidValue"
        | "actorUnavailable"
        | "candidateInvalid";
    };
```

An `Edit` contains exactly one `TextDocumentEdit` with the current `OptionalVersionedTextDocumentIdentifier.version`. `WorkspaceEdit.changes` is absent. The server never calls apply、mutates its document snapshot or sends a private notification.

The client strictly parses the union and WorkspaceEdit, confirms the open TextDocument still has the returned version immediately before application, converts it through the language client's protocol converter, and calls `vscode.workspace.applyEdit`. A false result or version drift reports a non-destructive failure. The ordinary didChange→history→diagnostics→preview pipeline owns every consequence.

Although preview discovers the target, `mmt/composerEdit` is preview-independent. A future structured composer or gallery action may invoke the same command only after obtaining an equivalent current statement target from the language service.

### 3. First typed statement property is `continued`

The first property schema is closed:

```text
continued = auto | true | false
```

- `true` and `false` update the unique existing named argument or insert one into the statement patch.
- `auto` removes the named argument; if no arguments remain, it removes the complete patch enclosure without changing the statement marker、speaker or body spacing.
- Existing non-`continued` arguments retain original bytes、order and spelling.
- Duplicate、malformed or structurally ambiguous `continued` arguments reject the operation rather than normalizing them.
- Typst syntax parsing identifies top-level named arguments; string splitting is prohibited.

Candidate source is parsed and fully analyzed in memory. Acceptance requires zero Error diagnostics、the same target statement kind/marker/body/resource parts、unchanged actor/asset/resource identities and no unrelated syntax change.

`fill`、`text-fill`、`inset`、`radius`、`tip`、`image-only` and `reserve-avatar-space` remain outside the first property schema. They require explicit value types、UI controls and round-trip contracts before exposure.

### 4. `display-name` means an actor revision from the selected statement

The UI label is **“从本条起修改人物显示名”**. It is not actor-name Rename and not a one-bubble nickname.

The command is available only when the selected statement resolves to a non-builtin actor and the server can choose one unambiguous, declaration-round-trippable actor name from the current semantic model. The client sends only the requested display string; the server chooses and serializes the actor reference.

Source behavior:

1. If the selected statement is the first renderable node governed by an immediately adjacent `@actor` block for the same ActorId, update that block's unique `display-name` value or insert the field before `@end`.
2. Otherwise insert immediately before the selected statement:

```mmt
@actor <server-selected-name>
display-name: <round-tripped scalar>
@end
```

3. Preserve the document's newline convention and surrounding blank-line convention; do not reformat adjacent nodes.
4. Require a non-empty display string and serialize it through the declaration literal parser/encoder, quoting and escaping only when required.

Candidate reanalysis must prove:

- every statement before the target retains its ActorId and actor revision presentation;
- the target resolves to the same ActorId and captures a revision whose display name equals the requested value;
- later statements follow ordinary actor-revision semantics until another field changes the display name;
- speaker history、assets、resource selectors and unrelated semantic keys remain unchanged;
- the Pack preset and actor reference names remain unchanged.

A builtin、unresolved、ambiguous or non-serializable actor returns `actorUnavailable`. Empty input returns `invalidValue`.

A future one-bubble nickname requires a separate DSL proposal for a statement-local display override. It must not be simulated by inserting a revision and a hidden restore block.

### 5. Web UI uses an anchored native menu and owns no document state

`previewWebviewProtocol` adds one Webview→host message containing the normalized context page point plus a visual-only screen anchor. The anchor exists only to position native Workbench chrome; the message carries no authored range、actor id or property value and uses the same strict allowlist parser as existing navigation messages.

The preview runtime handles `contextmenu` only when:

- the pointer is inside a current rendered page;
- no non-collapsed text selection exists;
- the interaction was not a drag.

When the event target is a non-text graphic inside interactive MMT SVG, hit testing first parses the closest exporter-authored `data-typst-label` using a strict allowlist. Labels distinguish `bubble`、`avatar`、`display-name`、`reply`、`reply-item`、`bond` and `bond-body` visual roles while sharing one deterministic opaque token per owning rendered syntax target. The current token grammar is `t` plus exactly eight lowercase hexadecimal digits. The runtime may snap only to labelled text within the same token; it must not cross to another token or convert page whitespace into a target. A recognized reserved label with no same-token text is an orphan and MUST produce no context-point message rather than falling through to ancestor-group heuristics. Unlabelled content MAY retain the existing first-ancestor text-group fallback.

Label tokens MUST be deterministic for the same projection and syntax target, unique within that projection, bounded, and derived without embedding source URI、source ranges、actor identity、display text or authorization. Label groups remain transient render output; only the resolved current backend location and Rust syntax/semantic proof authorize a Composer target.

The runtime prevents the browser menu, posts the point and screen anchor, and retains no semantic target. The host cancels the prior request when another context request or render identity arrives.

For an editable target, the host opens the Workbench native context-menu service beside the pointer with:

- `编辑连续消息状态…`, exposing 自动、强制连续、强制新消息 as one radio submenu;
- `从本条起修改人物显示名…` when available;
- `转到源码`.

`display-name` uses the native Workbench `InputBox` inside a context view anchored from the original pointer. It is initialized from the descriptor's current display name、validates non-empty input and never falls back to the top Quick Input. The host dismisses stale menus/inputs when document version、artifact identity or runtime owner changes.

No preview-side custom menu、property store、AST cache or draft document buffer is introduced. `EditorRuntimeController` owns requests/subscriptions and disposal; `TextDocument` remains source truth.

### 6. Interactive SVG labels are visual targeting metadata

The emitter assigns each rendered statement/reply/bond target a deterministic projection-stable opaque token and passes it to the template as an optional argument. Templates attach reserved labels only to final frame-bearing containers:

- chat bubble/body;
- visible avatar;
- visible display name;
- reply container/items;
- bond container/body.

Typst labels on non-frame-bearing `metadata`、`place`、`strong` or plain text are insufficient. Avatar and display-name content therefore require zero-inset/outset box wrappers whose layout and baseline MUST remain visually identical. Labelled output is an interactive SVG profile: the SVG sanitizer accepts only the reserved bounded label grammar, and the runtime requires inline/Webview DOM access rather than `<img>`.

Exact text glyph hits retain character precision and take precedence. Label hits are coarse target expansion only. Reply/bond labels do not make those nodes editable in the first Composer slice; unsupported nodes remain navigation-only or unavailable under the existing Rust result.

### 7. Failure is explicit and non-destructive

- Old render identity or projection identity: `stalePreview`.
- Current renderer location without a unique statement origin: `unmapped` or `ambiguousOrigin`.
- Narration/reply/bond/raw Typst/package/generated-only target: `unsupportedNode` in the first slice.
For a current mapped authored target such as narration that is intentionally unavailable for Composer mutation, the host keeps the mutation actions absent but opens a navigation-only native menu containing `转到源码`. Stale、unmapped or ambiguous targets remain non-navigable here. Navigation continues through the existing permission-checked preview navigation path and never promotes that path into edit authority.

- Current source Error diagnostic: `documentHasErrors`.
- Version changes between context resolution、input and apply: reject without retrying against the new text.
- Candidate reanalysis failure: `candidateInvalid`; return no partial edit.

The host may show a concise native notification for an explicit user command failure. It must not silently jump to a nearby statement or reissue the edit against a newer version.

## Rejected Alternatives

- **Treat SVG labels as edit authority:** renderer output is not the authored model; labels may expand a visual hit target only.
- **Infer ownership from SVG order or geometry:** sibling/ancestor proximity is unstable across template changes and can select a nearby bubble.
- **Map a Typst TextEdit through parent fallback:** violates Identity-only projected editing and can select the wrong authored range.
- **Let TypeScript splice MMT text:** duplicates parser/serializer semantics and cannot prove actor/resource stability.
- **Server applies edits directly:** breaks the pure semantic-editing contract and prevents normal stale-version handling.
- **Expose arbitrary patch strings:** turns a GUI form into unvalidated Typst code injection and makes format brush unsafe.
- **Implement per-bubble nickname with temporary actor revisions:** produces hidden state and changes later semantics under malformed or reordered source.
- **Build a custom preview-Webview menu framework:** duplicates Workbench menu behavior and introduces preview-side product UI state. Once the semantic mutation boundary is proven, the native Workbench context-menu service can provide pointer-adjacent actions without that duplication.

## Rollout

1. Land Rust target/context and pure Composer edit contracts with core/LSP tests.
2. Expose identical native/WASM request routing and strict TypeScript response parsing.
3. Add contextmenu protocol and an anchored native Workbench menu for `continued`.
4. Add `display-name` from-statement editing through the same menu and native Input Box after the target path is proven.
5. Add exporter-authored semantic labels for interactive preview hit expansion without changing the point-only host protocol or Rust authorization boundary.
6. Only then design typed visual properties、one-bubble nickname and format brush as separate deltas that reuse `mmt/composerEdit`.
