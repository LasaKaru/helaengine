import { z } from 'zod';
import { PlanTierSchema, EXPORTS_PER_PERIOD, type PlanTier } from './exportJob.js';

/**
 * What each plan may do, in one table.
 *
 * Sprint 32 enforced a real export quota against a `plan_tier` column somebody set by hand. This is
 * the sprint where the rest of the business model stops being a pricing page: seats, storage,
 * uploads, collaborators and SSO all become numbers the API checks.
 *
 * **One table, shared by the server and the editor.** The alternative — limits in the API and a
 * copy in the UI for the meters — guarantees the two disagree eventually, and the way you find out
 * is a user watching a progress bar say "3 of 10" while the server refuses the fourth. So the
 * limits live in the schema package, like every other contract in this repo.
 *
 * The numbers themselves are a product decision and this is not a pricing exercise. They are set so
 * that the *shape* is right: free is enough to build something real and not enough to run a studio
 * on, each step up removes the limit that bites first at the tier below, and enterprise is bounded
 * rather than infinite — an unlimited number is a runaway script nobody notices.
 */

export const PlanLimitsSchema = z.object({
  /** Members of an organisation, counting the owner. */
  seats: z.number().int().positive(),
  /** Uploaded assets, in bytes, across the organisation. */
  storageBytes: z.number().int().positive(),
  /** Server-side exports per rolling 30 days. Sprint 32's quota, now part of the same table. */
  exportsPerPeriod: z.number().int().positive(),
  /** Whether an organisation may upload its own `.glb` files at all. */
  customAssets: z.boolean(),
  /** People in one collaborative room at once. */
  collaborators: z.number().int().positive(),
  /** Single sign-on. Nothing implements it yet — see the note below. */
  sso: z.boolean(),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    /**
     * Two, not one, and the reason is a contradiction the first draft of this table shipped with:
     * free allowed two people in a collaborative room while allowing one member. A room limit
     * higher than the seat limit is unreachable by construction — the collaboration feature would
     * have been advertised and impossible. Two seats makes it real: you and somebody you asked to
     * look at your level.
     */
    seats: 2,
    storageBytes: GB / 2,
    exportsPerPeriod: EXPORTS_PER_PERIOD.free,
    // The one hard feature gate, and it is the honest one to pick: hosting somebody's own files
    // costs money per byte per month, which is exactly the sort of cost a free tier cannot absorb.
    customAssets: false,
    // Not zero. Collaboration with nobody is what a free account has anyway, and a limit of one
    // means the *feature* is off — which is a different message and a worse one, because somebody
    // invited to look at a level should be able to.
    collaborators: 2,
    sso: false,
  },
  pro: {
    seats: 5,
    storageBytes: 10 * GB,
    exportsPerPeriod: EXPORTS_PER_PERIOD.pro,
    customAssets: true,
    collaborators: 5,
    sso: false,
  },
  studio: {
    seats: 25,
    storageBytes: 100 * GB,
    exportsPerPeriod: EXPORTS_PER_PERIOD.studio,
    customAssets: true,
    collaborators: 15,
    sso: false,
  },
  enterprise: {
    seats: 500,
    storageBytes: 1000 * GB,
    exportsPerPeriod: EXPORTS_PER_PERIOD.enterprise,
    customAssets: true,
    collaborators: 50,
    // The only feature that is genuinely enterprise-shaped, and **nothing implements it**. It is in
    // the table because the table is the answer to "what does this tier include", and leaving it
    // out would make the table lie by omission. `AuthProvider` is the seam it plugs into.
    sso: true,
  },
};

/** The order they upgrade in. Used to name "the next plan up" in a refusal. */
export const PLAN_ORDER: readonly PlanTier[] = ['free', 'pro', 'studio', 'enterprise'];

export const PLAN_NAMES: Record<PlanTier, string> = {
  free: 'Free',
  pro: 'Pro',
  studio: 'Studio',
  enterprise: 'Enterprise',
};

/** Monthly price in whole currency units. Zero for free; enterprise is "talk to us", hence null. */
export const PLAN_PRICES: Record<PlanTier, number | null> = {
  free: 0,
  pro: 19,
  studio: 79,
  enterprise: null,
};

/**
 * Which limits are being spent, as a closed vocabulary.
 *
 * The same discipline as behaviours and repair operations: a limit is one of six named things, so
 * a refusal can carry a machine-readable reason the editor turns into the right screen rather than
 * a string it has to match on.
 */
export const LimitKindSchema = z.enum([
  'seats',
  'storage',
  'exports',
  'customAssets',
  'collaborators',
  'sso',
]);
export type LimitKind = z.infer<typeof LimitKindSchema>;

