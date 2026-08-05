import { isTerminal, type ExportJob, type PlanTier } from '@helaengine/schema';
import { NotSignedIn, type CloudSession } from './cloudProjects';

/**
 * Asking the server to build an export, and watching it happen.
 *
 * The browser exporter is still there and still the right thing for a small level: no round trip,
 * no account, works offline. This is the other one — for projects big enough that assembling the
 * whole build in tab memory is a gamble, and for builds long enough that closing the tab should not
 * cost them.
 *
 * Polling rather than a websocket. A build takes tens of seconds and reports six stages, so a
 * request every second is a handful of tiny responses — against a second long-lived connection per
 * exporting user, with its own reconnect logic, for information that changes six times. The
 * collaboration server earns a socket because it carries continuous edits; this does not.
 */

export interface ExportQuota {
  tier: PlanTier;
  used: number;
  limit: number;
  remaining: number;
}

/** Raised when the organisation has used its allowance. Carries the sentence the API wrote. */
export class QuotaExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceeded';
  }
}

export class CloudExports {
  readonly #session: CloudSession;

  constructor(session: CloudSession) {
    this.#session = session;
  }

  async quota(): Promise<ExportQuota> {
    return this.#call<ExportQuota>('GET', `/orgs/${this.#session.organizationId}/export-quota`);
  }

  /** Asks for a build. The job comes back `queued`; nothing has happened yet. */
  async request(projectId: string): Promise<ExportJob> {
    const body = await this.#call<{ job: ExportJob }>('POST', `/projects/${projectId}/exports`);
    return body.job;
  }

  async status(jobId: string): Promise<{ job: ExportJob; downloadable: boolean }> {
    return this.#call<{ job: ExportJob; downloadable: boolean }>('GET', `/export-jobs/${jobId}`);
  }

  /**
   * Polls until the job finishes.
   *
   * `onProgress` fires on every poll rather than only on change, so a bar that is animating has
   * something to animate towards. The abort signal matters more than it looks: closing the dialog
   * mid-build must stop the polling, not leave a timer firing against a component that is gone.
   */
  async waitFor(
    jobId: string,
    options: {
      onProgress?: (job: ExportJob) => void;
      signal?: AbortSignal;
      intervalMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<ExportJob> {
    const interval = options.intervalMs ?? 1_000;
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);

    for (;;) {
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');

      const { job } = await this.status(jobId);
      options.onProgress?.(job);
      if (isTerminal(job.status)) return job;

      if (Date.now() > deadline) {
        // A job that has not finished in fifteen minutes is not going to. Reported as a timeout of
        // the *watching* rather than of the job — the build may still complete, and the history
        // list will show it — because those are different claims.
        throw new Error(
          'That export is taking longer than expected. It may still finish — check the project’s export history.',
        );
      }

      await new Promise((done) => setTimeout(done, interval));
    }
  }

  /**
   * Where the finished build is downloaded from.
   *
   * A URL rather than bytes, so the browser's own download manager handles it: a 200 MB export
   * pulled through `fetch` into a Blob is the tab-memory problem this whole feature exists to
   * avoid, reintroduced at the last step.
   *
   * The token goes in the query because a plain `<a href>` cannot carry an Authorization header.
   * That is a real trade — a URL with a credential in it can end up in a browser history — and it
   * is why the route also checks membership rather than treating the link itself as the permission.
   */
  downloadUrl(jobId: string): string {
    return `${this.#session.origin}/export-jobs/${jobId}/download?token=${encodeURIComponent(
      this.#session.token,
    )}`;
  }

  async #call<T>(method: string, path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#session.origin}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#session.token}`,
        },
      });
    } catch {
      throw new Error(`Could not reach the API at ${this.#session.origin}.`);
    }

    if (response.status === 401) throw new NotSignedIn();

    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;

    if (response.status === 429) {
      // The API's own sentence, which says what the limit is and how much of it is used. Replacing
      // it with "quota exceeded" here would throw away the only actionable part.
      throw new QuotaExceeded(String(parsed['error'] ?? 'You are out of exports for this period.'));
    }

    if (!response.ok) {
      throw new Error(
        String(parsed['error'] ?? `The API refused this request (${response.status}).`),
      );
    }
    return parsed as T;
  }
}
