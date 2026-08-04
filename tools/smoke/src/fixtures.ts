import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseScene, type Scene } from '@helaengine/schema';
import { templateById } from '@helaengine/templates';

/**
 * The deliberately broken builds.
 *
 * A validation gate nobody has watched fail is a validation gate nobody should trust, so each of
 * these breaks a *real* build in a way that really happens — and each is expected to fail on its
 * own check, not merely to fail. "Something went wrong" is what the harness exists to replace.
 *
 * Two of them break the scene document and one breaks the folder, which is the honest split: an
 * export can be wrong because the level is wrong or because the build is wrong, and a gate that
 * only sees one of those is half a gate.
 */

export interface Breakage {
  id: string;
  /** What a person would say went wrong. */
  what: string;
  /** The check that must be the one to catch it. */
  expect: string;
  /** Which template to ruin. */
  template: string;
  /** Applied before the export is built. */
  breakScene?(scene: Scene): Scene;
  /** Applied to the staged folder afterwards. */
  breakBuild?(root: string): Promise<void>;
}

export const BREAKAGES: Breakage[] = [
  {
    id: 'spawn-in-the-void',
    what: 'The spawn point is off the edge of the terrain, so the player falls forever.',
    expect: 'player-moves',
    template: 'forest-clearing',
    // Far outside the terrain's extent. The export already clamps a spawn *below* the ground up to
    // it, which is why the interesting break is horizontal: there is no ground under this point to
    // clamp to, and the character controller has nothing to stand on.
    breakScene: (scene) =>
      parseScene({ ...scene, player: { ...scene.player, spawn: [4000, 5, 4000] } }),
  },
  {
    id: 'missing-asset-file',
    what: 'The manifest names a model that is not in the folder.',
    expect: 'assets-resolve',
    template: 'village-outpost',
    // Deleting the file rather than mangling the id, because that is the failure that survives
    // review: the document is valid, the export looks complete, and a single file did not make it.
    breakBuild: async (root) => {
      const manifest = JSON.parse(await readFile(join(root, 'assets/manifest.json'), 'utf8')) as {
        assets: Array<{ glbPath?: string }>;
      };
      const victim = manifest.assets.find((asset) => asset.glbPath)?.glbPath;
      if (!victim) throw new Error('the village outpost shipped no models to delete');
      await rm(join(root, 'assets', victim));
    },
  },
  {
    id: 'damaged-physics-wasm',
    what: "The engine bundle's inlined WebAssembly is corrupt, so physics never starts.",
    expect: 'physics-initialises',
    template: 'skirmish',
    // `rapier3d-compat` carries its WASM as base64 *inside* the JavaScript, so there is no `.wasm`
    // file to break — which is exactly why this is worth testing. The corruption keeps the base64
    // valid (so the module still parses and the page still loads) and the WebAssembly invalid.
    breakBuild: async (root) => {
      const path = join(root, 'engine/runtime.js');
      const source = await readFile(path, 'utf8');
      const match = /[A-Za-z0-9+/]{20000,}/.exec(source);
      if (!match) throw new Error('found no inlined WebAssembly payload to damage');

      const at = match.index + 8_000;
      const damaged = `${source.slice(0, at)}${'A'.repeat(512)}${source.slice(at + 512)}`;
      await writeFile(path, damaged, 'utf8');
    },
  },
];

/** The five starter worlds, which must all pass. */
export const GOOD_TEMPLATES = [
  'blank',
  'forest-clearing',
  'village-outpost',
  'skirmish',
  'stress-test',
] as const;

export function sceneFor(templateId: string): Scene {
  const template = templateById(templateId);
  if (!template) throw new Error(`no such template: ${templateId}`);
  return template.build();
}
