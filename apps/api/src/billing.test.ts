import { describe, expect, it } from 'vitest';
import {
  interpretStripeEvent,
  InvalidSignature,
  LocalBilling,
  mapStripeStatus,
  NoBilling,
  signPayload,
  StripeBilling,
  verifyStripeSignature,
  WEBHOOK_TOLERANCE_MS,
} from './billingProvider.js';
import { createHmac } from 'node:crypto';

/**
 * The billing port, minus the network.
 *
 * The Stripe adapter has never spoken to Stripe and these tests do not pretend otherwise. What they
 * cover is everything that does not need an account and is worth getting right anyway: the webhook
 * signature scheme — where a mistake lets anybody on the internet upgrade themselves for free — the
 * status mapping, which is where a policy decision hides, and the event interpretation.
 */

const SECRET = 'whsec_test_secret';

function stripeSignature(payload: string, at = Date.now()): string {
  const timestamp = Math.floor(at / 1000);
  const digest = createHmac('sha256', SECRET).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('webhook signatures', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

  it('accepts one it just signed', () => {
    expect(() => verifyStripeSignature(SECRET, payload, stripeSignature(payload))).not.toThrow();
  });

  it('refuses a payload that has been altered by a single byte', () => {
    const signature = stripeSignature(payload);
    expect(() => verifyStripeSignature(SECRET, `${payload} `, signature)).toThrow(InvalidSignature);
  });

  it('refuses one signed with a different secret', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const forged = createHmac('sha256', 'not-the-secret')
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    expect(() => verifyStripeSignature(SECRET, payload, `t=${timestamp},v1=${forged}`)).toThrow(
      InvalidSignature,
    );
  });

  it('refuses a replay of a genuine webhook from last week', () => {
    // The timestamp is inside the signed value for exactly this reason. Without the freshness
    // check, anybody who captured one `invoice.paid` could replay it forever.
    const old = Date.now() - WEBHOOK_TOLERANCE_MS - 60_000;
    expect(() => verifyStripeSignature(SECRET, payload, stripeSignature(payload, old))).toThrow(
      /too old/,
    );
  });

  it('refuses a request with no signature at all', () => {
    expect(() => verifyStripeSignature(SECRET, payload, undefined)).toThrow(InvalidSignature);
    expect(() => verifyStripeSignature(SECRET, payload, 't=1')).toThrow(/malformed/);
  });
});

describe('Stripe’s statuses, mapped onto this product’s four', () => {
  it('keeps entitlement while a payment is being retried', () => {
    // The policy decision: `past_due` is a customer whose card expired, not an intruder.
    expect(mapStripeStatus('past_due', false)).toBe('past_due');
    expect(mapStripeStatus('unpaid', false)).toBe('past_due');
  });

  it('treats a trial as active, and a cancellation-at-period-end as canceling', () => {
    expect(mapStripeStatus('trialing', false)).toBe('active');
    expect(mapStripeStatus('active', true)).toBe('canceling');
  });

  it('treats a subscription that never started as none', () => {
    expect(mapStripeStatus('incomplete_expired', false)).toBe('none');
    expect(mapStripeStatus('canceled', false)).toBe('none');
  });
});

describe('interpreting a Stripe event', () => {
  const prices = { pro: 'price_pro', studio: 'price_studio' };

  it('reads a completed checkout, including which organisation it was for', () => {
    const event = interpretStripeEvent(
      JSON.stringify({
        id: 'evt_2',
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_123',
            subscription: 'sub_456',
            status: 'active',
            metadata: { organizationId: 'org-abc' },
            items: { data: [{ price: { id: 'price_pro' } }] },
          },
        },
      }),
      prices,
    );

    // Without the metadata the webhook says "cus_123 subscribed" and nothing here knows who that
    // is, which is why `checkout` puts the organisation id on the session in the first place.
    expect(event.change?.organizationId).toBe('org-abc');
    expect(event.change?.tier).toBe('pro');
    expect(event.change?.status).toBe('active');
    expect(event.change?.externalId).toBe('sub_456');
  });

  it('reads a deletion as a drop to free, whatever it was priced at', () => {
    const event = interpretStripeEvent(
      JSON.stringify({
        id: 'evt_3',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_456', customer: 'cus_123', status: 'canceled' } },
      }),
      prices,
    );
    expect(event.change?.tier).toBe('free');
    expect(event.change?.status).toBe('none');
  });

  it('ignores the events this product does not act on', () => {
    // Invoices, payment methods and disputes are Stripe's to display in its own portal; mirroring
    // them here would be a second copy that drifts from the first.
    const event = interpretStripeEvent(
      JSON.stringify({ id: 'evt_4', type: 'invoice.payment_method_updated', data: { object: {} } }),
      prices,
    );
    expect(event.change).toBeUndefined();
  });

  it('converts Stripe’s seconds to milliseconds', () => {
    const seconds = 1_800_000_000;
    const event = interpretStripeEvent(
      JSON.stringify({
        id: 'evt_5',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            current_period_end: seconds,
            items: { data: [{ price: { id: 'price_pro' } }] },
          },
        },
      }),
      prices,
    );
    expect(event.change?.currentPeriodEnd?.getTime()).toBe(seconds * 1000);
  });
});

