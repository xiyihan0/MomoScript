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
