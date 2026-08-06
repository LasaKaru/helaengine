import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatBytes,
  PLAN_NAMES,
  PLAN_ORDER,
  PLAN_PRICES,
  type BillingSummary,
  type PlanTier,
} from '@helaengine/schema';
import { Billing } from '../storage/billing';
import { currentSession } from '../storage/backend';

/**
 * The plan, what is left of it, and the way up.
 *
 * Every number here comes from the server's own counting — the same query that decides whether the
 * next export is allowed. That is the whole reason `usageOf` derives its totals rather than keeping
 * counters: a meter that says "3 of 5" beside an API that refuses the fourth is the kind of bug
 * that makes people think they are being cheated.
 *
 * Nothing is shown at all without an account, which is not a degraded mode — the editor is entirely
 * usable offline on IndexedDB, and a billing panel in that world would be advertising a shop that
 * is not open.
 */

export function BillingPanel(): React.JSX.Element | null {
  const session = currentSession();
  const client = useMemo(() => (session ? new Billing(session) : null), [session]);

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setSummary(await client.summary());
    } catch (problem: unknown) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const upgrade = useCallback(
    async (tier: PlanTier) => {
      if (!client) return;
      setBusy(true);
      setError('');
      try {
        // Sent away rather than handled here: the provider owns the payment page, and this one
        // returns to the editor afterwards. `window.location` rather than a new tab, because a
        // checkout that finishes in a tab the user then closes leaves them looking at a stale plan.
        window.location.href = await client.checkout(tier, window.location.href);
      } catch (problem: unknown) {
        setError(problem instanceof Error ? problem.message : String(problem));
        setBusy(false);
      }
    },
    [client],
  );

  const manage = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    try {
      const url = await client.portal(window.location.href);
      if (url) window.location.href = url;
      else setError('There is no subscription to manage yet.');
    } catch (problem: unknown) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }, [client]);

  if (!client) return null;
  if (!summary) {
    return (
      <section className="billing-panel" aria-label="Plan">
        <h3>Plan</h3>
        <p className="panel-hint">{error === '' ? 'Loading…' : error}</p>
      </section>
    );
  }

  const { subscription, limits, usage } = summary;
  const next = PLAN_ORDER[PLAN_ORDER.indexOf(subscription.tier) + 1];

  return (
    <section className="billing-panel" aria-label="Plan">
      <h3>Plan</h3>

      <p className="billing-plan" data-testid="billing-plan">
        <strong>{PLAN_NAMES[subscription.tier]}</strong>
        {subscription.status === 'past_due' && (
          // Said plainly and without panic: nothing has stopped working, and the provider is still
          // trying. A banner that shouts about a failed payment while everything still works is a
          // banner that makes people think their data is at risk.
          <span className="billing-warning">
            {' '}
            — a payment did not go through. Nothing has stopped working; we will try again.
          </span>
        )}
        {subscription.status === 'canceling' && subscription.currentPeriodEnd && (
          <span className="panel-hint">
            {' '}
            — ends {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
          </span>
        )}
      </p>

      <Meter
        label="Exports this period"
        used={usage.exports}
        limit={limits.exportsPerPeriod}
        format={(value) => String(value)}
        testId="meter-exports"
      />
      <Meter
        label="Asset storage"
        used={usage.storageBytes}
        limit={limits.storageBytes}
        format={formatBytes}
        testId="meter-storage"
      />
      <Meter
        label="Seats"
        used={usage.seats}
        limit={limits.seats}
        format={(value) => String(value)}
        testId="meter-seats"
      />

      {!limits.customAssets && (
        <p className="panel-hint">Uploading your own models is part of {PLAN_NAMES.pro}.</p>
      )}

      {summary.checkoutAvailable ? (
        <div className="billing-actions">
          {next && (
            <button type="button" onClick={() => void upgrade(next)} disabled={busy}>
              Upgrade to {PLAN_NAMES[next]}
              {PLAN_PRICES[next] === null ? '' : ` — $${PLAN_PRICES[next]}/month`}
            </button>
          )}
          {subscription.status !== 'none' && (
            <button type="button" onClick={() => void manage()} disabled={busy}>
              Manage billing
            </button>
          )}
        </div>
      ) : (
        // A deployment with no payment provider — a self-hosted install — says so rather than
        // offering a button that fails. The limits are still enforced; an administrator sets the
        // tier directly.
        <p className="panel-hint" data-testid="billing-unavailable">
          This server is not set up to take payments. An administrator sets the plan.
        </p>
      )}

      {error !== '' && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * One meter.
 *
 * A `<meter>` element rather than a styled div, because it is exactly what the element is for and
 * it carries the value to a screen reader without any work. Over-limit is shown rather than clamped:
 * somebody who has downgraded is *over*, and a bar pinned at full would hide by how much.
 */
function Meter({
  label,
  used,
  limit,
  format,
  testId,
}: {
  label: string;
  used: number;
  limit: number;
  format: (value: number) => string;
  testId: string;
}): React.JSX.Element {
  const over = used > limit;
  return (
    <p className={`billing-meter${over ? ' over' : ''}`} data-testid={testId}>
      <span className="billing-meter-label">{label}</span>
      <meter value={Math.min(used, limit)} max={limit} aria-label={label} />
      <span className="billing-meter-value">
        {format(used)} of {format(limit)}
        {over && <span className="billing-warning"> — over</span>}
      </span>
    </p>
  );
}
