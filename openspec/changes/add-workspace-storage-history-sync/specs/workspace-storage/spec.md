# workspace-storage 规格增量

## ADDED Requirements

### Requirement: Workspace I/O has one coordinator and one active backend

The editor SHALL route every workspace mutation through one coordinator and SHALL treat exactly one active backend as the current-file source of truth.

#### Scenario: IndexedDB workspace is active

- GIVEN a workspace whose active backend is IndexedDB
- WHEN Monaco、Explorer、preview、history restore or a sync connector reads or changes a file
- THEN the operation MUST go through the same `mmtfs://workspace/` provider and coordinator
- AND the IndexedDB current-file store MUST be the only current-file source
- AND no inactive local directory or WebDAV endpoint MAY receive a mirror write

#### Scenario: Local directory workspace is active

- GIVEN a workspace whose active backend is a File System Access directory
- WHEN a file is read or changed
- THEN the selected directory MUST be the current-file source
- AND IndexedDB MUST contain only workspace metadata、history、heads、handles、journals and sync baselines for that backend
- AND loss of directory access MUST NOT silently activate an IndexedDB file copy

### Requirement: Logical workspaces have stable identities

Every logical workspace SHALL have an opaque stable `workspaceId` independent of storage and display names.

#### Scenario: Current workspace is copied to a local directory

- GIVEN an IndexedDB workspace with identity W
- WHEN the author completes an explicit、verified “copy current workspace to directory” migration
- THEN the resulting local-directory workspace MUST retain W
- AND its backend generation MUST advance exactly once
- AND changing the directory name later MUST NOT change W

#### Scenario: A directory is opened as a different workspace

- GIVEN workspace W is currently active
- WHEN the author chooses “open directory as new workspace” rather than migration
- THEN the editor MUST create a new workspace identity
- AND it MUST NOT infer identity from directory name、handle name or WebDAV URL

### Requirement: Existing workspace URI and persistence ordering remain compatible

The storage abstraction SHALL preserve the existing workspace authority、root and source-order persistence contract.

#### Scenario: Author edits a document rapidly

- GIVEN `/story.mmt` is open at `mmtfs://workspace/story.mmt`
- WHEN multiple text changes arrive before earlier persistence completes
- THEN the coordinator MUST serialize mutations for that workspace
- AND reload after the queue commits MUST reopen the latest text
- AND backend abstraction MUST NOT create a duplicate `/workspace` child directory

### Requirement: Version 1 data upgrades losslessly and resumably

Opening IndexedDB schema version 2 SHALL preserve every user entry from the existing version-1 `files` store and SHALL build a history baseline before normal writes are accepted.

#### Scenario: Existing browser profile opens version 2

- GIVEN version 1 contains files and directories with paths、types、ctime、mtime and bytes
- WHEN schema version 2 opens successfully
- THEN every non-compatibility entry MUST retain the same path、type、ctime、mtime and bytes
- AND a stable default workspace identity、history heads and one baseline revision MUST reference the migrated tree
- AND the historical empty `/workspace` compatibility directory MAY be removed only under the already-specified empty-subtree rule

#### Scenario: Upgrade is interrupted after a partial hash batch

- GIVEN the version-2 schema exists with a pending migration marker
- WHEN the page exits and later reopens
- THEN migration MUST resume from durable progress
- AND repeated work MUST be idempotent
- AND exactly one published baseline revision MUST result
- AND the original `files` entries MUST remain readable until final verification succeeds

#### Scenario: Upgrade cannot allocate history storage

- GIVEN v1 current files are intact
- WHEN quota、hashing or a transaction prevents completion
- THEN the editor MUST expose migration failure and a read-only recovery/export path
- AND it MUST NOT show an empty workspace
- AND it MUST NOT accept ordinary v2 mutations without history

### Requirement: Provider mutations and Local History commit consistently

Every successful provider mutation SHALL be represented in Local History with content-addressed before/after state and a reason.

#### Scenario: IndexedDB file write succeeds

- GIVEN the IndexedDB backend is active and the previous head is hash A
- WHEN a write of hash B commits
- THEN file bytes、blob B、history change and head B MUST commit atomically
- AND the provider MUST emit its file event only after that transaction commits

