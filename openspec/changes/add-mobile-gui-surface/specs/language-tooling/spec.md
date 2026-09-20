## ADDED Requirements

### Requirement: Composer document projection is a lossless source partition

The Rust language core SHALL project each current MMT source snapshot into ordered Message、Narration and Opaque nodes whose UTF-8 ranges form a complete、non-overlapping and gap-free partition of the authored bytes. The projection SHALL remain a derived snapshot and SHALL NOT become another authored document.

#### Scenario: Valid mixed document round-trips exactly

- GIVEN a source contains chat statements、narration、directives、blank lines、Reply/Bond and Unicode
- WHEN Rust builds the Composer document projection
- THEN the first node MUST start at byte zero
- AND every node end MUST equal the next node start
- AND the last node MUST end at `source.len`
- AND every boundary MUST be a UTF-8 character boundary
- AND concatenating the exact core source slice for every node MUST byte-equal the original source

#### Scenario: CRLF ownership is indivisible

- GIVEN a document uses CRLF line endings
- WHEN syntax and trivia ranges are partitioned
- THEN each CRLF pair MUST belong wholly to the preceding physical-line node
- AND no node boundary may split `\r\n`
- AND round-trip bytes MUST preserve CRLF without normalization

#### Scenario: Unsupported and recoverable content remains represented

- GIVEN parser recovery produces an error node、unknown syntax or an unconsumed source gap
- WHEN projection is built
- THEN those bytes MUST become Opaque nodes categorized as `recoverableError` or `unsupported`
- AND each physical blank line、directives、Reply/Bond and BOM/residual gaps MUST remain explicit Opaque nodes
- AND current comment-looking `// ...` lines MUST remain parser diagnostics and project as `recoverableError`, not be reclassified by a client/projection heuristic
- AND `comment` MUST remain only an allowlisted reserved category until the Rust parser recognizes a real comment syntax
- AND no malformed or unknown bytes may be omitted、attached through an undocumented heuristic or interpreted by TypeScript

#### Scenario: Empty document is projected

- GIVEN the current source is empty
- WHEN projection is built
- THEN the result MAY contain zero nodes
- AND its TextDocument version and source digest MUST identify the empty snapshot
- AND insertion MUST use the explicit empty-document boundary rather than a fabricated node

### Requirement: Composer document wire snapshots are strict and version-bound

`mmt/composerDocument` SHALL return one exact-key snapshot for the requested current TextDocument URI/version or an explicit rejection. Every node identity SHALL be snapshot-local and SHALL NOT be persisted across document versions.

#### Scenario: Current snapshot is returned

- GIVEN TextDocument URI U is open at version V
- WHEN the host requests `mmt/composerDocument` for U/V
- THEN the result MUST repeat U/V、include `canonical_bytes_digest("mmt-composer-document-v1", &[source.as_bytes()])` as 64 lowercase hexadecimal characters and return ordered strict node variants
- AND each node MUST include a unique snapshot-local `nodeKey` using independent `mmt-composer-node-v1` framing over sourceDigest、kind and byte range
- AND Message/Narration MUST separate allowlisted immutable product descriptors from server-authorized mutation capabilities
- AND move/insert capabilities MUST carry their exact authorized BoundaryTarget and allowed product choices rather than booleans requiring client inference
- AND Message/Narration MUST expose Rust-generated `textEditing: { text: string } | null` for uniquely addressable LF-normalized semantic bodies; null MUST forbid text endpoints
- AND this capability MUST NOT waive version、grapheme、mode or mixed-EOL write checks
- AND document-level script actor choices MUST contain only server-serializable actor references/descriptors
- AND Opaque MUST contain only an allowlisted category、exact range、at most 4096 UTF-8 bytes of char-boundary `sourcePreview`、`sourceTruncated`、at most 160 Unicode scalars of `summary` and source-navigation capability
- AND the response MUST NOT expose arbitrary-size authored source、AST objects、ActorId、mutable parser nodes or general source-edit authority

#### Scenario: Client validates a snapshot

