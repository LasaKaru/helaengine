import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isReleasable, SmokeReportSchema, type SmokeReport } from '@helaengine/schema';
import { BREAKAGES, GOOD_TEMPLATES, sceneFor } from './fixtures.js';
import { runSmokeTest } from './harness.js';
import { stageExport, stagingIsReady } from './stage.js';

/**
 * Sprint 24 — the gate, tested on itself.
 *
 * Every build here is a real export: the same `buildExport` the Export button calls, the same asset
 * library, the same engine bundle, served over HTTP by a host that gets its content types right,
 * and played by a real browser. Nothing is mocked, because the failures worth catching all live in
 * the difference between a real build and a convincing description of one.
 *
 * The suite has two halves and they carry different weight. Five known-good templates passing says
 * the gate does not cry wolf. Three deliberately broken builds failing *on the right check* says it
 * is a gate at all — a validator that reports "something went wrong" is a validator that gets
 * ignored, and one nobody has watched fail is one nobody should trust.
 */

let workspace: string;

beforeAll(async () => {
  const missing = await stagingIsReady();
  if (missing) {
    throw new Error(
      `cannot stage builds: ${missing} is not there. Run \`pnpm ingest-assets\` and \`pnpm build\` first.`,
    );
  }
  workspace = await mkdtemp(join(tmpdir(), 'helaengine-smoke-'));
}, 120_000);

async function stageAndRun(
  templateId: string,
  options: {
    breakScene?: (scene: ReturnType<typeof sceneFor>) => ReturnType<typeof sceneFor>;
    breakBuild?: (root: string) => Promise<void>;
    label: string;
  },
): Promise<SmokeReport> {
  const scene = options.breakScene
    ? options.breakScene(sceneFor(templateId))
    : sceneFor(templateId);
  const root = await stageExport(scene, { into: join(workspace, options.label) });
  if (options.breakBuild) await options.breakBuild(root);

  const report = await runSmokeTest(root, { buildId: options.label });
  // Parsed, not merely returned: the report is a contract Sprint 25's repair loop and Sprint 26's
  // report UI both read, and a shape that drifts would break them silently.
  return SmokeReportSchema.parse(report);
}

describe('known-good builds pass', () => {
  for (const templateId of GOOD_TEMPLATES) {
    it(`${templateId} exports to a build that plays`, async () => {
      const report = await stageAndRun(templateId, { label: `good-${templateId}` });

      // The assertion message carries the failing checks, because a bare `false !== true` on a
      // five-minute test is a bug report nobody can act on.
      const failures = report.checks
        .filter((check) => check.status !== 'passed' && check.status !== 'not-applicable')
        .map((check) => `${check.id}: ${check.detail}`);

      expect(failures, `${templateId} should have released cleanly`).toEqual([]);
      expect(isReleasable(report)).toBe(true);
      expect(report.checks).toHaveLength(7);
    }, 600_000);
  }
});

describe('deliberately broken builds fail, on the right check', () => {
  for (const breakage of BREAKAGES) {
    it(`${breakage.id}: ${breakage.what}`, async () => {
      const report = await stageAndRun(breakage.template, {
        label: `broken-${breakage.id}`,
        ...(breakage.breakScene ? { breakScene: breakage.breakScene } : {}),
        ...(breakage.breakBuild ? { breakBuild: breakage.breakBuild } : {}),
      });

      expect(isReleasable(report), 'a broken build must never be releasable').toBe(false);

      const named = report.checks.find((check) => check.id === breakage.expect);
      expect(named, `${breakage.expect} should be in the report`).toBeDefined();
      expect(
        named!.status,
        `expected ${breakage.expect} to fail; report was ${JSON.stringify(
          report.checks.map((check) => `${check.id}=${check.status}`),
        )}`,
      ).toBe('failed');

      // Specific and identifiable, which is the point: the detail has to be a sentence somebody
      // could act on, and the evidence has to be what a repair would need to read.
      expect(named!.detail.length).toBeGreaterThan(20);
      expect(Object.keys(named!.evidence).length).toBeGreaterThan(0);
    }, 600_000);
  }
});

describe('a static export is judged as a static export', () => {
  it('passes without being asked to move a player it does not have', async () => {
    const root = await stageExport(sceneFor('forest-clearing'), {
      mode: 'static',
      into: join(workspace, 'static-forest'),
    });
    const report = SmokeReportSchema.parse(await runSmokeTest(root, { buildId: 'static-forest' }));

    expect(isReleasable(report)).toBe(true);
    // Not passed, and not failed. Failing a static export for having no player would be failing it
    // for doing exactly what it was asked to do.
    for (const id of ['physics-initialises', 'player-moves', 'player-survives-idle']) {
      expect(report.checks.find((check) => check.id === id)!.status).toBe('not-applicable');
    }
  }, 600_000);
});

describe('the report is honest about what it did not check', () => {
  it('records a skip rather than a pass when the scene never loads', async () => {
    const root = await stageExport(sceneFor('blank'), { into: join(workspace, 'no-scene') });
    // Emptying scene.json is the crudest possible hang: the module throws while parsing it, so
    // nothing downstream can run and nothing downstream may claim to have been checked.
    await rm(join(root, 'scene.json'));

    const report = SmokeReportSchema.parse(
      await runSmokeTest(root, { buildId: 'no-scene', loadTimeoutMs: 20_000 }),
    );

    expect(isReleasable(report)).toBe(false);
    expect(report.checks.find((check) => check.id === 'scene-loaded')!.status).toBe('failed');
    for (const id of ['physics-initialises', 'player-moves', 'player-survives-idle']) {
      expect(report.checks.find((check) => check.id === id)!.status).toBe('skipped');
    }
  }, 300_000);
});