#### Scenario: IndexedDB transaction fails

- GIVEN a mutation would change hash A to B
- WHEN any store in the transaction fails
- THEN current bytes and history head MUST remain A
- AND no successful file-change event MAY be emitted

#### Scenario: Different mutation sources change the workspace

- GIVEN a file is edited、created、deleted、renamed、restored、imported、changed externally or pulled from WebDAV
- WHEN the coordinator accepts the mutation
- THEN its history revision MUST identify the corresponding reason
- AND delete/rename revisions MUST retain enough before state to restore affected files

### Requirement: High-frequency edits are bounded without losing recovery boundaries

The history layer MAY coalesce adjacent ordinary edits but SHALL preserve the first before-state、latest after-state and all destructive or externally sourced boundaries.

#### Scenario: Author types continuously in one file

- GIVEN repeated `edit` writes target the same path
- WHEN they fall within the configured edit-group window
- THEN history MAY update one mutable edit revision
- AND that revision MUST retain the first `beforeHash` and latest `afterHash`
- AND the group MUST eventually close after idle time or a maximum duration

#### Scenario: Delete follows typing

- GIVEN an edit group is open
- WHEN delete、rename、restore、import、external-change、WebDAV pull、named checkpoint or backend migration begins
- THEN the edit group MUST close first
- AND the new operation MUST receive a distinct revision

### Requirement: Restoring history creates history

A restore SHALL create a new current state without rewriting or moving prior revisions.

#### Scenario: Author restores an older file version

- GIVEN a file has current hash C and historical hash A
- WHEN the author confirms restore of A
- THEN the coordinator MUST checkpoint C before applying A
- AND it MUST write A through the active backend
- AND it MUST create a new `restore` revision
- AND both the selected old revision and pre-restore checkpoint MUST remain available

### Requirement: Local History actions reflect their scope

The Local History UI SHALL distinguish direct single-file actions from workspace-wide transitions and SHALL keep open authored views synchronized with a completed restore.

#### Scenario: One edit revision changes one file

- GIVEN an `edit` revision changes exactly one workspace file
- WHEN the timeline renders that revision
- THEN its primary label MUST identify the file as `编辑 <workspace-relative-path>`
- AND activating the revision MUST open that file's native Diff directly
- AND its restore action MUST restore only that file rather than the whole workspace

#### Scenario: Restored content is open in the editor

- GIVEN a restored text file is open and drives a preview
- WHEN the file or workspace restore commits
- THEN the open document MUST synchronize to the restored persistent bytes
- AND the preview MUST advance to the restored content before the UI reports a stable restored state

#### Scenario: A workspace has more revisions than one timeline page

- GIVEN more than 50 revisions match the selected file/workspace scope and reason filter
- WHEN the timeline opens and the author loads earlier records
- THEN the backend MUST use its revision/time indexes and a stable cursor rather than scanning and inflating the whole history
- AND the UI MUST append the next page without duplicating or reordering revisions

#### Scenario: Author manages a named Checkpoint

- GIVEN a named Checkpoint protects a historical snapshot
- WHEN the author renames or explicitly deletes it
- THEN the timeline and protected-byte/count status MUST update without changing the represented file snapshot
- AND deleting it MUST remove its protection and history row, except that a current head MAY remain as a non-Checkpoint recovery root
- AND clearing ordinary edit history MUST preserve named Checkpoints、current state and structural recovery roots

#### Scenario: A historical change is deleted or binary

- GIVEN a revision deletes a file or records bytes that are not text
- WHEN the author inspects that change
- THEN a deletion MUST offer its before-state for inspection and confirmed whole-file restore
- AND binary content MUST show media type、byte size and SHA-256 metadata
- AND binary content MUST offer export and confirmed whole-file restore without opening a text Diff

### Requirement: Retention claims reflect active production behavior

The Local History UI SHALL report measured file-content usage together with the exact retention policy enforced by the production IndexedDB backend.

#### Scenario: Production history retention is enabled

- GIVEN the version-3 production IndexedDB history backend is active
- WHEN the history footer reports usage
- THEN it MUST show measured SHA-256 blob bytes against the 50 MiB budget、the 30-day edit retention period、Checkpoint count and protected Checkpoint bytes
- AND GC MUST remove expired or oldest eligible ordinary edits and unreferenced blobs without deleting current workspace bytes
- AND quota overflow caused only by protected/current state MUST publish an accessible quota-blocked state and block subsequent unrecorded mutations rather than deleting current content