describe('the local provider', () => {
  const local = new LocalBilling({ secret: 'local-secret', origin: 'http://localhost:3000' });

  it('sends the browser somewhere real', async () => {
    const session = await local.checkout({
      organizationId: 'org-1',
      tier: 'pro',
      successUrl: '/back',
      cancelUrl: '/back',
    });
    expect(session.url).toContain('/billing/checkout?');
    expect(session.url).toContain('tier=pro');
  });

  it('verifies its own webhooks with the same code path Stripe’s use', () => {
    const payload = JSON.stringify({
      id: 'evt_local',
      type: 'checkout.session.completed',
      tier: 'pro',
    });
    const event = local.interpret(payload, local.sign(payload));
    expect(event.change?.tier).toBe('pro');

    // Which means a forged one is refused by the same check, rather than by a second lenient path
    // that only exists in development.
    expect(() => local.interpret(payload, signPayload('wrong', payload))).toThrow(InvalidSignature);
  });
});

describe('a deployment with no provider', () => {
  const none = new NoBilling();

  it('says so rather than offering a button that fails', () => {
    expect(none.available).toBe(false);
  });

  it('refuses webhooks outright', () => {
    expect(() => none.interpret()).toThrow(InvalidSignature);
  });

  it('has no portal to send anybody to', async () => {
    expect(await none.portal()).toBeNull();
  });
});

describe('the Stripe adapter’s request shapes', () => {
  it('puts the organisation id where the webhook will find it', async () => {
    // Never sent to Stripe: `fetch` is replaced, and what is asserted is the form encoding — the
    // part that is wrong until somebody reads the documentation carefully.
    let sent: { url: string; body: string } | null = null;
    const stripe = new StripeBilling({
      apiKey: 'sk_test',
      webhookSecret: SECRET,
      prices: { pro: 'price_pro' },
      apiBase: 'https://stripe.invalid',
    });

    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent = { url: String(url), body: String(init?.body ?? '') };
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const session = await stripe.checkout({
        organizationId: 'org-xyz',
        tier: 'pro',
        successUrl: 'https://editor.example.com/?upgraded=1',
        cancelUrl: 'https://editor.example.com/',
      });
      expect(session.url).toContain('checkout.stripe.com');
    } finally {
      globalThis.fetch = original;
    }

    const body = new URLSearchParams(sent!.body);
    expect(sent!.url).toBe('https://stripe.invalid/v1/checkout/sessions');
    expect(body.get('mode')).toBe('subscription');
    expect(body.get('line_items[0][price]')).toBe('price_pro');
    // On the subscription as well as the session: a `customer.subscription.updated` months later
    // carries the subscription's metadata, not the checkout session's.
    expect(body.get('metadata[organizationId]')).toBe('org-xyz');
    expect(body.get('subscription_data[metadata][organizationId]')).toBe('org-xyz');
  });

  it('refuses a tier it has no price for, rather than charging the wrong one', async () => {
    const stripe = new StripeBilling({ apiKey: 'sk', webhookSecret: SECRET, prices: {} });
    await expect(
      stripe.checkout({ organizationId: 'o', tier: 'studio', successUrl: '/', cancelUrl: '/' }),
    ).rejects.toThrow(/no price is configured/);
  });
});
