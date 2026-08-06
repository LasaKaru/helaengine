import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { metadataFile, rawAssetsDir } from './paths.js';

/**
 * Brings a third-party asset pack into the library.
 *
 *   pnpm import-pack -- --from /tmp/nature --pack nature-kit \
 *     --author Kenney --license CC0-1.0 --url https://kenney.nl/assets/nature-kit
 *
 * Copies the pack's GLBs into `raw-assets/` under ids this project can live with, and writes an
 * entry per asset into the pipeline's metadata file. It does **not** ingest — `pnpm ingest-assets`
 * still does that, so importing and processing stay separable and the second one stays idempotent.
 *
 * **Attribution is required, not optional.** The script refuses to run without a licence, an author
 * and a source URL, and marks everything it writes `origin: 'third-party'`. That is the whole point
 * of the Sprint 37 work: a pack whose terms are not recorded is a pack whose terms get lost, and
 * the moment they are lost every game built with it ships somebody else's art uncredited.
 */

/**
 * Which of our categories a Kenney-style filename prefix belongs to.
 *
 * Prefix-driven because that is how these packs are named and because the id keeps the prefix, so
 * the mapping stays legible in the manifest afterwards. Anything unlisted becomes a prop, which is
 * the honest default: "some object you place" is true of everything and wrong about nothing.
 */
const CATEGORY_BY_PREFIX: Record<string, string> = {
  // Foliage and growing things.
  tree: 'trees',
  trunk: 'trees',
  stump: 'trees',
  log: 'trees',
  plant: 'trees',
  flower: 'trees',
  grass: 'trees',
  mushroom: 'trees',
  crop: 'trees',
  crops: 'trees',
  cactus: 'trees',
  bamboo: 'trees',
  palm: 'trees',
  // Stone.
  rock: 'rocks',
  rocks: 'rocks',
  stone: 'rocks',
  cliff: 'rocks',
  // Ground you walk on rather than objects you place on it.
  ground: 'terrain',
  path: 'terrain',
  hill: 'terrain',
  // Structures.
  wall: 'buildings',
  tower: 'buildings',
  gate: 'buildings',
  roof: 'buildings',
  stairs: 'buildings',
  door: 'buildings',
  window: 'buildings',
  floor: 'buildings',
  column: 'buildings',
  building: 'buildings',
  house: 'buildings',
  hut: 'buildings',
  tent: 'buildings',
  bridge: 'buildings',
  structure: 'buildings',
};

/** Collider shapes that suit a category better than the default box. */
const COLLIDER_BY_CATEGORY: Record<string, string> = {
  trees: 'capsule',
  rocks: 'box',
  terrain: 'box',
  buildings: 'box',
  props: 'box',
};

/** A muted tint per category, used as the placeholder before a model loads. */
const COLOUR_BY_CATEGORY: Record<string, string> = {
  trees: '#2f6f3f',
  rocks: '#7d8590',
  terrain: '#6b7a4a',
  buildings: '#8a7a63',
  props: '#9a8f7a',
};

/**
 * A filename turned into an id this project accepts.
 *
 * `tree_pineDefaultA.glb` becomes `tree_pine_default_a`. Lower-cased snake_case rather than the
 * original camelCase because the *upload* route already holds customer asset ids to
 * `^[a-z0-9_]{3,60}$`, and having the curated library obey a looser rule than the one enforced on
 * users is the kind of inconsistency that turns into a bug report about a file that "works for you".
 */
export function toAssetId(filename: string): string {
  return path
    .basename(filename, path.extname(filename))
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

/** `tree_pine_default_a` -> `Tree Pine Default A`. */
export function toDisplayName(assetId: string): string {
  return assetId
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function categoryFor(assetId: string): string {
  const prefix = assetId.split('_')[0] ?? '';
  return CATEGORY_BY_PREFIX[prefix] ?? 'props';
}

export interface ImportOptions {
  from: string;
  pack: string;
  author: string;
  license: string;
  url: string;
  /** Where to copy the GLBs. Defaults to the repository's `raw-assets`. */
  into?: string;
  /** Where the metadata file lives. Defaults to the pipeline's own. */
  metadata?: string;
  dryRun?: boolean;
}

export interface ImportResult {
  imported: string[];
  /** Ids already present, which are left exactly as they were. */
  skipped: string[];
}

/**
 * Copies a model, embedding anything it referenced from outside itself.
 *
 * Not a plain `copyFile`, and the reason is a real failure: Kenney's Survival and Castle kits ship
 * GLBs that reference a sibling `Textures/colormap.png` rather than embedding it, so a straight
 * copy produced 150 models that could not be opened — the ingest run died on the first one with
 * `ENOENT … raw-assets/Textures/colormap.png`.
 *
 * Copying the texture alongside would not have worked either: the two kits ship *different* files
 * under the same name, so one shared path would have silently repainted one kit with the other's
 * atlas. Reading and rewriting resolves each reference against its own source directory and emits a
 * self-contained binary, which is what `raw-assets` is supposed to hold.
 */
async function selfContain(source: string, destination: string): Promise<void> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(source);
  await fs.writeFile(destination, await io.writeBinary(document));
}

/** Every `.glb` under a directory, recursively — packs nest them under a format folder. */
async function findModels(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.toLowerCase().endsWith('.glb')) found.push(full);
    }
  }

  await walk(root);
  return found.sort();
}

export async function importPack(options: ImportOptions): Promise<ImportResult> {
  for (const required of ['author', 'license', 'url'] as const) {
    if (!options[required]) {
      throw new Error(
        `--${required} is required. A pack imported without attribution is a pack whose terms are lost.`,
      );
    }
  }

  const into = options.into ?? rawAssetsDir;
  const metadataPath = options.metadata ?? metadataFile;

  const existing = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;

  const models = await findModels(options.from);
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const source of models) {
    const assetId = toAssetId(source);
    if (assetId.length < 3) continue;

    // Never overwritten. The first ten assets are hand-tuned — bounds, collider, colour — and a
    // re-import that clobbered them would silently undo that work with a generated guess.
    if (existing[assetId]) {
      skipped.push(assetId);
      continue;
    }

    const category = categoryFor(assetId);
    existing[assetId] = {
      name: toDisplayName(assetId),
      category,
      tags: [options.pack, category],
      colliderType: COLLIDER_BY_CATEGORY[category] ?? 'box',
      placeholderColor: COLOUR_BY_CATEGORY[category] ?? '#9a8f7a',
      license: options.license,
      author: options.author,
      sourceUrl: options.url,
      // The reason the vocabulary exists. These are somebody else's models, licensed to us, and the
      // manifest says so rather than leaving it to be inferred from where the file happens to sit.
      origin: 'third-party',
    };

    if (!options.dryRun) await selfContain(source, path.join(into, `${assetId}.glb`));
    imported.push(assetId);
  }

  if (!options.dryRun) {
    // Sorted, so the diff of a future import is the new assets rather than a reshuffle.
    const sorted = Object.fromEntries(
      Object.entries(existing).sort(([a], [b]) => a.localeCompare(b)),
    );
    await fs.writeFile(metadataPath, `${JSON.stringify(sorted, null, 2)}\n`);
  }

  return { imported, skipped };
}
