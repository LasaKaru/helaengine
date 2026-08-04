import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseScene, type Scene, type SmokeCheckId } from '@helaengine/schema';

/**
 * Broken scenes the repair loop is expected to fix.
 *
 * Deliberately *scene* problems, which is the honest boundary of what a document patch can fix. The
 * plan's third example was "broken WASM path", and that is a broken build rather than a broken
 * level — the loop refuses it, and there is a test asserting the refusal, because a repair loop
 * that rearranges someone's level to fix a corrupted bundle would be worse than one that gives up.
 */
export interface RepairableBreakage {
  id: string;
  what: string;
  template: string;
  /** The check that must fail before the repair. */
  detects: SmokeCheckId;
  breakScene?(scene: Scene): Scene;
  breakBuild?(root: string): Promise<void>;
  /** Asserted against the applied patch, so "repaired" means repaired the right way. */
  expectOp: string;
}

/** The model this fixture deletes. Named rather than "the first one", so the fault stays put. */
const DOOMED_ASSET = 'building_hut_01';

export const REPAIRABLE: RepairableBreakage[] = [
  {
    id: 'spawn-off-the-map',
    what: 'The start point is off the edge of the terrain, so the player falls forever.',
    template: 'forest-clearing',
    detects: 'player-moves',
    expectOp: 'setPlayerSpawn',
    breakScene: (scene) =>
      parseScene({ ...scene, player: { ...scene.player, spawn: [4000, 5, 4000] } }),
  },
  {
    id: 'spawn-inside-the-hut',
    what: 'The start point is inside a building, so the player spawns wedged and cannot walk.',
    template: 'village-outpost',
    detects: 'player-moves',
    expectOp: 'setPlayerSpawn',
    // The exact bug Sprint 24's harness found in this template, put back deliberately. A fix that
    // cannot be re-broken is a fix nobody can prove still works.
    breakScene: (scene) => parseScene({ ...scene, player: { ...scene.player, spawn: [0, 0, 0] } }),
  },
  {
    id: 'enemy-on-the-doormat',
    what: 'The start point is on top of a goblin, so the player is being hit before they can move.',
    template: 'skirmish',
    detects: 'player-survives-idle',
    expectOp: 'setPlayerSpawn',
    breakScene: (scene) => {
      const goblin = scene.objects.find((object) => object.assetId.startsWith('enemy_'));
      if (!goblin) throw new Error('the skirmish has no enemy to stand on');
      const [x, , z] = goblin.transform.position;
      return parseScene({ ...scene, player: { ...scene.player, spawn: [x, 0, z] } });
    },
  },
  {
    id: 'model-missing-from-the-build',
    what: 'The manifest names a model that is not in the folder, so the world cannot finish loading.',
    template: 'village-outpost',
    detects: 'assets-resolve',
    expectOp: 'removeObject',
    breakBuild: async (root) => {
      const manifest = JSON.parse(await readFile(join(root, 'assets/manifest.json'), 'utf8')) as {
        assets: Array<{ id: string; glbPath?: string }>;
      };
      const victim = manifest.assets.find((asset) => asset.id === DOOMED_ASSET);
      // Absent once the repair removes the last object using it, which is the fix working rather
      // than a fixture failing — so this is a no-op then, not an error.
      if (victim?.glbPath) await rm(join(root, 'assets', victim.glbPath), { force: true });
    },
  },
];
