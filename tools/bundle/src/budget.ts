import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the browser downloads before the editor is usable, measured rather than assumed.
 *
 * The sprint plan asks for a Lighthouse audit. This is not Lighthouse — Lighthouse scores a page
 * rendered in a real browser over a simulated network, and most of what it reports is about a
 * document this app does not have (it is one div). What it would tell us that matters here is the
 * transfer size of the critical path, and that is a fact about the build output, so it is measured
 * from the build output where it can be checked deterministically in CI instead of eyeballed once.
 *
 * The distinction the whole file turns on is **initial versus lazy**. A 2 MB physics engine behind
 * a dynamic import costs a user nothing until they press Play. The same 2 MB in the entry chunk is
 * two megabytes every visitor downloads to look at a project list. Only the first number is a
 * budget worth defending, and a tool that adds up `dist/` and reports one total cannot tell them
 * apart — which is how "our bundle is 4 MB" becomes a sentence nobody can act on.
 */

/** Vite's manifest, narrowed to the fields this needs. */
interface ManifestEntry {
  file: string;
  isEntry?: boolean;
  css?: string[];
  /** Chunks pulled in by a static `import` — part of the critical path. */
  imports?: string[];
  /** Chunks behind a dynamic `import()` — not downloaded until something asks. */
  dynamicImports?: string[];
}

export interface Budget {
  /** Gzipped bytes of JavaScript on the critical path. */
  initialJs: number;
  /** Gzipped bytes of CSS on the critical path. */
  initialCss: number;
  /** Gzipped bytes of the largest single lazy chunk, so one of them cannot quietly become huge. */
  largestLazyChunk: number;
}

export interface Measured {
  initialJs: number;
  initialCss: number;
  largestLazyChunk: number;
  /** Every chunk, so a report can show where the bytes went rather than only that there are many. */
  chunks: { file: string; gzip: number; initial: boolean }[];
}

/** Gzip, because that is what crosses the network. Raw size is a fact about nobody's experience. */
export function gzipped(bytes: Buffer): number {
  return gzipSync(bytes, { level: 9 }).length;
}

/**
 * Walks the manifest from the entry through static imports only.
 *
 * Transitive: a chunk statically imported by a chunk statically imported by the entry is still
 * downloaded before first paint. Stopping at depth one would produce a flattering number and a
 * budget that passes while the page gets slower.
 */
export function criticalPath(manifest: Record<string, ManifestEntry>): Set<string> {
  const reached = new Set<string>();
  const queue = Object.keys(manifest).filter((key) => manifest[key]?.isEntry);

  while (queue.length > 0) {
    const key = queue.pop()!;
    if (reached.has(key)) continue;
    reached.add(key);
    // Only `imports`. `dynamicImports` is deliberately not followed — that is the whole point.
    for (const next of manifest[key]?.imports ?? []) queue.push(next);
  }

  return reached;
}

export function measure(distDir: string): Measured {
  const manifest = JSON.parse(
    readFileSync(join(distDir, '.vite', 'manifest.json'), 'utf8'),
  ) as Record<string, ManifestEntry>;

  const critical = criticalPath(manifest);

  let initialJs = 0;
  let initialCss = 0;
  let largestLazyChunk = 0;
  const chunks: Measured['chunks'] = [];
  const countedCss = new Set<string>();

  for (const [key, entry] of Object.entries(manifest)) {
    const initial = critical.has(key);
    const size = gzipped(readFileSync(join(distDir, entry.file)));
    chunks.push({ file: entry.file, gzip: size, initial });

    if (initial) initialJs += size;
    else largestLazyChunk = Math.max(largestLazyChunk, size);

    // A chunk's CSS is fetched with it, and several chunks can name the same stylesheet — counting
    // it once per reference would invent bytes the browser never transfers.
    for (const css of entry.css ?? []) {
      if (countedCss.has(css) || !initial) continue;
      countedCss.add(css);
      initialCss += gzipped(readFileSync(join(distDir, css)));
    }
  }

  chunks.sort((a, b) => b.gzip - a.gzip);
  return { initialJs, initialCss, largestLazyChunk, chunks };
}

export interface BudgetResult {
  measured: Measured;
  budget: Budget;
  over: string[];
}

export function checkBudget(measured: Measured, budget: Budget): BudgetResult {
  const over: string[] = [];
  const kib = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KiB`;

  if (measured.initialJs > budget.initialJs) {
    over.push(`initial JS ${kib(measured.initialJs)} over the ${kib(budget.initialJs)} budget`);
  }
  if (measured.initialCss > budget.initialCss) {
    over.push(`initial CSS ${kib(measured.initialCss)} over the ${kib(budget.initialCss)} budget`);
  }
  if (measured.largestLazyChunk > budget.largestLazyChunk) {
    over.push(
      `largest lazy chunk ${kib(measured.largestLazyChunk)} over the ` +
        `${kib(budget.largestLazyChunk)} budget`,
    );
  }

  return { measured, budget, over };
}

export function formatResult(result: BudgetResult): string {
  const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1).padStart(7)} KiB`;
  const lines = [
    `  initial JS         ${kib(result.measured.initialJs)}   budget ${kib(result.budget.initialJs)}`,
    `  initial CSS        ${kib(result.measured.initialCss)}   budget ${kib(result.budget.initialCss)}`,
    `  largest lazy chunk ${kib(result.measured.largestLazyChunk)}   budget ${kib(result.budget.largestLazyChunk)}`,
    '',
    '  chunks, gzipped, largest first:',
  ];

  for (const chunk of result.measured.chunks) {
    lines.push(`    ${chunk.initial ? 'initial' : 'lazy   '}  ${kib(chunk.gzip)}  ${chunk.file}`);
  }

  return lines.join('\n');
}
