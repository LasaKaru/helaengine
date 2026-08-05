/**
 * Reporting a crash from the browser.
 *
 * The plan names Sentry, and this is a Sentry-*compatible* client rather than the SDK: it posts one
 * event to a DSN's envelope endpoint, and that is the whole of it. Skipping `@sentry/react` is a
 * decision worth defending, because it is not obviously right.
 *
 * What the SDK would add: breadcrumbs, session tracking, release health, automatic instrumentation
 * of `fetch` and history, source-map upload. What it costs here: roughly 30 kB of the bundle an
 * editor loads before it can show anything, a second error-handling path with its own opinions
 * about what to capture, and — the one that decided it — a transport that collects a great deal
 * about a user by default, in a product where the interesting payload is a *scene document* that
 * belongs to whoever made it.
 *
 * So this sends what an operator actually needs to fix a crash: the message, the stack, the
 * correlation id of the last API call, and the browser. Never the scene, never a token. If the
 * team later wants breadcrumbs and release health, swapping this file for the SDK is an afternoon.
 */

export interface CrashReport {
  message: string;
  stack?: string;
  /** Where in the editor it happened — "the level view", "the properties panel". */
  where: string;
  /** The last correlation id this tab saw, so a browser crash can be joined to server logs. */
  correlationId?: string | null;
}

/**
 * The last correlation id the API answered with.
 *
 * Kept in a module variable rather than in the store, because a crash report must be readable from
 * an error boundary that has just watched the store's own render throw.
 */
let lastCorrelationId: string | null = null;

export function rememberCorrelationId(response: Response): void {
  const id = response.headers.get('x-correlation-id');
  if (id) lastCorrelationId = id;
}

export function currentCorrelationId(): string | null {
  return lastCorrelationId;
}

/** Where reports go. Absent — the default, and the case for every self-hosted user — means nowhere. */
function dsn(): string | undefined {
  const configured = import.meta.env['VITE_SENTRY_DSN'] as string | undefined;
  return configured === '' ? undefined : configured;
}

export function reportCrash(report: CrashReport): void {
  const target = dsn();

  // Always on the console, whether or not anything is configured. A developer with the tab open is
  // the most common reader of this by a wide margin, and swallowing the error to send it somewhere
  // they cannot see would be a poor trade.
  console.error(`[helaengine] ${report.where}: ${report.message}`, report.stack);

  if (!target) return;

  const envelope = sentryEnvelope(target, {
    ...report,
    correlationId: report.correlationId ?? lastCorrelationId,
  });
  if (!envelope) return;

  // `keepalive`, because the interesting crashes are the ones followed by the user closing the tab.
  // Failures are swallowed on purpose: a reporting endpoint that is down must not produce a second
  // error inside the handler for the first.
  void fetch(envelope.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope' },
    body: envelope.body,
    keepalive: true,
  }).catch(() => {});
}

/**
 * A Sentry envelope: a header line, an item header line, and the event.
 *
 * The format is three newline-delimited JSON objects, which is why it can be written by hand. The
 * DSN is `https://<key>@<host>/<projectId>`, and the endpoint is derived from it — that is the only
 * part with any subtlety.
 */
function sentryEnvelope(target: string, report: CrashReport): { url: string; body: string } | null {
  let key: string;
  let host: string;
  let projectId: string;
  try {
    const parsed = new URL(target);
    key = parsed.username;
    host = parsed.host;
    projectId = parsed.pathname.replace(/^\//, '');
    if (!key || !projectId) return null;
  } catch {
    // A malformed DSN is a configuration mistake, and it must not become a crash inside the crash
    // reporter — which would be the second-worst place in the product to throw from.
    return null;
  }

  const eventId = crypto.randomUUID().replace(/-/g, '');
  const sentAt = new Date().toISOString();

  const event = {
    event_id: eventId,
    timestamp: sentAt,
    platform: 'javascript',
    level: 'error',
    logger: 'helaengine-editor',
    exception: {
      values: [{ type: 'Error', value: report.message, stacktrace: { frames: [] } }],
    },
    // The stack as a plain string rather than parsed into frames: without source maps uploaded,
    // parsed frames of minified code are less readable than the raw text, not more.
    extra: { stack: report.stack, where: report.where },
    tags: {
      where: report.where,
      // The join between a browser crash and the server logs around it.
      ...(report.correlationId ? { correlation_id: report.correlationId } : {}),
    },
  };

  return {
    url: `https://${host}/api/${projectId}/envelope/?sentry_key=${key}&sentry_version=7`,
    body: [
      JSON.stringify({ event_id: eventId, sent_at: sentAt }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n'),
  };
}