/** The cheapest plan that lifts a limit above what is being asked of it, or null if none does. */
export function planThatAllows(kind: LimitKind, needed: number, from: PlanTier): PlanTier | null {
  const start = PLAN_ORDER.indexOf(from);
  for (const tier of PLAN_ORDER.slice(start + 1)) {
    const limits = PLAN_LIMITS[tier];
    const allowed =
      kind === 'seats'
        ? limits.seats >= needed
        : kind === 'storage'
          ? limits.storageBytes >= needed
          : kind === 'exports'
            ? limits.exportsPerPeriod >= needed
            : kind === 'collaborators'
              ? limits.collaborators >= needed
              : kind === 'customAssets'
                ? limits.customAssets
                : limits.sso;
    if (allowed) return tier;
  }
  return null;
}

/**
 * What a user is told when a limit stops them.
 *
 * Sent as structured data rather than a sentence, because the *editor* is what knows how to show an
 * upgrade — a modal with a button beats a toast with a string every time — and because a client
 * that has to regex an error message is a client that breaks when somebody improves the wording.
 * The sentence is included as well, for the places that only have room for one.
 */
export const LimitExceededSchema = z.object({
  error: z.string(),
  kind: LimitKindSchema,
  tier: PlanTierSchema,
  /** What they are allowed. */
  limit: z.number(),
  /** What they have, or asked for. */
  used: z.number(),
  /** The cheapest plan that would allow it, or null when nothing does. */
  upgradeTo: PlanTierSchema.nullable(),
});
export type LimitExceeded = z.infer<typeof LimitExceededSchema>;

export function limitMessage(kind: LimitKind, tier: PlanTier, upgradeTo: PlanTier | null): string {
  const plan = PLAN_NAMES[tier];
  const next = upgradeTo === null ? null : PLAN_NAMES[upgradeTo];

  // Each of these names the limit, what it is, and the way out — a refusal without a way out is
  // just a wall. Never "forbidden", which tells somebody nothing they can act on.
  const sentences: Record<LimitKind, string> = {
    seats: `The ${plan} plan includes ${PLAN_LIMITS[tier].seats} seat${
      PLAN_LIMITS[tier].seats === 1 ? '' : 's'
    }.`,
    storage: `The ${plan} plan includes ${formatBytes(PLAN_LIMITS[tier].storageBytes)} of asset storage, and this upload would go past it.`,
    exports: `The ${plan} plan includes ${PLAN_LIMITS[tier].exportsPerPeriod} exports every 30 days.`,
    customAssets: `Uploading your own models is part of the ${PLAN_NAMES.pro} plan.`,
    collaborators: `The ${plan} plan allows ${PLAN_LIMITS[tier].collaborators} people in a project at once.`,
    sso: `Single sign-on is part of the ${PLAN_NAMES.enterprise} plan.`,
  };

  return next === null
    ? `${sentences[kind]} Get in touch and we will sort something out.`
    : `${sentences[kind]} ${next} lifts it.`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * A subscription, as this product models it.
 *
 * Deliberately smaller than Stripe's object. What the API needs to answer is "which tier, and is it
 * paid up" — everything else (invoices, payment methods, proration) is the provider's business and
 * is best read from the provider rather than mirrored into a table that drifts.
 */
export const SubscriptionStatusSchema = z.enum([
  /** Never subscribed, or cancelled and the period has ended. The free tier. */
  'none',
  'active',
  /** Payment failed; still entitled while the provider retries. See `entitledTier`. */
  'past_due',
  /** Cancelled but paid until the period ends. */
  'canceling',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const SubscriptionSchema = z.object({
  organizationId: z.string().min(1),
  tier: PlanTierSchema,
  status: SubscriptionStatusSchema,
  /** The provider's id for this subscription, when there is a provider. */
  externalId: z.string().nullable().default(null),
  /** When the paid period ends. Null on the free tier. */
  currentPeriodEnd: z.string().nullable().default(null),
  cancelAt: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/**
 * The tier an organisation is *entitled to right now*.
 *
 * Not the same as the tier they are subscribed to, and the difference is where billing systems go
 * wrong. A failed payment must not lock somebody out of their own work the same afternoon: the
 * provider will retry for days, and a customer whose card expired is a customer, not an intruder.
 * So `past_due` keeps its entitlement and the provider decides when it becomes `none`.
 *
 * `canceling` likewise: they have paid until the end of the period, so they keep what they paid for
 * until then.
 */
export function entitledTier(subscription: Pick<Subscription, 'tier' | 'status'>): PlanTier {
  return subscription.status === 'none' ? 'free' : subscription.tier;
}

export function limitsFor(subscription: Pick<Subscription, 'tier' | 'status'>): PlanLimits {
  return PLAN_LIMITS[entitledTier(subscription)];
}

/** Everything the billing screen needs, in one response. */
export const BillingSummarySchema = z.object({
  subscription: SubscriptionSchema,
  limits: PlanLimitsSchema,
  usage: z.object({
    seats: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    exports: z.number().int().nonnegative(),
  }),
  /** Whether this deployment can take money at all — see the billing port. */
  checkoutAvailable: z.boolean(),
});
export type BillingSummary = z.infer<typeof BillingSummarySchema>;
