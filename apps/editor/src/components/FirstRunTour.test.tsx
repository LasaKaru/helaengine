import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirstRunTour, TOUR_SEEN_KEY } from './FirstRunTour';

/**
 * Sprint 38 — the first-run tour.
 *
 * The plan's instruction is the design brief: *"keep it skippable and short, most users tune out
 * long tours"*. Skippable is the part worth testing, because the failure is specific and infuriating
 * — a tour you dismissed that greets you again on the next reload. So the flag is written when it is
 * *skipped*, not when it is completed, and these check that from both ends.
 */

/** The editor chrome the tour points at, so the steps have something to measure. */
function mountEditorChrome(): void {
  document.body.innerHTML = `
    <div class="editor">
      <div class="topbar"><div class="topbar-actions"><button>Save</button></div></div>
      <div class="workspace">
        <div class="rail rail-left"><section class="panel panel-assets"></section>
          <section class="panel panel-tree"></section></div>
        <div class="viewport"></div>
        <div class="rail rail-right"></div>
      </div>
    </div>`;
}

beforeEach(() => {
  localStorage.clear();
  mountEditorChrome();
});

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the first-run tour', () => {
  it('opens on a first visit', () => {
    render(<FirstRunTour />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('1 of 5')).toBeInTheDocument();
  });

  it('never opens again once skipped', async () => {
    const first = render(<FirstRunTour />);
    await userEvent.click(screen.getByRole('button', { name: /Skip tour/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    first.unmount();

    // A fresh mount is what a reload looks like. This is the whole point of the feature: a tour
    // that comes back after you dismissed it is worse than never having shown one.
    render(<FirstRunTour />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape, and stays closed', async () => {
    const first = render(<FirstRunTour />);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    first.unmount();

    render(<FirstRunTour />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('walks forward and finishes', async () => {
    render(<FirstRunTour />);

    for (let step = 1; step < 5; step += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    }

    // The last step offers a way out that reads like a beginning rather than a dismissal.
    await userEvent.click(screen.getByRole('button', { name: /Start building/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe('1');
  });

  it('skips a step whose element is not on screen rather than pointing at nothing', () => {
    // The right rail is absent for some layouts, and a tour that rings empty space teaches people
    // to stop trusting it. Four elements present means four steps, not five with a blank one.
    document.querySelector('.rail-right')?.remove();

    render(<FirstRunTour />);
    expect(screen.getByText('1 of 4')).toBeInTheDocument();
  });

  it('still opens when storage is unavailable', () => {
    // Private browsing throws on read. The editor must not fail to render over a preference.
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('denied');
    };

    try {
      render(<FirstRunTour />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