- GIVEN the Web client receives a Composer document result
- WHEN it compares the result with its current TextDocument
- THEN it MUST require exact URI/version and recompute the same length-prefixed canonical source digest over `document.getText()`
- AND it MUST require exact keys、allowlisted bounded fields、unique node keys、ordered adjacent ranges、reversible `offsetAt`/`positionAt` boundaries and full document coverage
- AND one malformed、unknown、overlapping、gapped、truncated-identity or missing node MUST invalidate the complete snapshot
- AND the client MUST NOT drop only that node or synthesize replacement nodes from source/preview content

#### Scenario: Request is stale

- GIVEN the requested version no longer matches the current language-service snapshot
- WHEN `mmt/composerDocument` executes
- THEN it MUST return `staleDocument`
- AND MUST NOT return a newer projection、retarget node identities or reuse node keys from another version

### Requirement: Structural Composer commands are Rust-authorized and partition-bound

`mmt/composerEdit` SHALL retain the existing property-command wire and add structure edits through one exact-key `StructureEditParams` envelope containing `{ textDocument, sourceDigest, target, command }`. `target` SHALL be a strict `NodeTarget | BoundaryTarget`; `command` SHALL be one of `insertStatement`、`deleteNode`、`moveNode` or `setStatementSpeaker`. No alias、sibling edit request、raw replacement source、arbitrary offset or client TextEdit SHALL be accepted.

#### Scenario: Statement is inserted at a node boundary

- GIVEN the command references the current URI/version/digest and one exact BoundaryTarget exposed by capability
- AND an inserted Message contains left/right、one Pack/script `SpeakerChoice.actor.reference`、nonempty body、one of the five valid body modes and continued
- OR an inserted Narration contains only nonempty body and a valid mode
- WHEN `insertStatement` executes
- THEN Rust MUST serialize one canonical statement at that boundary and choose a deterministic EOL from the authorized boundary, using LF only for an empty document
- AND MUST preserve every existing node byte exactly
- AND MUST return one current-version single-document WorkspaceEdit
- AND TypeScript MUST NOT supply replacement source、byte offsets or a TextEdit

#### Scenario: Movable node is deleted

- GIVEN target identifies one current Message or Narration node
- WHEN `deleteNode` executes
- THEN only that node's owned range MAY be removed
- AND preceding/following Opaque blank、directive、error、unsupported bytes（以及未来 parser 真正识别的 comment bytes）MUST remain byte-exact
- AND deletion MUST be rejected if the candidate cannot pass complete reanalysis

#### Scenario: Node moves within one movable run

- GIVEN target and anchor identify Message/Narration nodes in one continuous run containing no Opaque node between them
- AND every existing run delimiter is the same LF or CRLF sequence
- WHEN `moveNode` executes
- THEN Rust MUST reorder logical node payloads and reconcile delimiters over the smallest affected run range
- AND it MUST use the run delimiter between every adjacent payload
- AND it MUST preserve whether the EOF-terminated run originally had a final EOL
- AND every statement byte other than delimiter reassignment MUST retain exact content
- AND the candidate MUST preserve all semantics outside the explicitly allowed statement-order transition

#### Scenario: Unterminated LF final node moves to the beginning

- GIVEN the exact source is `A\nB` and ends at EOF without a final EOL
- AND `A` owns LF while final node `B` has no terminator
- WHEN `B` moves before `A`
- THEN the exact candidate source MUST be `B\nA`
- AND `B` MUST gain the interior LF delimiter
- AND new final node `A` MUST have no final EOL

#### Scenario: LF first node moves to unterminated EOF

- GIVEN the exact source is `A\nB` and ends at EOF without a final EOL
- WHEN `A` moves after `B`
- THEN the exact candidate source MUST be `B\nA`
- AND new interior node `B` MUST be followed by LF
- AND new final node `A` MUST have no final EOL

#### Scenario: CRLF moves reconcile without splitting pairs

- GIVEN the exact source is `A\r\nB` and ends at EOF without a final EOL
- WHEN either `B` moves before `A` or `A` moves after `B`
- THEN the exact candidate source MUST be `B\r\nA`
- AND no CRLF pair may be split、normalized to LF or appended at EOF

