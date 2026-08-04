import { describe, expect, it } from 'vitest';
import {
  isReleasable,
  parseAssetManifest,
  parseScene,
  type AssetManifest,
  type Scene,
} from '@helaengine/schema';
import { explainBlock } from './gate';
import { validateScene, type PreviewHandle } from './validateScene';

/**
 * Sprint 26 — the gate the user meets, without a browser.
 *
 * The preview is injected, so these are tests of the *rule*: what counts as releasable, what counts
 * as a skip rather than a pass, and what somebody is told when their build is refused. Whether a
 * real Play Preview reports the right numbers is an e2e question, and is asked there.
 */

const manifest: AssetManifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'building_hut_01', name: 'Hut', category: 'buildings', glbPath: 'models/hut.glb' },
  ],
});

function scene(overrides: Record<string, unknown> = {}): Scene {
  return parseScene({
    sceneId: 'scene_gate',
    version: 1,
    name: 'Gate Test',
    objects: [{ id: 'obj_0001', assetId: 'building_hut_01', transform: { position: [0, 0, 0] } }],
    ...overrides,
  });
}

/** A preview that behaves however a test needs it to, without a canvas anywhere near it. */
function fakePreview(
  behaviour: Partial<PreviewHandle> & { moveTo?: [number, number, number] } = {},
) {
  let position: [number, number, number] = [0, 0, 0];

  const handle: PreviewHandle = {
    start: async () => Promise.resolve({ sceneReady: true, physicsReady: true }),
    stop: async () => Promise.resolve(),
    position: () => position,
    health: () => 100,
    walkForward: async () => {
      if (behaviour.moveTo) position = behaviour.moveTo;
      return Promise.resolve();
    },
    wait: async () => Promise.resolve(),
    errors: () => [],
    failedAssets: () => [],
    heap: () => null,
    ...behaviour,
  };
  return handle;
}

describe('validateScene', () => {
  it('releases a scene whose player can walk and is not being hurt', async () => {
    const report = await validateScene({
      scene: scene(),
      manifest,
      preview: fakePreview({ moveTo: [0, 0, 4] }),
    });

    expect(isReleasable(report)).toBe(true);
    expect(report.checks).toHaveLength(7);
  });

  it("refuses a player who cannot move, and says why in the user's terms", async () => {
    const report = await validateScene({
      scene: scene(),
      manifest,
      // Held forward and went nowhere: the spawn is inside something.
      preview: fakePreview(),
    });

    expect(isReleasable(report)).toBe(false);
    const failed = report.checks.find((check) => check.id === 'player-moves')!;
    expect(failed.status).toBe('failed');
    expect(failed.detail).toContain('could not move');
    // Not a stack trace, and not an id.
    expect(failed.detail).not.toContain('undefined');
  });

  it('tells a fall-through apart from being stuck', async () => {
    const report = await validateScene({
      scene: scene(),
      manifest,
      preview: fakePreview({ moveTo: [0, -400, 0] }),
    });

    const failed = report.checks.find((check) => check.id === 'player-moves')!;
    expect(failed.status).toBe('failed');
    expect(failed.detail).toContain('fell out of the world');
    // The evidence is what a repair reads, so it has to carry the spawn.
    expect(failed.evidence['spawn']).toEqual([0, 0, 0]);
  });

  it('refuses a player who is losing health while standing still', async () => {
    const report = await validateScene({
      scene: scene(),
      manifest,
      preview: fakePreview({ moveTo: [0, 0, 4], health: () => 60 }),
    });

    expect(isReleasable(report)).toBe(false);
    const failed = report.checks.find((check) => check.id === 'player-survives-idle')!;
    expect(failed.detail).toContain('40 health');
  });

  it('names an asset the library does not have, before anything is downloaded', async () => {
    const report = await validateScene({
      scene: scene({
        objects: [{ id: 'obj_0001', assetId: 'ghost_asset', transform: { position: [0, 0, 0] } }],
      }),
      manifest,
      preview: fakePreview({ moveTo: [0, 0, 4] }),
    });

    const failed = report.checks.find((check) => check.id === 'assets-resolve')!;
    expect(failed.status).toBe('failed');
    expect(failed.detail).toContain('ghost_asset');
  });

  it('skips rather than passes what it could not check', async () => {
    // The world never built. Six checks could not run, and a report that called them fine would be
    // a gate that lets an unproven build through — which is the whole failure mode being avoided.
    const report = await validateScene({
      scene: scene(),
      manifest,
      preview: fakePreview({
        start: async () => Promise.resolve({ sceneReady: false, physicsReady: false }),
      }),
    });

    expect(isReleasable(report)).toBe(false);
    for (const id of ['physics-initialises', 'player-moves', 'player-survives-idle']) {
      expect(report.checks.find((check) => check.id === id)!.status).toBe('skipped');
    }
  });

  it('does not claim to have checked the export itself', async () => {
    // Play Preview shares the editor's page, so "the page loaded without throwing" is a question
    // about the editor. Answering it here under the same name would be answering a different one.
    const report = await validateScene({
      scene: scene(),
      manifest,
      preview: fakePreview({ moveTo: [0, 0, 4] }),
    });

    expect(report.checks.find((check) => check.id === 'page-loads')!.status).toBe('not-applicable');
  });
});

describe('what the user is told when a build is blocked', () => {
  it('gives a headline and something to actually do', async () => {
    const report = await validateScene({ scene: scene(), manifest, preview: fakePreview() });
    const { headline, suggestion } = explainBlock(report);

    expect(headline).toContain('could not move');
    expect(suggestion).toContain('start point');
    // Never an empty string: a refusal with no advice is a dead end with a spinner's manners.
    expect(suggestion.length).toBeGreaterThan(20);
  });

  it('has advice for every check that can fail', async () => {
    // Keyed on the closed vocabulary, so a new check cannot ship without the sentence that goes
    // with it — which is how "never an unexplained rejection" stays true as the gate grows.
    const report = await validateScene({ scene: scene(), manifest, preview: fakePreview() });
    for (const check of report.checks) {
      const explained = explainBlock({
        ...report,
        checks: [{ ...check, status: 'failed' }],
      });
      expect(explained.suggestion, `no advice for ${check.id}`).toBeTruthy();
    }
  });
});
