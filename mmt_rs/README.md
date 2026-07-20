# MomoScript Rust v2 core

`mmt_rs` contains the Rust DSL v2 parser, semantic pipeline, pack-v3 resolver,
Typst emitter, and native project-export CLI.

## Export a Typst project

```bash
cargo run --manifest-path mmt_rs/Cargo.toml --bin mmt-compile -- \
  --input examples/example.mmt.txt \
  --output-dir /tmp/mmt-project \
  --manifest typst_sandbox/pack-v3/ba_kivo/manifest.json \
  --template-dir typst_sandbox/mmt_render

typst compile --root /tmp/mmt-project \
  /tmp/mmt-project/main.typ /tmp/mmt-project/output.pdf
```

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
