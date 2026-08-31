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
- AND document-level script actor choices MUST contain only server-serializable actor references/descriptors
- AND Opaque MUST contain only an allowlisted category、exact range、at most 4096 UTF-8 bytes of char-boundary `sourcePreview`、`sourceTruncated`、at most 160 Unicode scalars of `summary` and source-navigation capability
- AND the response MUST NOT expose arbitrary-size authored source、AST objects、ActorId、mutable parser nodes or general source-edit authority

#### Scenario: Client validates a snapshot

- GIVEN the Web client receives a Composer document result
- WHEN it compares the result with its current TextDocument
- THEN it MUST require exact URI/version and recompute the same length-prefixed canonical source digest over `document.getText()`
- AND it MUST require exact keys、allowlisted bounded fields、unique node keys、ordered adjacent ranges、reversible `offsetAt`/`positionAt` boundaries and full document coverage
- AND one malformed、unknown、overlapping、gapped、truncated-identity or missing node MUST invalidate the complete snapshot
- AND the client MUST NOT drop only that node or synthesize a replacement card

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