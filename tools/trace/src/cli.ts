import { existsSync } from 'node:fs';
import { readSpans, render, select, summarise, timeline } from './timeline.js';

/**
 * `pnpm trace <correlation-id>` — what happened, in order, across every service.
 *
 *   HELA_TRACE_FILE=.hela-traces/spans.ndjson pnpm api
 *   HELA_TRACE_FILE=.hela-traces/spans.ndjson pnpm --filter @helaengine/export-worker start
 *   pnpm trace                       # the last twenty traces
 *   pnpm trace hela_9f3c1a2b4d5e6f70 # one request, end to end
 *
 * See `docs/RUNBOOK.md` for the production equivalent, which is the same view in Grafana Tempo.
 */

const args = process.argv.slice(2);

/**
 * `--file <path>` and one positional id.
 *
 * Written as a loop rather than as a clever filter, after the clever filter dropped the id:
 * `indexOf('--file')` returns -1 when the flag is absent, and "skip the argument after the flag"
 * then means "skip index 0" — which is the id. The tool answered with a listing and looked like it
 * had simply found nothing.
 */
let path = process.env['HELA_TRACE_FILE'] ?? '.hela-traces/spans.ndjson';
let id: string | undefined;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === '--file') {
    path = args[index + 1] ?? path;
    index += 1;
  } else if (!arg.startsWith('--')) {
    id ??= arg;
  }
}

if (!existsSync(path)) {
  console.error(
    `No trace file at ${path}.\n` +
      'Start the services with HELA_TRACE_FILE set, or pass --file <path>.',
  );
  process.exit(1);
}

const spans = readSpans(path);

if (id === undefined) {
  // No id: list what is there. Somebody debugging a report of "the export was slow at about three
  // o'clock" has a timestamp, not an identifier.
  process.stdout.write(summarise(spans));
} else {
  const selected = select(spans, id);
  process.stdout.write(render(timeline(selected)));
  // Non-zero when nothing matched, so a script can tell "no such trace" from "here it is".
  if (selected.length === 0) process.exit(1);
}
