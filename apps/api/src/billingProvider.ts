import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlanTierSchema, type PlanTier, type SubscriptionStatus } from '@helaengine/schema';

/**
 * Taking money, behind a port.
 *
 * `DEVELOPMENT-PLAN.md` names Stripe, and Stripe is the right answer — nobody should be handling
 * card numbers to sell a game engine. What runs here is the *shape* Stripe plugs into, for the same
 * reason `AuthProvider` is the shape Clerk plugs into: **there is no Stripe account, no API key and
 * no way to receive its webhooks from this environment.**
 *
 * That is a real limitation and this file does not pretend otherwise. What it does instead is make
 * the limitation cheap to remove and impossible to hide:
 *
 *   - `StripeBilling` is written against Stripe's actual HTTP API — its Checkout Session and Billing
 *     Portal endpoints, its `v1` form encoding, its webhook signature scheme — so switching to it is
 *     a key and a price id, not a rewrite. It has never spoken to Stripe.
 *   - `LocalBilling` implements the same port with no network at all, so the entire flow (checkout,
 *     return, webhook, entitlement change) runs and is *tested* end to end on a laptop.
 *   - A deployment with neither says so through `checkoutAvailable`, and the editor shows the plan
 *     without an upgrade button rather than a button that fails.
 *
 * The webhook signature verification is real either way, because that is the part where getting it
 * wrong lets anybody on the internet upgrade themselves for free.
 */

export interface CheckoutRequest {
  organizationId: string;
  tier: PlanTier;
  /** Where the browser lands after paying, and after giving up. */
  successUrl: string;
  cancelUrl: string;
  /** So the provider can attach the subscription to an existing customer rather than a new one. */
  externalCustomer?: string | null;
}

/** What a verified webhook turned out to say. */
export interface BillingEvent {
  /** The provider's own event id, which is what makes redelivery idempotent. */
  id: string;
  type: string;
  /** Absent when the event is one this product does not act on. */
  change?: {
    externalCustomer: string;
    externalId: string | null;
    /** Present when the event names an organisation directly (checkout metadata). */
    organizationId?: string;
    tier: PlanTier;
    status: SubscriptionStatus;
    currentPeriodEnd: Date | null;
    cancelAt: Date | null;
  };
}

export interface BillingProvider {
  /** Whether this deployment can actually take money. False means the UI hides the upgrade path. */
  readonly available: boolean;
  /** A URL to send the browser to. */
  checkout(request: CheckoutRequest): Promise<{ url: string }>;
  /** Where an existing customer manages or cancels. Null when they have never paid. */
  portal(externalCustomer: string, returnUrl: string): Promise<{ url: string } | null>;
  /** Verifies a webhook and says what it means. Throws when the signature does not check out. */
  interpret(payload: string, signature: string | undefined): BillingEvent;
}

export class InvalidSignature extends Error {
  readonly status = 400;
}

/**
 * No provider configured.
 *
 * The default, and a supported configuration rather than an unfinished one: a self-hosted install
 * has nobody to bill. Every organisation is on whatever tier its row says, which an operator sets
 * directly — the enforcement is still real, only the payment is absent.
 */
export class NoBilling implements BillingProvider {
  readonly available = false;

  async checkout(): Promise<{ url: string }> {
    throw new Error('this deployment is not configured to take payments');
  }

  async portal(): Promise<{ url: string } | null> {
    return null;
  }

  interpret(): BillingEvent {
    throw new InvalidSignature('this deployment does not accept billing webhooks');
  }
}

/**
 * A provider that works, without a provider.
 *
 * Not a mock — it is a real implementation of the port with the network removed. `checkout` returns
 * a URL to a page this API serves, which posts back the webhook that a payment processor would have
 * sent. That makes the *whole* flow — press upgrade, land on a page, pay, receive a webhook, see the
 * entitlement change — runnable and testable end to end, which a mock returning a canned object
 * would not.
 *
 * It signs its own webhooks with the same scheme and the same verification path as Stripe, so the
 * signature code is exercised by every test rather than only in production.
 */
export class LocalBilling implements BillingProvider {
  readonly available = true;
  readonly #secret: string;
  readonly #origin: string;

  constructor(options: { secret: string; origin: string }) {
    this.#secret = options.secret;
    this.#origin = options.origin;
  }

  async checkout(request: CheckoutRequest): Promise<{ url: string }> {
    const parameters = new URLSearchParams({
      organizationId: request.organizationId,
      tier: request.tier,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
    });
    return { url: `${this.#origin}/billing/checkout?${parameters.toString()}` };
  }

  async portal(externalCustomer: string, returnUrl: string): Promise<{ url: string } | null> {
    const parameters = new URLSearchParams({ customer: externalCustomer, returnUrl });
    return { url: `${this.#origin}/billing/portal?${parameters.toString()}` };
  }