#### Scenario: Move preserves an existing final EOL

- GIVEN the exact source is `A\nB\n`
- WHEN either node is moved to exchange their order
- THEN the exact candidate source MUST be `B\nA\n`
- AND final-EOL presence and LF style MUST remain unchanged

#### Scenario: Mixed-EOL movable run is unsupported

- GIVEN target and anchor lie in one run containing both LF and CRLF delimiters
- WHEN move capability is resolved or a direct `moveNode` request is received
- THEN move capability MUST be absent
- AND the direct request MUST return `unsupportedStructure`
- AND Rust MUST NOT normalize the run or defer delimiter safety to candidate parse failure

#### Scenario: Move crosses an opaque barrier

- GIVEN any Opaque comment、blank、directive、recoverable-error or unsupported node lies between target and anchor
- WHEN move capability is resolved or a direct `moveNode` request is received
- THEN the snapshot MUST report that move as unavailable
- AND a direct request MUST return `unsupportedStructure`
- AND no Opaque node may be implicitly carried、deleted or left outside the partition

#### Scenario: Statement speaker changes

- GIVEN target is one current Message whose capability authorizes a Pack or script actor reference
- WHEN `setStatementSpeaker` executes
- THEN Rust MUST re-resolve that exact reference against the current PackRegistry/script actors and minimally serialize the statement marker
- AND existing Builtin-speaker Messages MUST remain body-editable but expose no speaker mutation capability
- AND narration、Builtin、unknown、stale or non-serializable choices MUST return `speakerUnavailable`
- AND candidate reanalysis MUST prove target body/mode/continued and every non-target product/resource state remain unchanged

#### Scenario: Structure payload is malformed or stale

- GIVEN a command contains unknown fields、raw source、arbitrary byte offsets、unknown enums、an Opaque target、missing node identity、an invalid target-command combination or a stale digest/version
- WHEN native stdio or WASM parses and executes it
- THEN unknown/overlong/malformed wire data MUST fail as invalid params
- AND stale/changed authority MUST return `staleDocument` or `targetChanged`
- AND unsupported barriers/EOL/targets MUST return `unsupportedStructure`
- AND neither transport may coerce、default、retry or retarget the command

### Requirement: Structural candidate analysis preserves every unowned byte and semantic boundary

The core SHALL rebuild the current partition、apply one in-memory candidate mutation and fully parse/analyze it with the current PackRegistry before returning any structural edit.

#### Scenario: Candidate is accepted

- GIVEN a valid structural command changes only its documented target/order/insertion semantics
- WHEN before and after candidates are compared
- THEN every unaffected Opaque source slice MUST remain byte-equal
- AND every unaffected statement marker、body、patch、actor revision、resource identity、document setting and diagnostic phase MUST remain equal
- AND the after projection MUST again satisfy complete `[0, len)` partition and byte-concatenation invariants
- AND the service MUST return exactly one TextDocumentEdit carrying the original document version
- AND `WorkspaceEdit.changes` MUST be absent

#### Scenario: Candidate drifts or becomes invalid

- GIVEN a structural operation would cross an unsupported semantic boundary、change unrelated resolved state、or produce syntax/semantic/resource errors
- WHEN candidate validation runs
- THEN the service MUST return `candidateInvalid` or `unsupportedStructure`
- AND MUST return no partial edit、server mutation or fallback source rewrite

### Requirement: Composer text endpoints address normalized semantic body boundaries

Text selection SHALL use `ComposerTextEndpoint = {node: ComposerNodeRef, offsetUtf16: number}` and `ComposerTextSelection = {anchor: ComposerTextEndpoint, focus: ComposerTextEndpoint}`. Offsets SHALL address LF-normalized semantic body text, not raw MMT source. Direct body editing SHALL be limited to uniquely mapped Message/Narration bodies whose resolved mode is `textMacro` or `textRaw`.

#### Scenario: An endpoint is validated

