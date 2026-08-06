import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biggestDropOff, funnelFrom, type FunnelRecord } from '@helaengine/schema';
import { anonymousId, configureFunnel, LocalAnalytics, track, trackFirst } from './funnel';

/**
 * Sprint 38 — the funnel.
 *
 * The plan wants drop-off found quantitatively rather than anecdotally, which puts the weight on two
 * things a dashboard cannot check for you: that a step counts *people* rather than events, and that
 * a "first" event really only fires once. Both failures produce a chart that looks fine and lies —
 * a placement step wider than the create step above it reads as a data problem nobody investigates.
 */

function record(event: string, who: string): FunnelRecord {
  return {
    event: event as FunnelRecord['event'],
    anonymousId: who,
    at: new Date().toISOString(),
    properties: {},
  };
}

let sink: LocalAnalytics;

beforeEach(() => {
  localStorage.clear();
  sink = new LocalAnalytics();
  configureFunnel(sink);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the drop-off table', () => {
  it('counts people, not events', () => {
    const steps = funnelFrom([
      record('signup', 'a'),
      record('signup', 'b'),
      record('project_created', 'a'),
      record('project_created', 'b'),
      // One person saving eleven times is one person who saved. Counting events here would make
      // the save step wider than the create step above it, and a funnel that widens is a funnel
      // nobody believes.
      ...Array.from({ length: 11 }, () => record('project_saved', 'a')),
    ]);

    const saved = steps.find((step) => step.event === 'project_saved')!;
    expect(saved.reached).toBe(1);
  });

  it('reports conversion against the step before it', () => {
    const steps = funnelFrom([
      record('signup', 'a'),
      record('signup', 'b'),
      record('signup', 'c'),
      record('signup', 'd'),
      record('project_created', 'a'),
      record('project_created', 'b'),
    ]);

    expect(steps[0]!.conversion).toBe(1);
    expect(steps[1]!.conversion).toBeCloseTo(0.5, 5);
  });

  it('names the worst step, which is the question the plan asks', () => {
    const everyone = ['a', 'b', 'c', 'd'];
    const steps = funnelFrom([
      ...everyone.map((who) => record('signup', who)),
      ...everyone.map((who) => record('project_created', who)),
      // Three of four place something; only one of those three saves. The save step is a 67% fall
      // and the placement step a 25% one, so the save step is the finding.
      ...['a', 'b', 'c'].map((who) => record('object_placed', who)),
      record('project_saved', 'a'),
      record('export_started', 'a'),
      record('export_completed', 'a'),
    ]);

    expect(biggestDropOff(steps)?.event).toBe('project_saved');
  });

  it('treats a step nobody reached as a total drop, because it is one', () => {
    // My first version of the test above expected `project_saved` from data where nobody reached
    // the export steps at all — and the function said `export_started`, correctly. A tail nobody
    // gets to is a 100% fall and outranks any partial one. Worth pinning rather than papering
    // over: with sparse data the answer will often be "nobody exports", which is actionable, and
    // whoever reads the number should know that is what it means.
    const steps = funnelFrom([
      record('signup', 'a'),
      record('project_created', 'a'),
      record('object_placed', 'a'),
      record('project_saved', 'a'),
    ]);

    const worst = biggestDropOff(steps);
    expect(worst?.event).toBe('export_started');
    expect(worst?.conversion).toBe(0);
  });


  it('does not divide by zero when a step nobody reached is followed by another', () => {
    const steps = funnelFrom([record('signup', 'a')]);
    expect(steps.every((step) => Number.isFinite(step.conversion))).toBe(true);
  });
});

describe('recording', () => {
  it('records a first-time milestone once, however many times it happens', () => {
    trackFirst('object_placed', { objectCount: 1 });
    trackFirst('object_placed', { objectCount: 2 });
    trackFirst('object_placed', { objectCount: 3 });

    expect(sink.all().filter((row) => row.event === 'object_placed')).toHaveLength(1);
  });

  it('records a repeatable milestone every time', () => {
    // `export_completed` is not a "first": the interesting number is how many exports failed, and
    // that needs every one of them.
    track('export_completed', { outcome: 'succeeded' });
    track('export_completed', { outcome: 'failed' });

    expect(sink.all().filter((row) => row.event === 'export_completed')).toHaveLength(2);
  });

  it('drops an event that does not validate instead of throwing at the caller', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Analytics must never be able to break the editor — a save that throws because a funnel event
    // was malformed is a data-loss bug caused by a metric.
    expect(() =>
      track('not_a_real_event' as Parameters<typeof track>[0], {}),
    ).not.toThrow();
    expect(sink.all()).toHaveLength(0);
  });

  it('carries no scene contents, only counts', () => {
    trackFirst('object_placed', { objectCount: 7 });
    const [row] = sink.all();

    // The schema is `.strict()`, so this is enforced rather than merely intended: a future caller
    // that tries to attach an asset id or a project name fails validation and is dropped.
    expect(Object.keys(row!.properties).sort()).toEqual(['objectCount', 'sinceSessionStartMs']);
  });

  it('keeps one anonymous id per browser, and it is not an account id', () => {
    const first = anonymousId();
    expect(anonymousId()).toBe(first);
    expect(first).toMatch(/^anon_[a-z0-9]+$/i);
  });

  it('survives storage being unavailable', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };

    try {
      expect(() => track('signup')).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it('discards rows a previous version wrote that no longer validate', () => {
    localStorage.setItem(
      'helaengine.funnel',
      JSON.stringify([{ event: 'from_an_older_build', anonymousId: 'a', at: 'not-a-date' }]),
    );

    // Stored data is as untrusted as a file on disk. One bad row must not poison the history.
    expect(new LocalAnalytics().all()).toEqual([]);
  });
});
