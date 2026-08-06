import type { BillingSummary, LimitExceeded, PlanTier } from '@helaengine/schema';
import { NotSignedIn, type CloudSession } from './cloudProjects';
import { rememberCorrelationId } from '../telemetry/report';

/**
 * The plan, the meters, and the way up.
 *
 * `LimitReached` is the interesting part of this file. Every endpoint that spends a limit answers
 * **402** with a structured body — which limit, the allowance, what was used, and the cheapest plan
 * that lifts it — and this turns that into an error a component can render as an upgrade prompt
 * rather than a red string.
 *
 * Matching on a message would have been fewer lines and it is the thing that breaks silently: the
 * day somebody improves the wording, the upgrade prompt turns back into a toast saying "forbidden"
 * and nobody notices until support does.
 */

/** A refusal that a plan would fix, carrying everything needed to say so. */
export class LimitReached extends Error {
  readonly detail: LimitExceeded;

  constructor(detail: LimitExceeded) {
    super(detail.error);
    this.name = 'LimitReached';
    this.detail = detail;
  }
}

export class Billing {
  readonly #session: CloudSession;

  constructor(session: CloudSession) {
    this.#session = session;
  }

  /** The plan, the limits and what has been used — all counted by the server. */
  async summary(): Promise<BillingSummary> {
    return this.#call<BillingSummary>('GET', `/orgs/${this.#session.organizationId}/billing`);
  }

  /**
   * Starts an upgrade, and returns where to send the browser.
   *
   * A URL rather than a redirect performed here, because the caller knows whether it is in a modal
   * that should close first, and because a redirect buried in a data layer is impossible to test.
   */
  async checkout(tier: PlanTier, returnUrl: string): Promise<string> {
    const created = await this.#call<{ url: string }>(
      'POST',
      `/orgs/${this.#session.organizationId}/billing/checkout`,
      { tier, returnUrl },
    );
    return created.url;
  }

  /** Where an existing customer changes or cancels. Null when they have never paid. */
  async portal(returnUrl: string): Promise<string | null> {
    try {
      const created = await this.#call<{ url: string }>(
        'POST',
        `/orgs/${this.#session.organizationId}/billing/portal`,
        { returnUrl },
      );
      return created.url;
    } catch (error) {
      // 409 is "nothing to manage yet", which is a fact about the account rather than a failure —
      // the caller shows the upgrade path instead of an error.
      if (error instanceof Error && error.message.includes('no subscription')) return null;
      throw error;
    }
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#session.origin}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#session.token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      rememberCorrelationId(response);
    } catch {
      throw new Error(`Could not reach the API at ${this.#session.origin}.`);
    }

    if (response.status === 401) throw new NotSignedIn();

    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;

    if (response.status === 402) throw new LimitReached(parsed as unknown as LimitExceeded);
    if (!response.ok) {
      throw new Error(
        String(parsed['error'] ?? `The API refused this request (${response.status}).`),
      );
    }
    return parsed as T;
  }
}

/**
 * Turns any failed response into the right error.
 *
 * Exported so the *other* clients — assets, exports — can raise `LimitReached` from their own
 * calls without each reimplementing the check. A limit reached during an upload has to produce the
 * same prompt as one reached on the billing screen, or the product teaches people that some walls
 * have doors and others do not.
 */
export function limitFrom(status: number, body: Record<string, unknown>): LimitReached | null {
  if (status !== 402) return null;
  return new LimitReached(body as unknown as LimitExceeded);
}
