import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentCorrelationId, rememberCorrelationId, reportCrash } from './report';

/**
 * The crash reporter, including the part that must never fire.
 *
 * Two claims are worth pinning: that nothing leaves the browser unless a DSN is configured — the
 * default, and the case for every self-hosted user — and that what does leave carries the
 * correlation id rather than the scene.
 */

const DSN = 'https://abc123@o1.ingest.example.com/42';

let sent: Array<{ url: string; body: string }>;

beforeEach(() => {
  sent = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    sent.push({ url, body: String(init?.body ?? '') });
    return Promise.resolve(new Response('{}'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('reporting', () => {
  it('sends nothing at all when no DSN is configured', () => {
    reportCrash({ message: 'boom', where: 'the level view' });
    expect(sent).toHaveLength(0);
  });

  it('still writes to the console, because that is who usually reads it', () => {
    reportCrash({ message: 'boom', where: 'the level view' });
    expect(console.error).toHaveBeenCalled();
  });

  it('posts a Sentry envelope to the right endpoint when one is', () => {
    vi.stubEnv('VITE_SENTRY_DSN', DSN);

    reportCrash({
      message: 'cannot read properties of undefined',
      stack: 'Error: …',
      where: 'the properties panel',
      correlationId: 'hela_abcdef0123456789',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(
      'https://o1.ingest.example.com/api/42/envelope/?sentry_key=abc123&sentry_version=7',
    );

    // Three newline-delimited JSON objects: envelope header, item header, event.
    const [header, item, event] = sent[0]!.body.split('\n').map((line) => JSON.parse(line));
    expect(header).toHaveProperty('event_id');
    expect(item).toEqual({ type: 'event' });
    expect(event.exception.values[0].value).toBe('cannot read properties of undefined');
    // The tag that joins this crash to the server logs around it.
    expect(event.tags.correlation_id).toBe('hela_abcdef0123456789');
  });

  it('uses the last correlation id the API answered with, when the crash has none', () => {
    vi.stubEnv('VITE_SENTRY_DSN', DSN);
    rememberCorrelationId(
      new Response('{}', { headers: { 'x-correlation-id': 'hela_1111222233334444' } }),
    );
    expect(currentCorrelationId()).toBe('hela_1111222233334444');

    reportCrash({ message: 'boom', where: 'the level view' });

    const event = JSON.parse(sent[0]!.body.split('\n')[2]!);
    expect(event.tags.correlation_id).toBe('hela_1111222233334444');
  });

  it('does not throw on a malformed DSN, which would be a crash inside the crash reporter', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'not-a-url');
    expect(() => reportCrash({ message: 'boom', where: 'the level view' })).not.toThrow();
    expect(sent).toHaveLength(0);
  });
});
