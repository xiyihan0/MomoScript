# MomoScript Rust v2 core

`mmt_rs` contains the Rust DSL v2 parser, semantic pipeline, pack-v3 resolver,
Typst emitter, and native project-export CLI.

Composer structural commands are validated against a versioned document partition.
Message insertion can carry a pack avatar choice; the scoped actor declaration and
message are returned as one source edit. Media insertion accepts a declared image
asset, a workspace PNG/JPEG path, or a current-pack sticker set and ordinal.
Sticker `setId` can include its contribution namespace (`namespace::set`) to
retain exact provenance. Rust owns the resulting declarations and resource
markers. Message-side changes and
move-to-boundary commands preserve neighboring source and semantic identity;
teacher messages remain right-only, and moves cannot cross opaque partitions.
The document projection exposes declared `assetChoices` and authorized
`setSide`/`moveTargets` choices rather than asking clients to parse DSL text.

Local image assets may use sanitized workspace-relative paths, including
`assets/<uuid>.png`; absolute paths, traversal, empty segments, backslashes,
colons, and control characters are rejected. Native resolution also verifies
the canonical file remains under the workspace root. Render projections assign
pack and workspace resources distinct generated virtual paths from one allocator;
the authored workspace-relative path is retained only for filesystem lookup.

## Export a Typst project

```bash
cargo run --manifest-path mmt_rs/Cargo.toml --bin mmt-compile -- \
  --input examples/example.mmt.txt \
  --output-dir /tmp/mmt-project \
  --manifest /path/to/ba_kivo/manifest.json \
  --template-dir typst_sandbox/mmt_render

typst compile --root /tmp/mmt-project \
  /tmp/mmt-project/main.typ /tmp/mmt-project/output.pdf
```

Pack build workspaces are not tracked. Build the pack locally or download its
published manifest before passing that local path to `--manifest`.

Omit `--input` or pass `--input -` to read UTF-8 MMT source from stdin. The
command writes one JSON report to stdout and uses a non-zero exit code on
failure. Diagnostics include phase, severity, UTF-8 byte range, and one-based
line/column positions.

By default, the exporter copies the renderer to `template/` and emits the existing relative import, so the output remains self-contained. If `@local/mmt-render:0.1.0` is already installed under a Typst package root, pass `--use-local-template-package`; the exporter emits that package import and does not copy `template/`:

```bash
cargo run --manifest-path mmt_rs/Cargo.toml --bin mmt-compile -- \
  --input examples/example.mmt.txt \
  --output-dir /tmp/mmt-project \
  --use-local-template-package

typst compile --root /tmp/mmt-project \
  --package-path /path/to/.typst/packages \
  /tmp/mmt-project/main.typ /tmp/mmt-project/output.pdf
```

The package root must contain `local/mmt-render/0.1.0/typst.toml`. Package installation remains a host responsibility; the Rust emitter performs no filesystem package discovery.

The filesystem exporter supports workspace files, pack-v3 `image-dir` storage,
and AVIFS `image-sequence` storage. AVIFS frames are decoded to PNG through a
controlled `avifdec -c dav1d --index N` process, verified against manifest
SHA-256 and dimensions, and stored in a content-addressed cache. Set
`--cache-dir`, `--avifdec-bin`, or `--decoder-profile` to configure that host
backend. Remote downloads and temporary host assets still require a separate
host materializer.

The native AVIFS boundary uses libavif for container/frame/color/alpha handling
and dav1d for AV1 payload decoding. A future direct libavif FFI backend will
reuse the same cache and output contract.
