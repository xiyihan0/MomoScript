# Preview compilation benchmark results

Date: 2026-07-29  
Host: AMD Ryzen 9 7945HX, Linux WSL2, local Chromium, one Playwright worker  
Fixture: deterministic generated MMT; mixed DSL messages and raw Typst, one workspace image, two rendered pages, no user-authored source.

The clean oracle used `VITE_MMT_PREVIEW_INCREMENTAL=0`. The candidate used `VITE_MMT_PREVIEW_INCREMENTAL=1`, enabling digest deltas, the stable compiler mount, event-driven workspace mirroring, shared projection/render-project caches, and the latest-wins scheduler. Each warm result contains 21 one-character edits cycling through start, middle, and end positions. Values are milliseconds.
## Real-report presentation profile

A separate non-committed user-authored report measured 42,635 bytes, 973 lines, and one very tall rendered page. A one-character warm edit reached visual-ready in approximately 6.24 s. Native DOM update, eager source-location geometry, and repeated image re-inlining contributed roughly 64% of visual-ready time; Rust analysis remained below 0.4%. This profile is the evidence for activating the persistent renderer phase.

The committed E2E fixture now generates the same deterministic shape without copied authored content: 973 lines, 40–50 KiB, one auto-height page, 967 selectable rows, repeated references to one workspace image, and start/middle/end edit markers. The report records lexical-token count plus rendered SVG-node, selectable-span, image-node, and page-shell counts so cold/oracle and incremental runs compare the same order of document complexity.

## Cold-open samples

### Small — 899 bytes / 19 lines

| Stage | Clean | Candidate | Change |
|---|---:|---:|---:|
| Rust semantic | 4.0 | 4.0 | +0.0% latency |
| Rust emit | 9.0 | 5.0 | -44.4% latency |
| Rust index/digest | 1.0 | 1.0 | +0.0% latency |
| Project delivery | 25.7 | 23.4 | -8.9% latency |
| Workspace mirror | 76.0 | 65.1 | -14.3% latency |
| Materialization | 0.5 | 0.6 | +20.0% latency |
| Shadow update | 853.6 | 1493.8 | +75.0% latency |
| Typst compile/debug SVG | 204.0 | 175.4 | -14.0% latency |
| SVG parse/sanitize | 11.7 | 10.1 | -13.7% latency |
| DOM update | 737.7 | 592.3 | -19.7% latency |
| Location measure | 410.4 | 357.0 | -13.0% latency |
| Visual ready | 2826.1 | 3562.4 | +26.1% latency |

### Medium — 15409 bytes / 204 lines

| Stage | Clean | Candidate | Change |
|---|---:|---:|---:|
| Rust semantic | 5.0 | 4.0 | -20.0% latency |
| Rust emit | 6.0 | 6.0 | +0.0% latency |
| Rust index/digest | 1.0 | 2.0 | +100.0% latency |
| Project delivery | 34.0 | 30.6 | -10.0% latency |
| Workspace mirror | 65.6 | 74.4 | +13.4% latency |
| Materialization | 1.1 | 0.6 | -45.5% latency |
| Shadow update | 850.2 | 791.9 | -6.9% latency |
| Typst compile/debug SVG | 196.1 | 185.7 | -5.3% latency |
| SVG parse/sanitize | 12.8 | 12.2 | -4.7% latency |
| DOM update | 774.2 | 777.3 | +0.4% latency |
| Location measure | 575.7 | 555.9 | -3.4% latency |
| Visual ready | 3005.2 | 2884.0 | -4.0% latency |

### Large — 44643 bytes / 579 lines

| Stage | Clean | Candidate | Change |
|---|---:|---:|---:|
| Rust semantic | 5.0 | 6.0 | +20.0% latency |
| Rust emit | 7.0 | 8.0 | +14.3% latency |
| Rust index/digest | 2.0 | 1.0 | -50.0% latency |
| Project delivery | 46.7 | 33.8 | -27.6% latency |
| Workspace mirror | 73.9 | 88.2 | +19.4% latency |
| Materialization | 0.7 | 1.8 | +157.1% latency |
| Shadow update | 788.4 | 749.2 | -5.0% latency |
| Typst compile/debug SVG | 224.2 | 243.2 | +8.5% latency |
| SVG parse/sanitize | 20.1 | 21.9 | +9.0% latency |
| DOM update | 1297.7 | 1257.8 | -3.1% latency |
| Location measure | 932.3 | 925.6 | -0.7% latency |
| Visual ready | 3931.4 | 3804.6 | -3.2% latency |

