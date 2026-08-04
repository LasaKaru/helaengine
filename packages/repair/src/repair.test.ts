import { describe, expect, it } from 'vitest';
import { parseScene, type Scene, type SmokeCheckResult } from '@helaengine/schema';
import { applyPatch } from './apply.js';
import { extractContext, firstRepairableFailure, isRepairable } from './context.js';
import { extractJson, LlmRepairModel, validateProposal } from './model.js';
import { proposeByRule } from './rules.js';

function scene(overrides: Record<string, unknown> = {}): Scene {
  return parseScene({
    sceneId: 'scene_repair',
    version: 1,
    name: 'Repair Test',
    objects: [
      { id: 'obj_0001', assetId: 'building_hut_01', transform: { position: [0, 0, 0] } },
      { id: 'obj_0002', assetId: 'prop_barrel_01', transform: { position: [2, 0, 1] } },
      { id: 'obj_0003', assetId: 'tree_pine_01', transform: { position: [30, 0, 30] } },
    ],
    ...overrides,
  });
}

function failure(overrides: Partial<SmokeCheckResult> = {}): SmokeCheckResult {
  return {
    id: 'player-moves',
    status: 'failed',
    detail: 'The player did not move.',
    evidence: {},
    durationMs: 0,
    ...overrides,
  };
}