- GIVEN a current snapshot node with non-null `textEditing`
- WHEN Rust resolves its `offsetUtf16`
- THEN Rust MUST convert per-node UTF-16 through Unicode scalar boundaries to the exact original UTF-8 body position
- AND offset zero and body end MUST be valid boundaries
- AND out-of-bounds、surrogate-interior or grapheme-interior endpoints MUST return `invalidValue`
- AND grapheme segmentation MUST use the existing locked `unicode-segmentation 1.13.3`, adding a direct dependency through Cargo if needed without hand-editing lock checksums

#### Scenario: Rendered text is not reversible

- GIVEN a Typst body、irreversible macro-generated fragment、Opaque node or ambiguous mapping
- WHEN body selection/edit authority is requested
- THEN non-body/unsupported structures MUST return `unsupportedStructure`
- AND failure to uniquely identify an otherwise supported target MUST return `targetChanged`
- AND the service MUST NOT locate a different statement by equal text or expose arbitrary source-edit authority

#### Scenario: Input contains different newline encodings

- GIVEN replacement is user-entered body text
- WHEN it contains CRLF or CR
- THEN Rust MUST normalize input to semantic LF before serialization
- AND the result MUST still satisfy the existing body-size limit
- AND `>`、`@`、quotes and other DSL-looking characters MUST remain body data, not client-supplied MMT replacement source

### Requirement: Text selection reading is pure strict and source-bound

The language service SHALL expose pure `mmt/composerTextSelection` with exact params `{textDocument, sourceDigest, anchor: Range, focus: Range}`. Anchor/focus ranges SHALL already be projection-mapped authored MMT positions. Its exact result SHALL be `{kind:"Selection",textDocument,sourceDigest,selection:ComposerTextSelection,text:string}` or `{kind:"Rejected",reason:ComposerEditRejectedReason}`.

#### Scenario: A rendered selection becomes semantic authority

- GIVEN current URI/version/digest and two exact authored body ranges
- WHEN `mmt/composerTextSelection` executes
- THEN Rust MUST parse the actual bodies, resolve both endpoints and validate the entire cross-body interval
- AND MUST retain anchor/focus direction in `selection`
- AND `text` MUST contain source-ordered selected semantic fragments separated by exactly one LF
- AND MUST exclude speaker prefixes、fences and Opaque bytes
- AND the request MUST neither mutate the document nor return a client edit plan

#### Scenario: Empty body is selected without a fake glyph

- GIVEN a newly accepted snapshot authorizes an empty body
- WHEN the GUI enters its explicit empty caret area
- THEN it MUST use that current node plus offset zero
- AND MUST NOT fabricate a glyph hit or search another equal empty body

#### Scenario: Selection reading crosses a barrier

- GIVEN selected endpoints span a non-blank Opaque node or a different resolved body mode
- WHEN copy authority is read
- THEN the complete request MUST return `unsupportedStructure`
- AND MUST NOT truncate copy to a supported prefix or return partial selection success

### Requirement: Text replacement extends the existing Composer mutation contract

The existing `mmt/composerEdit` SHALL accept exactly `{textDocument,sourceDigest,target:{kind:"textSelection",selection:ComposerTextSelection},command:{kind:"replaceTextSelection",replacement:string}}` for body text edits. It SHALL NOT add a second mutation method or weaken the existing `setStatementBody` nonempty/single-line input contract.

#### Scenario: A text command returns its candidate selection

- GIVEN a current authorized selection and valid replacement
- WHEN candidate validation accepts the edit
- THEN the result MUST be exactly `{kind:"TextEdit",edit:ComposerWorkspaceEdit,sourceDigestAfter:string,selectionAfter:{anchor:{statementRange:Range,offsetUtf16:number},focus:{statementRange:Range,offsetUtf16:number}}}`
- AND `edit` MUST contain one current-version TextDocumentEdit, with one or more non-overlapping TextEdit entries as needed to preserve blank bytes
- AND `WorkspaceEdit.changes` MUST remain absent
- AND digest and post-edit statementRange MUST be recomputed from the actual candidate, not predicted by the client
- AND selectionAfter MUST collapse at replacement end with an offset including the retained first-body prefix
- AND original property/structure commands MUST retain their `Edit` result branch without aliases