## Warm p50/p95 by fixture

### Small — 899 bytes / 19 lines

| Stage | Clean p50 | Candidate p50 | Change | Clean p95 | Candidate p95 | Change |
|---|---:|---:|---:|---:|---:|---:|
| Rust semantic | 0.0 | 0.0 | n/a latency | 0.0 | 0.0 | n/a latency |
| Rust emit | 0.0 | 0.0 | n/a latency | 1.0 | 1.0 | +0.0% latency |
| Rust index/digest | 1.0 | 1.0 | +0.0% latency | 2.0 | 2.0 | +0.0% latency |
| Project delivery | 10.8 | 2.5 | -76.9% latency | 12.9 | 8.0 | -38.0% latency |
| Workspace mirror | 29.0 | 0.1 | -99.7% latency | 37.2 | 0.2 | -99.5% latency |
| Materialization | 0.2 | 0.1 | -50.0% latency | 6.1 | 0.2 | -96.7% latency |
| Shadow update | 2.5 | 0.1 | -96.0% latency | 4.0 | 0.2 | -95.0% latency |
| Typst compile/debug SVG | 5.8 | 3.8 | -34.5% latency | 7.7 | 7.6 | -1.3% latency |
| SVG parse/sanitize | 5.6 | 4.9 | -12.5% latency | 8.9 | 7.9 | -11.2% latency |
| DOM update | 63.2 | 65.3 | +3.3% latency | 72.7 | 83.0 | +14.2% latency |
| Location measure | 276.7 | 284.6 | +2.9% latency | 299.8 | 304.8 | +1.7% latency |
| Visual ready | 409.5 | 374.5 | -8.5% latency | 435.5 | 422.4 | -3.0% latency |

Median render-project payload: 164,165 B → 2,852 B. Warm shadow operations: mapped 1, skipped 23, unmapped 0.

### Medium — 15409 bytes / 204 lines

| Stage | Clean p50 | Candidate p50 | Change | Clean p95 | Candidate p95 | Change |
|---|---:|---:|---:|---:|---:|---:|
| Rust semantic | 0.0 | 0.0 | n/a latency | 1.0 | 0.0 | -100.0% latency |
| Rust emit | 1.0 | 0.0 | -100.0% latency | 1.0 | 2.0 | +100.0% latency |
| Rust index/digest | 1.0 | 1.0 | +0.0% latency | 2.0 | 2.0 | +0.0% latency |
| Project delivery | 12.0 | 3.9 | -67.5% latency | 14.9 | 11.0 | -26.2% latency |
| Workspace mirror | 36.9 | 0.1 | -99.7% latency | 47.4 | 0.2 | -99.6% latency |
| Materialization | 0.4 | 0.1 | -75.0% latency | 7.6 | 0.1 | -98.7% latency |
| Shadow update | 2.6 | 0.2 | -92.3% latency | 4.8 | 0.3 | -93.8% latency |
| Typst compile/debug SVG | 8.1 | 4.0 | -50.6% latency | 13.0 | 7.7 | -40.8% latency |
| SVG parse/sanitize | 8.3 | 6.6 | -20.5% latency | 15.8 | 9.1 | -42.4% latency |
| DOM update | 78.4 | 79.7 | +1.7% latency | 241.2 | 252.9 | +4.9% latency |
| Location measure | 462.1 | 466.7 | +1.0% latency | 492.9 | 487.9 | -1.0% latency |
| Visual ready | 627.6 | 584.6 | -6.9% latency | 822.2 | 756.9 | -7.9% latency |

Median render-project payload: 178,984 B → 17,649 B. Warm shadow operations: mapped 1, skipped 23, unmapped 0.