  /** Signs an event the way a provider would, so the local flow exercises the real verification. */
  sign(payload: string): string {
    return signPayload(this.#secret, payload);
  }

  interpret(payload: string, signature: string | undefined): BillingEvent {
    verifySignature(this.#secret, payload, signature);
    return parseLocalEvent(payload);
  }
}

interface LocalEventBody {
  id?: unknown;
  type?: unknown;
  organizationId?: unknown;
  customer?: unknown;
  subscription?: unknown;
  tier?: unknown;
  status?: unknown;
  currentPeriodEnd?: unknown;
  cancelAt?: unknown;
}

function parseLocalEvent(payload: string): BillingEvent {
  const body = JSON.parse(payload) as LocalEventBody;
  const id = typeof body.id === 'string' ? body.id : '';
  const type = typeof body.type === 'string' ? body.type : '';
  if (!id || !type) throw new InvalidSignature('that webhook is not a billing event');

  const tier = PlanTierSchema.safeParse(body.tier);
  if (!tier.success) return { id, type };

  return {
    id,
    type,
    change: {
      externalCustomer: typeof body.customer === 'string' ? body.customer : '',
      externalId: typeof body.subscription === 'string' ? body.subscription : null,
      ...(typeof body.organizationId === 'string' ? { organizationId: body.organizationId } : {}),
      tier: tier.data,
      status: (typeof body.status === 'string' ? body.status : 'active') as SubscriptionStatus,
      currentPeriodEnd:
        typeof body.currentPeriodEnd === 'number' ? new Date(body.currentPeriodEnd) : null,
      cancelAt: typeof body.cancelAt === 'number' ? new Date(body.cancelAt) : null,
    },
  };
}

/**
 * Stripe.
 *
 * **Never executed against Stripe.** Written against its documented API so that switching costs a
 * key and four price ids, and kept in the repository rather than described in a comment, because a
 * migration path nobody has written is a migration path nobody has thought through.
 *
 * The parts that are genuinely exercised by tests are the ones that do not need the network: the
 * form encoding of a Checkout Session, the mapping from Stripe's subscription statuses to this
 * product's four, and — most importantly — the signature verification, which is where a mistake
 * lets anybody on the internet upgrade themselves for nothing.
 */
export class StripeBilling implements BillingProvider {
  readonly available = true;
  readonly #key: string;
  readonly #webhookSecret: string;
  readonly #prices: Partial<Record<PlanTier, string>>;
  readonly #api: string;

  constructor(options: {
    apiKey: string;
    webhookSecret: string;
    /** Stripe price ids, one per sellable tier. */
    prices: Partial<Record<PlanTier, string>>;
    apiBase?: string;
  }) {
    this.#key = options.apiKey;
    this.#webhookSecret = options.webhookSecret;
    this.#prices = options.prices;
    this.#api = options.apiBase ?? 'https://api.stripe.com';
  }

  async checkout(request: CheckoutRequest): Promise<{ url: string }> {
    const price = this.#prices[request.tier];
    if (!price) throw new Error(`no price is configured for the ${request.tier} plan`);

    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      // The join between Stripe's world and this one. Without it a webhook says "customer cus_123
      // subscribed" and nothing here knows which organisation that is.
      'metadata[organizationId]': request.organizationId,
      'subscription_data[metadata][organizationId]': request.organizationId,
    });
    if (request.externalCustomer) form.set('customer', request.externalCustomer);

    const created = await this.#post<{ url: string }>('/v1/checkout/sessions', form);
    return { url: created.url };
  }

