import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeRepairs, isReleasable } from '@helaengine/schema';
import { LlmRepairModel } from '@helaengine/repair';
import { BREAKAGES, sceneFor } from './fixtures.js';
import { repairLoop } from './loop.js';
import { REPAIRABLE } from './repairable.js';
import { stagingIsReady } from './stage.js';

/**
 * Sprint 25 — the repair loop, end to end.
 *
 * Every run here builds a real export, plays it, patches the document, rebuilds and plays it again.
 * The claim being tested is not "the patch parses" — that is a unit test in `packages/repair` — but
 * "the broken build became a working one, and a deterministic play-test agreed."
 */

let workspace: string;

beforeAll(async () => {
  const missing = await stagingIsReady();
  if (missing) throw new Error(`cannot stage builds: ${missing} is missing. Run pnpm build first.`);
  workspace = await mkdtemp(join(tmpdir(), 'helaengine-repair-'));
}, 120_000);

describe('broken scenes are detected and repaired within the retry budget', () => {
  for (const breakage of REPAIRABLE) {
    it(`${breakage.id}: ${breakage.what}`, async () => {
      const scene = breakage.breakScene
        ? breakage.breakScene(sceneFor(breakage.template))
        : sceneFor(breakage.template);

      const result = await repairLoop({
        scene,
        buildId: breakage.id,
        into: join(workspace, breakage.id),
        ...(breakage.breakBuild ? { breakBuild: breakage.breakBuild } : {}),
      });

      const trail = result.log.attempts
        .map((attempt) => `${attempt.attempt}. ${attempt.failing} → ${attempt.outcome}`)
        .join('; ');

      expect(result.log.releasable, `not repaired. Attempts: ${trail}`).toBe(true);
      expect(isReleasable(result.report)).toBe(true);

      // It failed for the reason the fixture intended, before it was fixed.
      expect(result.log.attempts[0]!.failing).toBe(breakage.detects);
      // And it was fixed the right way, not by luck.
      expect(result.log.applied).toHaveLength(1);
      expect(result.log.applied[0]!.patch.op).toBe(breakage.expectOp);

      // Within budget, which is the whole point of bounding it.
      expect(result.log.attempts.length).toBeLessThanOrEqual(3);

      // And the person whose scene it is gets told, in a sentence written for them.
      const disclosure = describeRepairs(result.log);
      expect(disclosure).toHaveLength(1);
      expect(disclosure[0]!.length).toBeGreaterThan(40);
    }, 900_000);
  }
});

describe('what the loop refuses to touch', () => {
  it('will not rearrange a level to fix a corrupted engine bundle', async () => {
    const wasm = BREAKAGES.find((breakage) => breakage.id === 'damaged-physics-wasm')!;
    // Built once and held. `sceneFor` mints a fresh `sceneId` on every call, so comparing the
    // result against a second call would fail for a reason that has nothing to do with repair.
    const original = sceneFor(wasm.template);

    const result = await repairLoop({
      scene: original,
      buildId: 'refuses-wasm',
      into: join(workspace, 'refuses-wasm'),
      breakBuild: wasm.breakBuild!,
    });

    // Blocked, and blocked without having edited anything. A loop that spent three attempts moving
    // spawn points at a broken bundle would be destroying work to fix a fault it cannot reach.
    expect(result.log.releasable).toBe(false);
    expect(result.log.applied).toEqual([]);
    expect(result.log.attempts).toEqual([]);
    expect(result.scene).toBe(original);
  }, 900_000);

  it('leaves a healthy build completely alone', async () => {
    const result = await repairLoop({
      scene: sceneFor('forest-clearing'),
      buildId: 'already-fine',
      into: join(workspace, 'already-fine'),
    });

    expect(result.log.releasable).toBe(true);
    expect(result.log.attempts).toEqual([]);
    expect(describeRepairs(result.log)).toEqual([]);
  }, 900_000);
});

describe('a model that misbehaves cannot damage a scene', () => {
  it('records the rejection, changes nothing, and gives up inside the budget', async () => {
    // The proposal names an operation that does not exist. This is the shape of both an
    // incompetent model and a compromised one, and the loop must not be able to tell them apart —
    // it refuses on the schema, not on intent.
    const hostile = new LlmRepairModel(
      async () =>
        Promise.resolve(
          '{"patch":{"op":"runScript","code":"fetch(\'http://evil.invalid\')"},' +
            '"reason":"trust me","fixes":"player-moves"}',
        ),
      'hostile-stub',
    );

    const broken = REPAIRABLE[0]!;
    const scene = broken.breakScene!(sceneFor(broken.template));

    const result = await repairLoop({
      scene,
      buildId: 'hostile',
      into: join(workspace, 'hostile'),
      model: hostile,
      maxAttempts: 2,
    });

    expect(result.log.releasable).toBe(false);
    expect(result.log.applied).toEqual([]);
    // The scene it started with, byte for byte.
    expect(result.scene).toEqual(scene);

    // Every attempt refused, and the log says so — which is what makes the refusals auditable
    // rather than merely absent.
    expect(result.log.attempts).toHaveLength(2);
    for (const attempt of result.log.attempts) {
      expect(attempt.outcome).toBe('rejected');
      expect(attempt.proposedBy).toBe('hostile-stub');
      expect(attempt.rejection).toBeTruthy();
    }
  }, 900_000);
});