### Large — 44643 bytes / 579 lines

| Stage | Clean p50 | Candidate p50 | Change | Clean p95 | Candidate p95 | Change |
|---|---:|---:|---:|---:|---:|---:|
| Rust semantic | 0.0 | 0.0 | n/a latency | 0.0 | 1.0 | n/a latency |
| Rust emit | 2.0 | 1.0 | -50.0% latency | 3.0 | 2.0 | -33.3% latency |
| Rust index/digest | 2.0 | 2.0 | +0.0% latency | 3.0 | 3.0 | +0.0% latency |
| Project delivery | 13.5 | 8.9 | -34.1% latency | 16.8 | 23.9 | +42.3% latency |
| Workspace mirror | 58.6 | 0.1 | -99.8% latency | 76.2 | 0.2 | -99.7% latency |
| Materialization | 1.0 | 0.1 | -90.0% latency | 12.1 | 0.2 | -98.3% latency |
| Shadow update | 2.9 | 0.2 | -93.1% latency | 3.9 | 0.4 | -89.7% latency |
| Typst compile/debug SVG | 11.0 | 5.6 | -49.1% latency | 15.5 | 12.3 | -20.6% latency |
| SVG parse/sanitize | 11.1 | 9.9 | -10.8% latency | 20.7 | 19.3 | -6.8% latency |
| DOM update | 104.1 | 114.2 | +9.7% latency | 284.6 | 260.1 | -8.6% latency |
| Location measure | 880.8 | 864.5 | -1.9% latency | 1010.3 | 889.0 | -12.0% latency |
| Visual ready | 1116.0 | 1032.0 | -7.5% latency | 1288.0 | 1184.8 | -8.0% latency |

Median render-project payload: 208,599 B → 47,418 B. Warm shadow operations: mapped 1, skipped 23, unmapped 0.

## Correctness and boundedness

- 20 Hz burst: 6 admitted traces; 5 stale traces discarded; exactly source version 42 published.
- 500-edit soak: 1 timing sample retained after reset, 1 preview project, 1 latest project, 24 immutable artifacts / 4,015,825 bytes, 24 mapped shadows, 0 pending materializations, and at most 1 active materialization.
- Full/delta snapshot reconstruction, immutable artifact navigation, exact export, resource limits, and Desktop/Web request-notification parity are hard gates in focused contract suites. The final default-path Chromium run passed all preview-interaction and exact-export scenarios.

## Initial compilation-only promotion decisions

- **Event-driven resource reuse: promoted.** Workspace mirror warm p50 is 0.1 ms for every candidate fixture, versus 29.0–58.6 ms for the clean oracle; p95 reduction is at least 99.2%.
- **Latest-wins scheduler: promoted.** The burst published only the newest version and the soak stayed within every configured bound.
- **Compilation-only stable compiler mount and render delta: not promoted by this baseline.** Typst compile p50 improved 34.5%, 50.6%, and 49.1% for small/medium/large; small and large remained below the required 50%. Large p95 improved 20.6%, below the required 35%. Total visual-ready p50 improved only 6.9–8.5%, below 30%. This decision predates and is superseded by the persistent renderer qualification below.
- **Incremental Rust parser/semantic frontend: skipped.** Full parse/semantic/resolve is 0 ms p50 for every warm fixture and at most 1 ms p95. The remaining Rust emission/index work is 1–4 ms p50 and below 0.4% of visual-ready latency. Parser islands and semantic checkpoints cannot materially close the missed end-to-end target; the clean full parser remains the permanent path.
- **Tinymist `diff-v1`: unavailable at this baseline.** Unpatched Tinymist 0.15.2 exposed no qualified `diff-v1` producer preserving selectable text, debug locations, page identity, and immutable-artifact navigation. The subsequent pinned producer patch and qualification below supersede this result.

## Recorded failures and corrections