  async portal(externalCustomer: string, returnUrl: string): Promise<{ url: string } | null> {
    const created = await this.#post<{ url: string }>(
      '/v1/billing_portal/sessions',
      new URLSearchParams({ customer: externalCustomer, return_url: returnUrl }),
    );
    return { url: created.url };
  }

  interpret(payload: string, signature: string | undefined): BillingEvent {
    verifyStripeSignature(this.#webhookSecret, payload, signature);
    return interpretStripeEvent(payload, this.#prices);
  }

  async #post<T>(path: string, form: URLSearchParams): Promise<T> {
    const response = await fetch(`${this.#api}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#key}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Stripe refused ${path}: ${response.status} ${detail.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }
}

/**
 * Stripe's subscription statuses, mapped onto this product's four.
 *
 * Stripe has eight; this product has four, and the mapping is where a policy decision hides.
 * `past_due` and `unpaid` both keep their entitlement here, because the provider is still retrying
 * and a customer whose card expired is a customer. `incomplete` does not: that is a subscription
 * that never started.
 */
export function mapStripeStatus(stripe: string, cancelAtPeriodEnd: boolean): SubscriptionStatus {
  if (stripe === 'active' || stripe === 'trialing')
    return cancelAtPeriodEnd ? 'canceling' : 'active';
  if (stripe === 'past_due' || stripe === 'unpaid') return 'past_due';
  return 'none';
}

interface StripeEvent {
  id?: unknown;
  type?: unknown;
  data?: { object?: Record<string, unknown> };
}

export function interpretStripeEvent(
  payload: string,
  prices: Partial<Record<PlanTier, string>>,
): BillingEvent {
  const event = JSON.parse(payload) as StripeEvent;
  const id = typeof event.id === 'string' ? event.id : '';
  const type = typeof event.type === 'string' ? event.type : '';
  if (!id || !type) throw new InvalidSignature('that webhook is not a Stripe event');

  // The three that change entitlement. Everything else — invoices, payment methods, disputes — is
  // Stripe's to display in its portal, and mirroring it here would be a second copy that drifts.
  const acted = [
    'checkout.session.completed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ];
  if (!acted.includes(type)) return { id, type };

  const object = event.data?.object ?? {};
  const metadata = (object['metadata'] ?? {}) as Record<string, unknown>;
  const customer = typeof object['customer'] === 'string' ? object['customer'] : '';
  const subscriptionId =
    type === 'checkout.session.completed'
      ? typeof object['subscription'] === 'string'
        ? object['subscription']
        : null
      : typeof object['id'] === 'string'
        ? object['id']
        : null;

  const priceId = stripePriceOf(object);
  const tier = tierForPrice(priceId, prices);

  const status =
    type === 'customer.subscription.deleted'
      ? 'none'
      : mapStripeStatus(
          typeof object['status'] === 'string' ? object['status'] : 'active',
          object['cancel_at_period_end'] === true,
        );

  return {
    id,
    type,
    change: {
      externalCustomer: customer,
      externalId: subscriptionId,
      ...(typeof metadata['organizationId'] === 'string'
        ? { organizationId: metadata['organizationId'] }
        : {}),
      // A deletion is a drop to free whatever it was priced at, which is why the tier lookup
      // failing is not an error for that case.
      tier: status === 'none' ? 'free' : (tier ?? 'free'),
      status,
      currentPeriodEnd: stripeDate(object['current_period_end']),
      cancelAt: stripeDate(object['cancel_at']),
    },
  };
}

function stripePriceOf(object: Record<string, unknown>): string | null {
  const items = object['items'] as { data?: Array<{ price?: { id?: unknown } }> } | undefined;
  const first = items?.data?.[0]?.price?.id;
  return typeof first === 'string' ? first : null;
}

function tierForPrice(
  priceId: string | null,
  prices: Partial<Record<PlanTier, string>>,
): PlanTier | null {
  if (!priceId) return null;
  for (const tier of PlanTierSchema.options) {
    if (prices[tier] === priceId) return tier;
  }
  return null;
}

/** Stripe sends seconds since the epoch; JavaScript wants milliseconds. */
function stripeDate(value: unknown): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

/**
 * Stripe's `Stripe-Signature` header: `t=<timestamp>,v1=<hmac of "t.payload">`.
 *
 * Two properties matter and both are easy to get wrong. The signed value includes the timestamp, so
 * a captured webhook cannot be replayed a week later — which is why the timestamp is checked rather
 * than merely parsed. And the comparison is constant-time, because a byte-at-a-time comparison of an
 * HMAC is a signature oracle for anybody willing to send a few thousand requests.
 */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export function verifyStripeSignature(
  secret: string,
  payload: string,
  header: string | undefined,
  now = Date.now(),
): void {
  if (!header) throw new InvalidSignature('that webhook carried no signature');

  const parts = new Map(
    header.split(',').map((part) => {
      const [key, value] = part.split('=');
      return [key?.trim() ?? '', value?.trim() ?? ''] as const;
    }),
  );

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1') ?? '';
  if (!Number.isFinite(timestamp) || !provided) {
    throw new InvalidSignature('that webhook signature is malformed');
  }

  if (Math.abs(now - timestamp * 1000) > WEBHOOK_TOLERANCE_MS) {
    throw new InvalidSignature('that webhook is too old to trust');
  }

  compare(createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex'), provided);
}

/** The same scheme for the local provider, minus the timestamp: nothing here crosses a network. */
export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifySignature(secret: string, payload: string, header: string | undefined): void {
  if (!header) throw new InvalidSignature('that webhook carried no signature');
  compare(signPayload(secret, payload), header);
}

function compare(expected: string, provided: string): void {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  // Length-checked first because `timingSafeEqual` throws on a mismatch rather than returning
  // false, and that exception would itself be a signal.
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new InvalidSignature('that webhook signature does not check out');
  }
}

/** Builds the provider a deployment's environment describes. */
export function createBillingProvider(env = process.env): BillingProvider {
  if (env['STRIPE_SECRET_KEY'] && env['STRIPE_WEBHOOK_SECRET']) {
    return new StripeBilling({
      apiKey: env['STRIPE_SECRET_KEY'],
      webhookSecret: env['STRIPE_WEBHOOK_SECRET'],
      prices: {
        pro: env['STRIPE_PRICE_PRO'] ?? '',
        studio: env['STRIPE_PRICE_STUDIO'] ?? '',
        enterprise: env['STRIPE_PRICE_ENTERPRISE'] ?? '',
      },
    });
  }

  // Opt-in rather than a fallback: a deployment that quietly accepted fake payments because a key
  // was missing would be a very bad surprise.
  if (env['BILLING_LOCAL_SECRET']) {
    return new LocalBilling({
      secret: env['BILLING_LOCAL_SECRET'],
      origin: env['BILLING_LOCAL_ORIGIN'] ?? `http://localhost:${env['API_PORT'] ?? 3000}`,
    });
  }

  return new NoBilling();
}