### Requirement: History retention is byte-bounded and protects recovery roots

History GC SHALL enforce a visible byte budget while retaining every blob required for active state、pending recovery、sync safety and pinned checkpoints.

#### Scenario: Ordinary history exceeds its budget

- GIVEN unpinned old edit revisions and unreachable blobs exceed the configured limit
- WHEN GC runs
- THEN unreachable blobs and oldest eligible edit revisions MAY be removed
- AND current heads、last-observed local-directory heads、pending/conflict journal blobs、sync baselines and user-pinned checkpoints MUST NOT be removed

#### Scenario: Pinned state alone exceeds the budget

- GIVEN protected blobs are larger than the configured budget
- WHEN another safe mutation requires history space
- THEN the editor MUST show actual usage and a quota/history-blocked state
- AND it MUST NOT silently perform an unrecorded provider mutation
- AND it MUST describe which protected categories prevent GC

### Requirement: Workspace storage participates in origin-wide quota coordination

Workspace storage SHALL report protected、history-policy-managed and reclaimable bytes to the shared origin storage coordinator and SHALL retain ownership of
all user/history deletion policy.

#### Scenario: PWA shell or pack requests staging space

- GIVEN origin storage contains workspace current files、pinned heads/checkpoints、ordinary history、journal/sync safety data and reproducible caches
- WHEN `OriginStorageCoordinator` evaluates a shell or pack reservation
- THEN workspace storage MUST report current and recovery-critical bytes as protected
- AND ordinary unpinned history MUST be reported separately as history-policy-managed rather than PWA-reclaimable
- AND shell/pack code MUST NOT delete history or invoke History GC to make its download fit
- AND insufficient space MUST reject or resize the reproducible-cache operation rather than consume workspace protected bytes

#### Scenario: Workspace is blocked or unreconciled

- GIVEN workspace state is migration-failed、quota/history-blocked、history-degraded + unreconciled or pending/conflict journal
- WHEN a shell/pack staging or update-activation reservation is requested
- THEN workspace storage MUST expose that state as a hard gate
- AND the external operation MUST NOT proceed
- AND after recovery it MUST request a fresh inventory/reservation rather than reuse a previous estimate

### Requirement: Local directory permission loss is explicit

The File System Access backend SHALL request permission only from a user gesture and SHALL never hide an unavailable active backend by switching storage.

#### Scenario: Stored directory handle needs permission after reload

- GIVEN the active directory handle returns `prompt` from `queryPermission`
- WHEN the page starts
- THEN the editor MUST display a reauthorization action
- AND it MUST call `requestPermission` only after the author activates that action
- AND it MUST NOT create or activate an IndexedDB fallback workspace

#### Scenario: Permission is denied while a document is open

- GIVEN the local-directory backend becomes unavailable
- WHEN Monaco still contains authored text
- THEN the editor MAY retain that model and its dirty state in memory
- BUT persistent writes MUST fail visibly
- AND available actions MUST distinguish reauthorize、export current memory and explicitly migrate the last known history snapshot

### Requirement: Local directory mutations use a durable journal

Every File System Access mutation SHALL durably record before and intended-after state before changing disk and SHALL verify disk before publishing success.

#### Scenario: Local file write completes normally

- GIVEN the current disk/hash head is A
- WHEN the coordinator writes B
- THEN a pending journal referencing A and B MUST commit before disk I/O
- AND disk MUST be read and hashed as B after the writable stream closes
- AND revision/head B and committed journal state MUST commit before provider events fire

#### Scenario: Startup finds disk equal to intended-after state

- GIVEN a pending journal records A → B and the page previously exited before history finalization
- WHEN recovery hashes the complete affected path set as B
- THEN it MUST finish the revision and heads idempotently
- AND mark the journal committed

#### Scenario: Startup finds disk equal to before state

- GIVEN a pending journal records A → B but disk is still A
- WHEN recovery runs
- THEN it MUST mark the operation aborted
- AND preserve intended B for an explicit retry or discard decision
- AND it MUST NOT claim the write succeeded