- The first 44 KiB fixture rendered hundreds of pages and measured 95,161.6 ms cold visual-ready, including 47,416.3 ms DOM update and 43,664.0 ms location measurement. It tested DOM volume rather than edit compilation. The fixture was corrected to retain 40–50 KiB of mixed DSL/raw Typst input while bounding output to two representative pages.
- Running four exact exports inside the performance scenario exceeded its 20-minute timeout while waiting for a download. Export is not a timing plane, so it was removed from the benchmark; exact export remains a separate hard regression gate.


## Persistent renderer qualification

Date: 2026-07-30  
Host: AMD Ryzen 9 7945HX, Linux WSL2, local Chromium, one Playwright worker  
Fixture: 43,299 bytes, 973 lines, 5,896 lexical tokens, 967 selectable rows, 12 repeated workspace-image references, and one tall rendered page.  
Run: 20 warm one-character edits cycling through start, middle, and end, followed by the 20 Hz burst and 500-edit soak. Each pre-edit viewport was centered, allowed to pass its 120 ms idle boundary, and flushed before the non-overlapping edit-to-painted-visual-ready interval began.

Command:

```sh
MMT_PREVIEW_BENCHMARK_MODE=qualification \
MMT_PREVIEW_REPORT_DIR=.tmp/preview-performance/qualification-final \
MMT_PREVIEW_STRESS=1 \
MMT_PREVIEW_WARM_EDITS=20 \
npx playwright test --project=local e2e/preview-performance.spec.ts --grep "large warm preview edits"
```

Report SHA-256: `2f3a4065a65ff504e552df315d2e9410024c90fe5cc1f146c4bdf2dfd12ae03f`

### Warm latency

| Metric | Full-SVG oracle p50 | Renderer p50 | Reduction | Full-SVG oracle p95 | Renderer p95 | Reduction |
|---|---:|---:|---:|---:|---:|---:|
| Total visual-ready | 33,875.9 ms | 345.8 ms | 98.98% | 36,154.9 ms | 384.6 ms | 98.94% |
| Chromium `Performance.TaskDuration` | 36,689.3 ms | 573.0 ms | 98.44% | 39,194.2 ms | 710.1 ms | 98.19% |

The renderer passed the relative total visual-ready gates (at least 35% p50 and 25% p95 reduction), the 70% p50 TaskDuration reduction gate, and the absolute 1,200 ms p50 / 2,500 ms p95 gates. Median renderer node reuse was 99.90%.

### Differential and boundedness gates

- All 20 start/middle/end samples matched artifact identity, rounded page geometry, selectable-text identity, decoded workspace-image identity, authored navigation identity, and actual 400×620 composited Webview pixels. The raster comparator observed at most 69 differing anti-aliased pixels within its 124-pixel budget, a maximum channel delta of 48 within 64, and mean absolute channel delta 0.002363 within 0.01; no differential comparison failed.
- Warm samples performed zero eager source queries and zero full-oracle fallbacks. Maximum queue depth and populated page buffers were both 1.
- The recorded producer chain was full frame generation/base `1/0`, warm diff frames `2/1` through `21/20`, the burst publication `22/21`, and the soak publication `23/22`. The E2E gate asserts frame kind, generation, and base generation for every emitted frame.
- The 20 Hz burst discarded one coalesced stale trace and published only final source version 42; it published no stale visual.
- The 500-edit soak reached visual-ready in 194.9 ms. Chromium JS heap was 216,353,964 bytes within 256 MiB. Retained state was one timing sample, one preview project, one latest project, 23 immutable artifacts / 1,313,659 bytes, zero pending materializations, and one active materialization.
- Native/Web producer transcripts, renderer session contracts, restart/resync, selectable text, bidirectional navigation, overlays, zoom/scroll, exact SVG/PNG/JPG/PDF export, resource limits, offline delivery, and the complete local Chromium suite passed before qualification.

### Final promotion decision

- **Pinned Tinymist `new`/`diff-v1` persistent rendering: promoted.** The visible Webview is the sole preview DOM/viewport owner and the qualified renderer is the ordinary publication path. The sanitized full-SVG path remains only as the explicit oracle/recovery path.
- **Incremental Rust parser/semantic frontend: still skipped.** Rust frontend work remains immaterial relative to the eliminated presentation cost, so the full parser remains the simpler permanent path.