describe('applyPatch', () => {
  it('moves the spawn', () => {
    const result = applyPatch(scene(), { op: 'setPlayerSpawn', spawn: [5, 0, 5] });
    expect(result.ok && result.scene.player.spawn).toEqual([5, 0, 5]);
  });

  it('does not touch the scene it was given', () => {
    // Repair is speculative: a patch that fails re-verification is discarded and the previous
    // scene carries on. An in-place edit would poison the thing being fallen back to.
    const before = scene();
    const snapshot = JSON.stringify(before);
    applyPatch(before, { op: 'setPlayerSpawn', spawn: [9, 9, 9] });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('clears a collider and a trigger without removing the object', () => {
    const solid = applyPatch(scene(), {
      op: 'setObjectCollider',
      objectId: 'obj_0002',
      collider: 'none',
    });
    expect(solid.ok && solid.scene.objects[1]!.physics.collider).toBe('none');
    expect(solid.ok && solid.scene.objects).toHaveLength(3);

    const untriggered = applyPatch(scene(), { op: 'clearObjectTrigger', objectId: 'obj_0001' });
    expect(untriggered.ok && untriggered.scene.objects[0]!.trigger).toBeNull();
  });

  it('takes children with a removed parent', () => {
    const nested = scene({
      objects: [
        { id: 'obj_0001', assetId: 'building_hut_01', transform: { position: [0, 0, 0] } },
        {
          id: 'obj_0002',
          assetId: 'prop_barrel_01',
          parentId: 'obj_0001',
          transform: { position: [1, 0, 0] },
        },
        {
          id: 'obj_0003',
          assetId: 'prop_crate_01',
          parentId: 'obj_0002',
          transform: { position: [1, 0, 1] },
        },
      ],
    });

    const result = applyPatch(nested, { op: 'removeObject', objectId: 'obj_0001' });
    // Orphans left behind would snap to the world origin, which is a stranger scene than the
    // broken one it was meant to fix.
    expect(result.ok && result.scene.objects).toHaveLength(0);
  });

  it('refuses to patch an object that is not there', () => {
    const result = applyPatch(scene(), { op: 'removeObject', objectId: 'obj_9999' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('obj_9999');
  });
});

describe('what a proposal is allowed to be', () => {
  it('accepts a well-formed proposal', () => {
    const result = validateProposal({
      patch: { op: 'setPlayerSpawn', spawn: [1, 0, 2] },
      reason: 'Because the player was stuck.',
      fixes: 'player-moves',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses an operation that does not exist', () => {
    // The whole safety argument in one assertion: a model cannot widen the vocabulary by asking.
    const result = validateProposal({
      patch: { op: 'runScript', code: 'process.exit(1)' },
      reason: 'Trust me.',
      fixes: 'player-moves',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses code smuggled beside a legitimate operation', () => {
    // A valid patch with an extra field is still just a valid patch: Zod strips what it does not
    // know, and `applyPatch` reads named fields rather than spreading whatever arrived.
    const result = validateProposal({
      patch: {
        op: 'setPlayerSpawn',
        spawn: [0, 0, 0],
        onApply: "require('child_process').exec('id')",
      },
      reason: 'Looks innocent.',
      fixes: 'player-moves',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && JSON.stringify(result.proposal.patch)).not.toContain('child_process');
  });

  it('refuses a proposal with no reason to show the user', () => {
    // Sprint 26 shows the reason instead of the diff. A repair nobody can be told about is one
    // that gets applied silently, which is the thing this whole feature must not do.
    expect(
      validateProposal({ patch: { op: 'setPlayerSpawn', spawn: [0, 0, 0] }, fixes: 'player-moves' })
        .ok,
    ).toBe(false);
  });

  it('refuses a spawn that is not three numbers', () => {
    expect(
      validateProposal({
        patch: { op: 'setPlayerSpawn', spawn: ['over', 'there'] },
        reason: 'Somewhere nice.',
        fixes: 'player-moves',
      }).ok,
    ).toBe(false);
  });
});

describe('reading a model reply', () => {
  it('finds the JSON inside a fence and inside prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a":2} — hope that helps.')).toEqual({ a: 2 });
    expect(extractJson('null')).toBeNull();
    expect(extractJson('I have no idea what to do here.')).toBeNull();
  });

  it('passes a hostile reply through the schema rather than around it', async () => {
    const model = new LlmRepairModel(async () =>
      Promise.resolve(
        '```json\n{"patch":{"op":"exec","command":"rm -rf /"},"reason":"tidy up","fixes":"player-moves"}\n```',
      ),
    );

    const raw = await model.propose({
      failing: 'player-moves',
      detail: '',
      evidence: {},
      facts: {},
      candidates: [],
    });
    expect(validateProposal(raw).ok).toBe(false);
  });

  it('survives a model that returns nonsense', async () => {
    const model = new LlmRepairModel(async () => Promise.resolve('¯\\_(ツ)_/¯'));
    const raw = await model.propose({
      failing: 'player-moves',
      detail: '',
      evidence: {},
      facts: {},
      candidates: [],
    });
    expect(raw).toBeNull();
    expect(validateProposal(raw).ok).toBe(false);
  });
});

describe('which failures are a scene problem at all', () => {
  it('will not try to repair a broken build with a level edit', () => {
    // A repair loop that proposes spawn moves at a damaged engine bundle would change somebody's
    // work at random until the retry budget ran out, and then blame the level.
    expect(isRepairable('physics-initialises')).toBe(false);
    expect(isRepairable('page-loads')).toBe(false);
    expect(isRepairable('scene-loaded')).toBe(false);
    expect(isRepairable('memory-stable')).toBe(false);

    expect(isRepairable('player-moves')).toBe(true);
    expect(isRepairable('player-survives-idle')).toBe(true);
    expect(isRepairable('assets-resolve')).toBe(true);
  });

  it('picks the first failure it can do something about', () => {
    const report = {
      buildId: 'b',
      sceneName: 's',
      passed: false,
      startedAt: new Date(0).toISOString(),
      durationMs: 1,
      errors: [],
      checks: [
        failure({ id: 'page-loads', detail: 'threw' }),
        failure({ id: 'player-moves', detail: 'stuck' }),
      ],
    };

    expect(firstRepairableFailure(report)!.id).toBe('player-moves');
  });
});

describe('the narrow slice a failure is about', () => {
  it('sends what is near the spawn, not the whole level', () => {
    const context = extractContext(scene({ player: { spawn: [0, 0, 0] } }), failure());

    // The tree thirty metres away is not a suspect, and a scene with 520 objects should not offer
    // all of them.
    expect(context.candidates.map((object) => object.id)).toEqual(['obj_0001', 'obj_0002']);
    expect(context.facts['playerSpawn']).toEqual([0, 0, 0]);
  });

  it('says whether the spawn is even over the terrain', () => {
    const off = extractContext(scene({ player: { spawn: [4000, 5, 4000] } }), failure());
    expect(off.facts['spawnIsInsideTerrainBounds']).toBe(false);
    expect(off.candidates).toEqual([]);
  });

  it('narrows an idle-damage failure to the triggers alone', () => {
    const hazardous = scene({
      player: { spawn: [0, 0, 0] },
      objects: [
        { id: 'obj_0001', assetId: 'prop_barrel_01', transform: { position: [1, 0, 0] } },
        {
          id: 'obj_0002',
          assetId: 'logic_trigger_box',
          transform: { position: [0.5, 0, 0] },
          trigger: { shape: 'box', size: [4, 4, 4], once: false, actions: [] },
        },
      ],
    });

    const context = extractContext(hazardous, failure({ id: 'player-survives-idle' }));
    expect(context.candidates.map((object) => object.id)).toEqual(['obj_0002']);
  });
});

describe('the rule-based proposer', () => {
  it('brings a spawn that fell off the world back over the terrain', () => {
    const broken = scene({ player: { spawn: [4000, 5, 4000] } });
    const proposal = proposeByRule(extractContext(broken, failure()), broken)!;

    expect(proposal.patch.op).toBe('setPlayerSpawn');
    const applied = applyPatch(broken, proposal.patch);
    expect(applied.ok).toBe(true);

    const [x, , z] = (applied as { ok: true; scene: Scene }).scene.player.spawn;
    expect(Math.abs(x)).toBeLessThan(broken.terrain.size[0] / 2);
    expect(Math.abs(z)).toBeLessThan(broken.terrain.size[1] / 2);
    // Written for the person whose scene it is, not for a stack trace.
    expect(proposal.reason).toContain('terrain');
  });

  it('moves a spawn out of the building it was inside, and says which building', () => {
    const stuck = scene({
      player: { spawn: [0, 0, 0] },
      objects: [
        {
          id: 'obj_0001',
          assetId: 'building_hut_01',
          transform: { position: [0, 0, 0] },
          metadata: { label: 'Hut' },
        },
      ],
    });

    const proposal = proposeByRule(extractContext(stuck, failure()), stuck)!;
    expect(proposal.patch.op).toBe('setPlayerSpawn');
    expect(proposal.reason).toContain('Hut');

    // And the point it chose is genuinely clear of the thing that was in the way.
    const moved = applyPatch(stuck, proposal.patch);
    const spawn = (moved as { ok: true; scene: Scene }).scene.player.spawn;
    expect(Math.hypot(spawn[0], spawn[2])).toBeGreaterThan(1.4);
  });

  it('moves the player away from a hazard before touching the hazard', () => {
    const hazardous = scene({
      player: { spawn: [0, 0, 0] },
      objects: [
        {
          id: 'obj_0002',
          assetId: 'logic_trigger_box',
          transform: { position: [0, 0, 0] },
          trigger: { shape: 'box', size: [3, 3, 3], once: false, actions: [] },
        },
      ],
    });

    const context = extractContext(hazardous, failure({ id: 'player-survives-idle' }));
    const first = proposeByRule(context, hazardous)!;
    // Changing where somebody starts is smaller than changing what their level does.
    expect(first.patch.op).toBe('setPlayerSpawn');

    const second = proposeByRule(
      { ...context, evidence: { ...context.evidence, spawnMovedOnce: true } },
      hazardous,
    )!;
    expect(second.patch.op).toBe('clearObjectTrigger');
  });

  it('removes an object whose model is not in the build, and admits that is what it did', () => {
    const orphaned = scene({
      objects: [{ id: 'obj_0001', assetId: 'ghost_asset', transform: { position: [0, 0, 0] } }],
    });
    const context = extractContext(
      orphaned,
      failure({ id: 'assets-resolve', evidence: { failedAssets: ['ghost_asset'] } }),
    );

    const proposal = proposeByRule(context, orphaned)!;
    expect(proposal.patch).toEqual({ op: 'removeObject', objectId: 'obj_0001' });
    expect(proposal.reason).toContain('removed');
    expect(proposal.reason).toContain('re-add');
  });

  it('says nothing at all about a broken engine bundle', () => {
    const clean = scene();
    expect(
      proposeByRule(extractContext(clean, failure({ id: 'physics-initialises' })), clean),
    ).toBeNull();
  });
});