#### Scenario: Startup finds a mixed or third state

- GIVEN a journal records a complete before and intended-after path set
- WHEN actual disk matches neither set
- THEN recovery MUST capture the observed state when quota permits
- AND mark a conflict
- AND it MUST NOT automatically overwrite before、intended or observed content

### Requirement: External directory changes preserve disk truth and history status

Changes made outside the editor SHALL normally enter an `external-change` revision before cache/event publication; the sole storage-failure exception SHALL expose
the active directory truth as explicitly unreconciled rather than hiding it or claiming complete history.

#### Scenario: Page regains focus after an external edit

- GIVEN a local directory file changed while the page was hidden
- WHEN focus/visibility rescan finds a stable new hash
- THEN history MUST retain the previous head and the newly observed bytes
- AND an `external-change` revision and updated head MUST commit before VS Code receives the change event
- AND preview MUST rebuild from the observed current file

#### Scenario: External file was deleted

- GIVEN the last observed head pins the deleted file blob
- WHEN rescan confirms the path is absent
- THEN the external-change revision MUST record the deletion
- AND Local History MUST still be able to restore the previous bytes

#### Scenario: History persistence fails after a stable external observation

- GIVEN the local directory changed from durable head A to a stable observed state B
- AND quota exhaustion、IndexedDB transaction abort、storage I/O error or another history-persistence failure prevents recording B
- WHEN reconciliation handles that failure
- THEN provider reads、cache、file events and preview MUST expose B because the active directory is the current-file truth
- AND the durable history head A MUST remain pinned and unchanged
- AND workspace status MUST become `history-degraded` and `unreconciled` without claiming B has a complete revision
- AND the UI MUST distinguish quota-blocked、retryable transaction/I/O and persistent-unavailable classes and identify whether retry is safe
- AND ordinary coordinator mutations MUST be blocked while capacity cleanup、history retry、export and recovery remain available
- AND retry MUST rescan the directory and use its latest stable observation rather than stale B
- AND after history persistence recovers the coordinator MUST append one idempotent delayed `external-change` from A to the latest observed state before clearing degraded status
- AND the UI MUST warn that intermediate external versions during the degraded interval are not recoverable

#### Scenario: Scanner cannot establish a stable snapshot

- GIVEN the directory keeps changing during a rescan
- WHEN the bounded retry policy is exhausted
- THEN the provider MUST report a continuously-changing directory
- AND it MUST NOT publish a mixed snapshot as current

### Requirement: Backend switching is explicit and verified

A backend migration SHALL plan conflicts、checkpoint current state、verify target bytes and switch active backend only after successful completion.

#### Scenario: Target directory contains colliding files

- GIVEN the author chooses to copy the current workspace to a non-empty directory
- WHEN exact-path、case-folding or unsupported-path collisions are found
- THEN the editor MUST show the per-path overwrite/skip/cancel plan
- AND the default action MUST NOT overwrite target files

#### Scenario: Migration fails midway

- GIVEN the old backend is active at generation N
- WHEN target writing or hash verification fails
- THEN the old backend MUST remain active at generation N
- AND no background mirror writes MAY continue to the partial target
- AND the journal/checkpoint MUST make recovery or cleanup explicit

#### Scenario: Migration succeeds

- GIVEN every accepted target file verifies
- WHEN backend metadata commits
- THEN active backend MUST switch once at generation N+1
- AND reads MUST be verified through the newly bound provider
- AND the retired backend MUST stop receiving current-file writes

### Requirement: A workspace has at most one browser writer

The Web editor SHALL acquire a workspace-scoped writer lease before accepting persistent mutations.

#### Scenario: A second tab opens the same workspace

- GIVEN another live page holds the writer lease for workspace W
- WHEN a second page opens W
- THEN the second page MUST open read-only or wait visibly
- AND it MUST NOT persist mutations concurrently
- AND the shell MUST display a persistent warning status and an actionable notification while the page remains read-only
- AND takeover MUST require an explicit author action rather than an automatic timeout

### Requirement: Unsupported browsers retain the IndexedDB workflow

File System Access SHALL be an optional backend rather than a prerequisite for the Web editor.

#### Scenario: Browser has no directory picker

