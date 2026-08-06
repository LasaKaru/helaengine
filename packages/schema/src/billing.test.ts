import { describe, expect, it } from 'vitest';
import {
  entitledTier,
  limitMessage,
  limitsFor,
  PLAN_LIMITS,
  PLAN_ORDER,
  planThatAllows,
} from './billing.js';
import { EXPORTS_PER_PERIOD, type PlanTier } from './exportJob.js';

/**
 * The plan table is a contract between the API's enforcement and the editor's meters. These tests
 * are about the *shape* being coherent — a table where a higher tier gives you less of something
 * is a pricing page nobody can explain.
 */
describe('the plan table', () => {
  it('never gives a higher tier less of anything', () => {
    for (let index = 1; index < PLAN_ORDER.length; index += 1) {
      const lower = PLAN_LIMITS[PLAN_ORDER[index - 1]!];
      const higher = PLAN_LIMITS[PLAN_ORDER[index]!];

      expect(higher.seats).toBeGreaterThanOrEqual(lower.seats);
      expect(higher.storageBytes).toBeGreaterThanOrEqual(lower.storageBytes);
      expect(higher.exportsPerPeriod).toBeGreaterThanOrEqual(lower.exportsPerPeriod);
      expect(higher.collaborators).toBeGreaterThanOrEqual(lower.collaborators);
      expect(Number(higher.customAssets)).toBeGreaterThanOrEqual(Number(lower.customAssets));
      expect(Number(higher.sso)).toBeGreaterThanOrEqual(Number(lower.sso));
    }
  });

  it('keeps Sprint 32’s export quota rather than inventing a second one', () => {
    // Two tables of export limits would drift, and the way anybody would find out is a user being
    // refused an export the meter said they had.
    for (const tier of PLAN_ORDER) {
      expect(PLAN_LIMITS[tier].exportsPerPeriod).toBe(EXPORTS_PER_PERIOD[tier]);
    }
  });

  it('never advertises more collaborators than seats', () => {
    // A room limit above the seat limit is unreachable by construction, which is worse than a low
    // limit: the feature is advertised and cannot be used. The free tier shipped exactly that in
    // the first draft of this table.
    for (const tier of PLAN_ORDER) {
      expect(PLAN_LIMITS[tier].collaborators).toBeLessThanOrEqual(PLAN_LIMITS[tier].seats);
    }
  });

  it('bounds even the largest plan', () => {
    // An unlimited number is a runaway script nobody notices until the invoice.
    expect(PLAN_LIMITS.enterprise.exportsPerPeriod).toBeLessThan(1_000_000);
    expect(Number.isFinite(PLAN_LIMITS.enterprise.storageBytes)).toBe(true);
  });
});

describe('finding the plan that lifts a limit', () => {
  it('names the cheapest one that would allow it', () => {
    expect(planThatAllows('customAssets', 1, 'free')).toBe('pro');
    expect(planThatAllows('seats', 4, 'free')).toBe('pro');
    expect(planThatAllows('seats', 20, 'free')).toBe('studio');
  });

  it('returns null when nothing on the menu is enough', () => {
    // The "get in touch" case, which must not be an upgrade button that leads nowhere.
    expect(planThatAllows('seats', 100_000, 'free')).toBeNull();
  });

  it('never suggests the plan somebody is already on', () => {
    expect(planThatAllows('exports', 50, 'pro')).toBe('studio');
    expect(planThatAllows('sso', 1, 'enterprise')).toBeNull();
  });
});

describe('what a refusal says', () => {
  it('names the limit and the way out', () => {
    const message = limitMessage('customAssets', 'free', 'pro');
    expect(message).toContain('Pro');
    // Never a bare refusal: somebody who is told "forbidden" learns nothing they can act on.
    expect(message).not.toMatch(/forbidden|not allowed|denied/i);
  });

  it('says something useful even when no plan lifts it', () => {
    const message = limitMessage('seats', 'enterprise', null);
    expect(message).toMatch(/get in touch/i);
  });
});

describe('what somebody is entitled to right now', () => {
  const tier: PlanTier = 'pro';

  it('keeps a paid tier while a payment is being retried', () => {
    // The rule that matters most in a billing system: an expired card is a customer, not an
    // intruder, and locking them out of their own work the same afternoon is how you lose them.
    expect(entitledTier({ tier, status: 'past_due' })).toBe('pro');
    expect(limitsFor({ tier, status: 'past_due' }).customAssets).toBe(true);
  });

  it('keeps it until the end of a period somebody has cancelled', () => {
    expect(entitledTier({ tier, status: 'canceling' })).toBe('pro');
  });

  it('drops to free once there is no subscription at all', () => {
    expect(entitledTier({ tier, status: 'none' })).toBe('free');
    expect(limitsFor({ tier, status: 'none' }).customAssets).toBe(false);
  });
});
