import { currentCorrelationId } from './correlation.js';
import { currentTraceIds } from './tracing.js';

/**
 * Structured logs: one JSON object per line, on stdout.
 *
 * The reason to give up readable prose is that these lines are read by a log aggregator far more
 * often than by a person, and "grep the message for the id" stops working the moment two services
 * write it differently. A JSON line can be queried by field — `correlationId = "hela_9f3c…"` — which
 * is the whole point of this sprint: one string, and you have everything that happened.
 *
 * Correlation and trace ids are picked up from the ambient context rather than passed in. A logger
 * that has to be threaded through every function signature is a logger that stops being used
 * exactly where the interesting failures are, six frames down.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export interface LoggerOptions {
  service: string;
  /** Below this, nothing is written. Falls back to `LOG_LEVEL`, then `info`. */
  level?: Level;
  /** Where lines go. Overridden in tests; production writes to stdout and lets the platform ship it. */
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? (process.env['LOG_LEVEL'] as Level | undefined) ?? 'info';
  const threshold = ORDER[level] ?? ORDER.info;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const at =
    (at: Level) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      if (ORDER[at] < threshold) return;

      const { traceId, spanId } = currentTraceIds();
      const correlationId = currentCorrelationId();
      write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: at,
          service: options.service,
          message,
          ...(correlationId ? { correlationId } : {}),
          // Present only inside a span. Absent is meaningful — it says this line came from startup,
          // shutdown or a background timer rather than from anybody's request.
          ...(traceId ? { traceId, spanId } : {}),
          ...serialisable(fields),
        }),
      );
    };

  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/**
 * Makes the extra fields survive `JSON.stringify`.
 *
 * Errors are the case that matters: `JSON.stringify(new Error('x'))` is `{}`, so a log line that
 * carefully attaches the error records nothing at all. Everything else is passed through and left
 * to `stringify` — this is a logger, not a serialisation framework.
 */
function serialisable(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
  return out;
}