- GIVEN `showDirectoryPicker` is unavailable
- WHEN the author opens the editor
- THEN IndexedDB workspace、Local History and reload persistence MUST remain available
- AND local-directory commands MUST be hidden or clearly marked unsupported
- AND the editor MUST NOT substitute an upload/download loop and call it a mounted directory

### Requirement: WebDAV is a connector over the active workspace

WebDAV synchronization SHALL read and mutate files through the coordinator and SHALL never synchronize implementation storage or become an implicit active backend.

#### Scenario: Author previews a manual sync

- GIVEN a configured connector and an available active backend
- WHEN the author requests sync preview
- THEN the coordinator MUST flush edit groups、rescan current files and create a sync checkpoint before remote mutation
- AND the plan MUST compare current local hashes、last sync baselines and remote validators
- AND no accepted pull/push/delete MAY bypass the provider and Local History

#### Scenario: Remote listing fails or is empty unexpectedly

- GIVEN authentication、CORS、network、redirect or response validation fails
- WHEN WebDAV listing cannot establish a trustworthy remote tree
- THEN sync MUST stop with a visible error
- AND it MUST NOT interpret the response as deletion of the local workspace
- AND language service and current preview MUST remain usable

### Requirement: WebDAV writes are conditional and conflicts preserve both sides

The connector SHALL use server validators for destructive remote operations and SHALL preserve local and remote content on concurrent change.

#### Scenario: Remote ETag changed before PUT

- GIVEN the sync plan was based on remote ETag E1
- WHEN conditional PUT or DELETE returns 412、409 or a different validator
- THEN the operation MUST become a conflict
- AND neither local current content nor remote content MAY be silently overwritten
- AND the sync baseline MUST remain at the last verified state

#### Scenario: Both local and remote text changed

- GIVEN both sides differ from the last sync baseline
- WHEN the author runs first-version manual sync
- THEN the connector MUST keep the local path unchanged
- AND import the remote bytes through the coordinator as a safely named conflict copy
- AND open or offer a Diff for explicit resolution
- AND it MUST NOT perform an automatic text merge

#### Scenario: Server provides no reliable validator

- GIVEN WebDAV listing does not provide a usable ETag or equivalent safe condition
- WHEN sync plans overwrite or delete of an existing remote path
- THEN the connector MUST identify the endpoint as conflict-unsafe
- AND destructive push MUST default to disabled
- AND any force operation MUST be confirmed per plan and MUST NOT be described as conflict-safe

### Requirement: WebDAV configuration protects credentials and internal state

Connector configuration SHALL separate non-secret endpoint metadata from credentials and SHALL exclude runtime/cache/history data from sync.

#### Scenario: Browser saves a WebDAV profile

- GIVEN the author supplies an endpoint and credential
- WHEN the profile is persisted
- THEN URL userinfo MUST be rejected
- AND the endpoint MUST use HTTPS except an explicit loopback development case
- AND plaintext password/token MUST NOT be written to the workspace IndexedDB database
- AND redirect origin/root changes MUST require validation rather than inheriting authorization blindly

#### Scenario: Workspace sync enumerates content

- GIVEN workspace files coexist with pack cache、WASM、fonts、history、journals、handles and preview artifacts
- WHEN the connector creates a remote plan
- THEN only user workspace entries exposed by the provider MAY appear
- AND implementation stores and runtime caches MUST NOT be uploaded

### Requirement: Storage state and destructive actions are visible

The Web editor SHALL expose active backend、permission、history、journal、writer lease and sync state, and SHALL require explicit actions for destructive transitions.

#### Scenario: Workspace has a blocked or degraded storage state

- GIVEN permission loss、quota exhaustion、pending journal、migration failure、writer contention or WebDAV conflict exists
- WHEN the author views workspace status
- THEN the UI MUST identify the affected workspace and state
- AND offer only actions valid for that state
- AND it MUST NOT report the workspace as fully saved or synchronized

#### Scenario: Author clears history or forces a transition

- GIVEN an action would clear protected history、switch backend、force remote overwrite or discard pending recovery
- WHEN the author invokes the action
- THEN the UI MUST show the affected paths/state and require explicit confirmation
- AND completion MUST be verified before the success state is shown