#### Scenario: One body or all of its characters are replaced

- GIVEN a selection is wholly within one eligible body
- WHEN replacement includes newlines or is empty
- THEN only that body's semantic text MAY change
- AND deleting all characters MUST preserve the statement and a legal empty fenced body
- AND no hidden sentinel、automatic node deletion or implicit merge MAY occur

#### Scenario: Cross-body replacement merges the source-ordered interval

- GIVEN selected Message/Narration bodies have one resolved body mode and only optional `Opaque.blank` nodes between them
- WHEN replacement executes in either anchor/focus direction
- THEN the first source-ordered statement body MUST become its unselected prefix + replacement + the last statement's unselected suffix
- AND the first statement MUST retain kind、side、speaker、mode and properties
- AND Rust MUST remove the subsequently selected statement nodes
- AND each intervening blank node MUST retain its exact original bytes
- AND `- abc\n- def\n` selected from first offset 1 to second offset 2 and replaced by `X` MUST yield first-body text `aXf` and a collapsed offset 2

#### Scenario: Cross-body mutation is unsafe

- GIVEN a selected interval crosses a non-blank Opaque node or different resolved body mode
- WHEN replacement executes
- THEN it MUST return `unsupportedStructure` without any edit
- GIVEN deleting selected statements would change inherited actor/mode/resource semantics of an unselected statement
- WHEN candidate proof runs
- THEN it MUST return `candidateInvalid`
- AND MUST NOT rewrite the unselected statement to repair inheritance

### Requirement: Text candidate proof preserves all bytes and semantics outside its contract

Text editing SHALL reuse existing reparse/analyze、PackRegistry and outside-target validation. It SHALL create neither a second AST nor a parallel source-authority path.

#### Scenario: Candidate is proven

- GIVEN a current text selection and replacement
- WHEN Rust compares before and after candidates
- THEN same-node edits MAY change only body text
- AND cross-node edits MAY additionally remove only the documented selected statements
- AND all other nodes MUST retain exact raw bytes and resolved semantics
- AND the candidate MUST satisfy the complete lossless partition and existing body-size limits
- AND the service MUST return one atomic versioned edit without server apply、automatic retry or partial result

#### Scenario: Text identity or wire is invalid

- GIVEN unknown fields/enums、wrong target-command pairs、stale version/digest/node references or invalid offsets
- WHEN native stdio、WASM or TypeScript parses and dispatches the command
- THEN malformed wire MUST fail as invalid params
- AND stale documents MUST return `staleDocument`, changed/non-unique targets `targetChanged`, unsupported bodies/barriers `unsupportedStructure`, invalid semantic offsets/values `invalidValue`, and failed candidates `candidateInvalid`
- AND all producers/consumers MUST use the same exact request/command/result shapes and UTF conversion
- AND neither transport MAY default unknown fields、retarget、retry old authority or recognize a browser-only mutation

### Requirement: Fenced body parsing preserves exact source and disambiguates closing runs

Fenced-body parsing SHALL derive body text from the exact original source slice between established body_start/body_end, excluding only the grammar's opening-line delimiter. It SHALL preserve CRLF、leading/trailing blank lines、empty body ranges and unterminated recovery. A closing quote run of length at least opener length N SHALL close with its last N quotes; any preceding quotes in that same run SHALL remain body text.

#### Scenario: Fenced content includes blank lines or CRLF

- GIVEN a fenced body has leading or trailing empty lines and LF or CRLF
- WHEN `try_parse_fenced_body` parses it
- THEN body text and raw range MUST correspond to the exact source slice
- AND the parser MUST NOT conditionally reconstruct newlines or trim trailing body EOLs
- AND reversible raw-to-LF semantic EOL mapping MUST retain exact original positions

#### Scenario: Body ends with quotes

