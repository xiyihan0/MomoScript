export const PREVIEW_BENCHMARK_DOCUMENT_NAME = "synthetic-preview-performance.mmt";
export const PREVIEW_BENCHMARK_POSITIONS = ["START", "MIDDLE", "END"] as const;
export type PreviewBenchmarkPosition = typeof PREVIEW_BENCHMARK_POSITIONS[number];

const REAL_REPORT_LINE_COUNT = 973;

export interface GeneratedRealReportFixture {
  readonly source: string;
  readonly shape: {
    readonly lines: number;
    readonly lexicalTokens: number;
    readonly selectableRows: number;
    readonly repeatedImages: number;
  };
}

export function generatedRealReportFixture(): GeneratedRealReportFixture {
  const lines = [
    "@typ",
    "// Inherit the template's auto-height page.",
    "#set text(size: 8pt)",
    "PERF-START-A deterministic report marker. #linebreak()",
    'Synthetic selectable preview line #image("intro-assets/basic.png", width: 12pt) #linebreak()',
  ];
  let repeatedImages = 1;
  const selectableRows = REAL_REPORT_LINE_COUNT - 6;
  for (let index = 0; index < selectableRows - 1; index += 1) {
    const marker = index === Math.floor((selectableRows - 1) / 2) ? " PERF-MIDDLE-A" : "";
    const image = index % 96 === 0 ? ' #image("intro-assets/basic.png", width: 12pt)' : "";
    if (image) repeatedImages += 1;
    lines.push(`Row ${String(index).padStart(4, "0")} selectable token ${String(index).padStart(4, "0")}${marker}${image} #linebreak()`);
  }
  lines.push("PERF-END-A deterministic report marker. #linebreak()", "@end");
  const source = lines.join("\n");
  const bytes = Buffer.byteLength(source, "utf8");
  if (lines.length !== REAL_REPORT_LINE_COUNT || bytes < 40 * 1024 || bytes > 50 * 1024) {
    throw new Error(`generated report fixture must be ${REAL_REPORT_LINE_COUNT} lines and 40-50 KiB, received ${lines.length} lines / ${bytes} bytes`);
  }
  return {
    source,
    shape: {
      lines: lines.length,
      lexicalTokens: source.match(/[A-Za-z0-9_-]+/g)?.length ?? 0,
      selectableRows,
      repeatedImages,
    },
  };
}
