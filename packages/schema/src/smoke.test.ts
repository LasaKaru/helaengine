import { describe, expect, it } from 'vitest';
import {
  isReleasable,
  parseSmokeReport,
  SMOKE_CHECK_ORDER,
  SmokeCheckIdSchema,
  type SmokeCheckId,
  type SmokeCheckStatus,
} from './smoke.js';

/**
 * The release rule, tested without a browser.
 *
 * The gate itself is proved in `tools/smoke`, which takes two minutes and needs a real build. What
 * is here is the *rule* — what a report has to say before anybody may have the build — because that
 * is the sentence Sprint 26 will hang a download button on, and it should not take a browser to
 * find out that it changed.
 */

function report(
  statuses: Partial<Record<SmokeCheckId, SmokeCheckStatus>>,
  fallback: SmokeCheckStatus = 'passed',
): ReturnType<typeof parseSmokeReport> {
  const checks = SMOKE_CHECK_ORDER.map((id) => ({
    id,
    status: statuses[id] ?? fallback,
    detail: 'because',
  }));

  return parseSmokeReport({
    buildId: 'build',
    sceneName: 'Scene',
    passed: checks.every((check) => check.status === 'passed' || check.status === 'not-applicable'),
    checks,
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
  });
}

describe('the check vocabulary', () => {
  it('is closed', () => {
    // The point of the enum: Sprint 25 maps a failed check to a repair, and a `switch` that forgets
    // an arm has to be a compile error rather than a failure nobody wrote a repair for.
    expect(SmokeCheckIdSchema.safeParse('vibes-are-good').success).toBe(false);
    expect(SMOKE_CHECK_ORDER).toHaveLength(7);
  });

  it('runs in an order where each check depends on the ones above it', () => {
    // A report whose checks are out of order is a report where a skip means something different.
    expect([...SMOKE_CHECK_ORDER]).toEqual([
      'page-loads',
      'assets-resolve',
      'scene-loaded',
      'physics-initialises',
      'player-moves',
      'player-survives-idle',
      'memory-stable',
    ]);
  });
});

describe('isReleasable', () => {
  it('releases a build where everything passed', () => {
    expect(isReleasable(report({}))).toBe(true);
  });

  it('releases a static build, whose player checks do not apply', () => {
    expect(
      isReleasable(
        report({
          'physics-initialises': 'not-applicable',
          'player-moves': 'not-applicable',
          'player-survives-idle': 'not-applicable',
        }),
      ),
    ).toBe(true);
  });

  it('refuses a build with a failure', () => {
    expect(isReleasable(report({ 'player-moves': 'failed' }))).toBe(false);
  });

  it('refuses a build with a skip, which is the whole point', () => {
    // "Nothing failed" is not the same claim as "it works". A scene that never loaded leaves six
    // checks unrun, and counting those as fine is exactly how a gate stops being one.
    expect(isReleasable(report({ 'player-moves': 'skipped' }))).toBe(false);
  });

  it('refuses a report that is missing checks entirely', () => {
    const partial = parseSmokeReport({
      buildId: 'build',
      sceneName: 'Scene',
      passed: true,
      checks: [{ id: 'page-loads', status: 'passed', detail: 'fine' }],
      startedAt: new Date(0).toISOString(),
      durationMs: 1,
    });

    // A report can only clear a build for the checks it actually ran. One green tick out of seven
    // is not a pass, however cheerful the `passed` flag on it happens to be.
    expect(isReleasable(partial)).toBe(false);
  });
});

describe('parseSmokeReport', () => {
  it('fills in the parts a caller may leave out', () => {
    const parsed = parseSmokeReport({
      buildId: 'build',
      sceneName: 'Scene',
      passed: true,
      checks: [{ id: 'page-loads', status: 'passed', detail: 'fine' }],
      startedAt: new Date(0).toISOString(),
      durationMs: 1,
    });

    expect(parsed.checks[0]!.evidence).toEqual({});
    expect(parsed.checks[0]!.durationMs).toBe(0);
    expect(parsed.errors).toEqual([]);
  });

  it('rejects a report that invents a check', () => {
    expect(() =>
      parseSmokeReport({
        buildId: 'build',
        sceneName: 'Scene',
        passed: true,
        checks: [{ id: 'looks-nice', status: 'passed', detail: 'fine' }],
        startedAt: new Date(0).toISOString(),
        durationMs: 1,
      }),
    ).toThrow();
  });
});