- GIVEN opener length is N and the body ends with 1、2 or N−1 quotes directly before the closer
- WHEN `find_fence_close` scans the full terminal run
- THEN only the last N quotes MUST form the closer
- AND preceding terminal quotes MUST belong to the body
- AND internal runs shorter than N MUST NOT close the body
- AND the rule MUST preserve normal historical fences and existing unterminated recovery
- AND serialization MUST NOT append a body newline to avoid this disambiguation

#### Scenario: Empty fenced syntax is parsed

- GIVEN an opener, its line break and a closer on the following line
- WHEN the parser reads the statement
- THEN it MUST produce a legal empty body and empty body range
- AND six adjacent quotes MUST remain an opening delimiter rather than be reinterpreted as empty-body shorthand

### Requirement: Rust serializes multiline and empty bodies reversibly

The text serializer SHALL preserve inline syntax only when an originally inline candidate still parses exactly to the intended semantic body. Otherwise it SHALL use a fenced envelope with delimiter length `max(3, longest body quote run + 1)`, an independent opener line and the original mode prefix.

#### Scenario: Body requires a fence

- GIVEN replacement adds newlines、unsafe inline syntax or an empty body
- WHEN Rust serializes the body
- THEN it MUST preserve the original envelope including inherit rather than force an explicit mode
- AND the opener MUST be on its own line so leading body quotes are not swallowed
- AND a nonempty body's closer MUST immediately follow its final body character
- AND an empty body's closer MUST occupy the line immediately after the opener
- AND a body ending in LF MUST naturally put the closer on the next line without adding another body newline
- AND no hidden character MUST be inserted

#### Scenario: EOL style and file ending survive

- GIVEN an editable body has homogeneous EOLs or none
- WHEN new body line breaks are serialized
- THEN EOL selection MUST prefer existing uniform body EOL, then statement terminator, then first document terminator, and LF for an empty document
- AND bytes outside the selected edit contract MUST remain exact
- AND file final-EOL presence MUST remain unchanged, including files with no final EOL

#### Scenario: Body contains mixed EOLs

- GIVEN a uniquely addressable body mixes LF and CRLF
- WHEN it is displayed or copied
- THEN LF-normalized semantic text MAY be read without mutating raw bytes
- WHEN direct modification is requested
- THEN it MUST return `unsupportedStructure`
- AND MUST NOT normalize unselected or mixed-EOL bytes as a side effect

### Requirement: Text projection returns only exact reversible generated spans

The service SHALL expose pure `mmt/composerTextProjection` with all identity fields of existing `PreviewComposerTargetParams` except `location`, plus `selection:ComposerTextSelection`. Its exact result SHALL be `{kind:"Mapped",anchor:PreviewBackendLocation,focus:PreviewBackendLocation,segments:PreviewBackendLocation[]}` or `{kind:"Rejected",reason:ComposerEditRejectedReason}`.

#### Scenario: Body spans generated fragments and escapes

- GIVEN a current semantic selection with valid existing projection identity
- WHEN the request uses the `typst_backend` identity gate and emitter source-map origins
- THEN it MUST map exact semantic body boundaries through authored source into emitted escaped-text character boundaries
- AND only unique reversible body fragments MAY be returned
- AND fence syntax and Typst wrappers MUST be excluded
- AND multiple fragments MUST remain separate segments rather than one broad range across wrappers
- AND the request MUST NOT synthesize matches through equal-text search

#### Scenario: Semantic empty lines retain exact projection anchors

- GIVEN leading、consecutive or trailing semantic LF creates an empty body line whose empty text source span is dropped by upstream layout
- WHEN the emitter generates that line's Typst output
- THEN it MAY emit the metadata-only layout anchor `#box(width:0pt)[#text("")#metadata((mmtTextCaret:N))]`
- AND N MUST be the generated UTF-8 offset inside the empty text literal, mapped by a collapsed `TextBody` source-map origin to the exact authored raw LF boundary
- AND the anchor MUST retain an actual empty-text hard-frame strut/baseline without adding a character
- AND metadata、box and wrapper bytes MUST NOT become semantic copy text or a broad editable source range
- AND this generated-only anchor MUST NOT modify authored MMT、insert a hidden sentinel or create a second source state
- AND the exception MUST be limited to semantic empty lines, not used to infer arbitrary missing source spans

