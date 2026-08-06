import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingSummary } from '@helaengine/schema';
import { BillingPanel } from './BillingPanel';
import { UpgradePrompt } from './UpgradePrompt';
import { LimitReached } from '../storage/billing';
import { signIn, signOut } from '../storage/backend';

/**
 * The plan screen and the prompt a limit produces.
 *
 * Every number rendered here comes from the server's own counting, so these tests feed it exactly
 * what the API returns and check that nothing is recomputed on the way to the screen — a client
 * that derives "remaining" itself is a client that will eventually disagree with the server that
 * enforces it.
 */

function summary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    subscription: {
      organizationId: 'org-1',
      tier: 'free',
      status: 'none',
      externalId: null,
      currentPeriodEnd: null,
      cancelAt: null,
      updatedAt: new Date().toISOString(),
    },
    limits: {
      seats: 2,
      storageBytes: 512 * 1024 * 1024,
      exportsPerPeriod: 5,
      customAssets: false,
      collaborators: 2,
      sso: false,
    },
    usage: { seats: 1, storageBytes: 128 * 1024 * 1024, exports: 3 },
    checkoutAvailable: true,
    ...overrides,
  };
}

function answerWith(body: BillingSummary): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    ),
  );
}

beforeEach(() => {
  signIn({
    origin: 'https://api.example.com',
    token: 'a-token',
    organizationId: 'org-1',
    userId: 'user-1',
    displayName: 'Someone',
  });
});

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the plan panel', () => {
  it('shows the plan and the meters the server counted', async () => {
    answerWith(summary());
    render(<BillingPanel />);

    expect(await screen.findByTestId('billing-plan')).toHaveTextContent('Free');
    // Straight from the response, not recomputed: the meter and the enforcement must never be able
    // to disagree.
    expect(screen.getByTestId('meter-exports')).toHaveTextContent('3 of 5');
    expect(screen.getByTestId('meter-storage')).toHaveTextContent('128 MB of 512 MB');
    expect(screen.getByTestId('meter-seats')).toHaveTextContent('1 of 2');
  });

  it('says plainly when a plan does not include uploads', async () => {
    answerWith(summary());
    render(<BillingPanel />);
    expect(await screen.findByText(/Uploading your own models is part of Pro/)).toBeInTheDocument();
  });

  it('marks a meter that is over, rather than pinning it at full', async () => {
    // What a downgrade looks like. A bar clamped to 100% would hide by how much.
    answerWith(summary({ usage: { seats: 4, storageBytes: 900 * 1024 * 1024, exports: 3 } }));
    render(<BillingPanel />);

    const storage = await screen.findByTestId('meter-storage');
    expect(storage).toHaveTextContent('over');
    expect(storage.className).toContain('over');
  });

  it('says a payment failed without implying the work is at risk', async () => {
    answerWith(
      summary({
        subscription: { ...summary().subscription, tier: 'pro', status: 'past_due' },
      }),
    );
    render(<BillingPanel />);

    const plan = await screen.findByTestId('billing-plan');
    expect(plan).toHaveTextContent(/Nothing has stopped\s+working/);
  });

  it('offers no upgrade button on a server that cannot take payments', async () => {
    // A self-hosted install. A button that fails is worse than no button.
    answerWith(summary({ checkoutAvailable: false }));
    render(<BillingPanel />);

    expect(await screen.findByTestId('billing-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
  });

  it('shows nothing at all without an account', () => {
    signOut();
    const { container } = render(<BillingPanel />);
    // The editor is entirely usable on IndexedDB; a plan panel there would advertise a shop that
    // is not open.
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the prompt a limit produces', () => {
  const limit = new LimitReached({
    error: 'Uploading your own models is part of the Pro plan. Pro lifts it.',
    kind: 'customAssets',
    tier: 'free',
    limit: 0,
    used: 1,
    upgradeTo: 'pro',
  });

  it('says which limit was hit and offers the plan that lifts it', () => {
    render(<UpgradePrompt limit={limit} onDismiss={() => {}} />);

    expect(screen.getByTestId('upgrade-prompt')).toHaveTextContent('Pro');
    // The kind is on the element rather than parsed out of the sentence, which is the whole reason
    // the API answers with structured data.
    expect(screen.getByText(/Uploading your own models/)).toHaveAttribute(
      'data-limit-kind',
      'customAssets',
    );
    expect(screen.getByRole('button', { name: /Upgrade to Pro/ })).toBeInTheDocument();
  });

  it('offers a conversation rather than a dead button when no plan lifts it', () => {
    render(
      <UpgradePrompt
        limit={new LimitReached({ ...limit.detail, upgradeTo: null, kind: 'seats' })}
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Get in touch/ })).toBeInTheDocument();
  });

  it('can be dismissed', async () => {
    const dismissed = vi.fn();
    render(<UpgradePrompt limit={limit} onDismiss={dismissed} />);
    await userEvent.click(screen.getByRole('button', { name: /Not now/ }));
    expect(dismissed).toHaveBeenCalled();
  });

  it('sends the browser to checkout when the upgrade is taken', async () => {
    const url = 'https://checkout.example.com/session';
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ url }), { headers: { 'content-type': 'application/json' } }),
      ),
    );
    // jsdom refuses a real navigation, so the assignment itself is what is observed.
    const location = { href: '' } as Location;
    vi.stubGlobal('location', location);

    render(<UpgradePrompt limit={limit} onDismiss={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));

    await waitFor(() => expect(location.href).toBe(url));
  });
});
