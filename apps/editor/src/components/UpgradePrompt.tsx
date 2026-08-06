import { useCallback, useState } from 'react';
import { PLAN_NAMES, PLAN_PRICES } from '@helaengine/schema';
import type { LimitReached } from '../storage/billing';
import { Billing } from '../storage/billing';
import { currentSession } from '../storage/backend';

/**
 * What a plan limit looks like when somebody hits one.
 *
 * The point of this component is that it is the *same* one wherever the limit was hit — an upload,
 * an invitation, an export. A product where running out of exports shows a modal with a button and
 * running out of storage shows a red toast teaches people that some refusals are negotiable and
 * others are not, and they stop reading either.
 *
 * It is driven entirely by the structured 402 body: which limit, what the allowance is, what was
 * used, and the cheapest plan that lifts it. No string matching, so improving the server's wording
 * cannot silently turn this back into a dead end.
 */
export function UpgradePrompt({
  limit,
  onDismiss,
}: {
  limit: LimitReached;
  onDismiss: () => void;
}): React.JSX.Element {
  const session = currentSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { detail } = limit;

  const upgrade = useCallback(async () => {
    if (!session || !detail.upgradeTo) return;
    setBusy(true);
    try {
      const client = new Billing(session);
      window.location.href = await client.checkout(detail.upgradeTo, window.location.href);
    } catch (problem: unknown) {
      setError(problem instanceof Error ? problem.message : String(problem));
      setBusy(false);
    }
  }, [session, detail.upgradeTo]);

  return (
    <div
      className="upgrade-prompt"
      role="alertdialog"
      aria-label="Plan limit"
      data-testid="upgrade-prompt"
    >
      <p className="upgrade-message" data-limit-kind={detail.kind}>
        {detail.error}
      </p>

      <div className="upgrade-actions">
        {detail.upgradeTo === null ? (
          // Nothing on the menu lifts it. An upgrade button here would lead to a checkout that
          // cannot help, which is worse than no button.
          <a href="mailto:hello@helaengine.dev">Get in touch</a>
        ) : (
          <button type="button" onClick={() => void upgrade()} disabled={busy || !session}>
            {busy
              ? 'Opening checkout…'
              : `Upgrade to ${PLAN_NAMES[detail.upgradeTo]}${
                  PLAN_PRICES[detail.upgradeTo] === null
                    ? ''
                    : ` — $${PLAN_PRICES[detail.upgradeTo]}/month`
                }`}
          </button>
        )}
        <button type="button" onClick={onDismiss}>
          Not now
        </button>
      </div>

      {error !== '' && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Narrows an unknown rejection to the one this prompt understands. */
export function asLimit(error: unknown): LimitReached | null {
  return error !== null && typeof error === 'object' && (error as Error).name === 'LimitReached'
    ? (error as LimitReached)
    : null;
}