#### Scenario: Selected line breaks have no glyph ink

- GIVEN a semantic selection includes LF or authored CRLF
- WHEN text projection returns its paint segments
- THEN nonempty segments MUST stop before and resume after each line break
- AND each selected line break MUST return its exact preceding caret as a collapsed segment, using the retained empty-line anchor where applicable
- AND the geometry consumer MUST query collapsed segments as carets, not require nonexistent newline glyphs or estimate their width
- AND source-range inverse authorization MUST still prove complete reversible source coverage independently of these paint segments

#### Scenario: Projection identity or mapping is unusable

- GIVEN version/digest/render/projection identity is stale or a body span cannot be uniquely reversed
- WHEN text projection is requested
- THEN it MUST reject through the existing rejection contract
- AND MUST NOT substitute a statement midpoint、broader wrapper range or another rendered occurrence

### Requirement: Renderer text geometry is extended only by measured necessity

The existing renderer SHALL be characterized against exact hit offsets、caret glyph-advance boundaries within 1 CSS px and range rectangles for every required sample. If any required case fails, the existing `mmt/previewRenderer.v1` patch SHALL add `hitTestText`、`locateCaret` and `locateRange`; if all cases pass, this renderer branch SHALL NOT be introduced.

#### Scenario: Required renderer actions serve precise geometry

- GIVEN characterization has triggered the renderer branch
- WHEN `hitTestText` receives a normalized page point plus required canonical `PreviewRendererPointUncertainty = {x,y}`, `locateCaret` receives uri/position/affinity, or `locateRange` receives uri/range
- THEN each action MUST require and echo committed sessionId/generation
- AND return source caret/affinity or page-normalized caret/selection boxes as appropriate
- AND support multiple rendered occurrences of one source location without providing edit plans
- AND traversal MUST accumulate group transforms and use glyph-cluster spans/advances with escaped-string offsets
- AND ambiguous source ownership MUST be rejected rather than estimated from an AST midpoint or average width
- AND ordinary navigation `PreviewPagePoint`/`PreviewRendererPoint`/Rust `PreviewPoint` payloads MUST remain unchanged

#### Scenario: Text-hit uncertainty expands containment only

- GIVEN `hitTestText` receives exact-key uncertainty components that are finite and within `[0,1]`
- WHEN native glyph-cluster containment is evaluated
- THEN the uncertainty MAY enlarge the containment region but MUST NOT move exact stop edges or change source、affinity、distance or nearest-stop ordering
- AND every intersecting cluster MUST still participate in fail-closed distinct-source ambiguity
- AND page coordinates MUST normalize and de-normalize with `D = ceil(f32(native page extent))`, not the fractional native extent
- WHEN uncertainty is missing、has unknown keys、is nonfinite or falls outside `[0,1]`
- THEN the text-hit request MUST be rejected without defaulting or clamping it

#### Scenario: Empty-line caret uses a measured layout anchor

- GIVEN a current generated semantic-empty-line anchor has a validated collapsed `TextBody` origin
- WHEN renderer geometry resolves its caret
- THEN it MUST use the actual hard-frame box extent、empty-text baseline and accumulated transforms
- AND MUST bind the result to the same committed session/generation and exact authored LF boundary
- AND MUST NOT invent a glyph、estimate average spacing or infer a location from neighboring lines
- AND an entirely empty statement MAY still expose the existing explicit label-bound GUI entry without pretending it has a glyph

#### Scenario: Renderer protocol and artifacts cut over together

- GIVEN new renderer actions are implemented
- WHEN native/WASM protocol、capability、session and process/worker consumers are updated
- THEN strict contracts MUST change together
- AND existing capture/managed build-promote/repin/publication scripts MUST compute patch and artifact identities
- AND runtime delivery MUST verify and consume the new immutable artifact, not an old CDN runtime
- AND no hand-written checksum、new sidecar、Tylina code or separate typst.ts fork MAY substitute for that delivery