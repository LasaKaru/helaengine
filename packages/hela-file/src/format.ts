import { z } from 'zod';

/**
 * The `.hela` project file.
 *
 * A zip container, not a renamed `scene.json`. The distinction is the whole design: a scene
 * document alone is portable right up until somebody uses an asset they uploaded or a home-screen
 * image they chose, at which point the recipient opens a level full of missing things. So the file
 * carries the scene *plus everything it references that the product does not ship with*.
 *
 * ```
 * MyLevel.hela
 * ├── hela.json        this manifest
 * ├── scene.json       the SceneSchema document
 * ├── thumbnail.png    optional, so a projects list has a picture before anything is opened
 * ├── assets/          custom .glb files the scene actually places
 * └── ui/              images and videos the shell actually references
 * ```
 *
 * Curated assets are deliberately **not** embedded. They ship with the engine, every install has
 * them, and copying a tree into every file that places one would turn a 40 KB level into a
 * multi-megabyte one for no benefit.
 *
 * ## Why it is built to be diffable
 *
 * A project file people can email is also a project file people will commit. Three decisions follow
 * from that, and none of them cost anything:
 *
 * - **Canonical JSON.** Keys sorted, two-space indent, trailing newline. Two saves of an unchanged
 *   project produce byte-identical text rather than a diff that depends on property insertion order.
 * - **Stored, not deflated.** Compressing already-compressed GLBs and PNGs buys almost nothing, and
 *   an uncompressed entry is one git can delta. A deflated one changes wholesale when a byte moves.
 * - **No modification timestamp.** The filesystem already knows when a file was written. Recording
 *   it *inside* would mean every save differs from the last even when nothing changed — which is
 *   precisely the noise that makes people stop committing a file.
 */

export const HELA_FORMAT = 'helaengine-project' as const;

/**
 * The container format's own version, independent of `SceneSchema`'s.
 *
 * Two versions rather than one because they change for different reasons: the scene document
 * version moves when the *document* gains a field, this moves when the *container* changes shape.
 * Conflating them would mean a new zip entry forcing a scene migration that has nothing to do.
 */
export const HELA_FORMAT_VERSION = 1;

export const EmbeddedAssetSchema = z.object({
  /** The id the scene places it by. Matches an `AssetManifestEntry.id`. */
  assetId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(40),
  /** Path inside the container. Always under `assets/`. */
  path: z.string().min(1).max(300),
});
export type EmbeddedAsset = z.infer<typeof EmbeddedAssetSchema>;

export const EmbeddedUiAssetSchema = z.object({
  /** The id `uiConfig` references it by. */
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  kind: z.enum(['image', 'video']),
  mimeType: z.string().min(1).max(120),
  /** Path inside the container. Always under `ui/`. */
  path: z.string().min(1).max(300),
});
export type EmbeddedUiAsset = z.infer<typeof EmbeddedUiAssetSchema>;

export const HelaManifestSchema = z.object({
  /**
   * A constant, checked on the way in.
   *
   * Zip files are common enough that "it unzipped" is not evidence of anything. This is what lets a
   * `.docx` renamed to `.hela` be refused with a sentence rather than a stack trace three layers
   * down in the scene parser.
   */
  format: z.literal(HELA_FORMAT),
  formatVersion: z.number().int().positive(),
  /** Which build wrote it. Diagnostic only — never branched on. */
  engineVersion: z.string().max(40),
  /** The scene document's own version at write time, so a reader knows before it parses. */
  sceneVersion: z.number().int().positive(),
  name: z.string().min(1).max(200),
  createdAt: z.string(),
  assets: z.array(EmbeddedAssetSchema).default([]),
  uiAssets: z.array(EmbeddedUiAssetSchema).default([]),
  hasThumbnail: z.boolean().default(false),
});
export type HelaManifest = z.infer<typeof HelaManifestSchema>;

export const MANIFEST_PATH = 'hela.json';
export const SCENE_PATH = 'scene.json';
/**
 * Every level, when there is more than one.
 *
 * Written *alongside* `scene.json` rather than instead of it, so a build without multi-level
 * support opens the file and finds a playable game — its start level — rather than an error. A
 * single-level project omits this entirely, which keeps the common file byte-identical to what it
 * was and makes "does this have levels" answerable from the entry list.
 */
export const PROJECT_PATH = 'project.json';
export const THUMBNAIL_PATH = 'thumbnail.png';
export const ASSET_DIR = 'assets/';
export const UI_DIR = 'ui/';

/** The extension, in one place, so the file picker and the save dialog cannot disagree. */
export const HELA_EXTENSION = '.hela';
export const HELA_MIME = 'application/x-helaengine-project';

/**
 * Refused with a sentence somebody can act on.
 *
 * Opening a project file is the one moment a user hands the editor something it did not write, so
 * every rejection here is a message shown in a dialog rather than a console error.
 */
export class HelaFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HelaFileError';
  }
}

/**
 * JSON with sorted keys and a stable shape.
 *
 * `JSON.stringify` emits keys in insertion order, so the same document built two different ways —
 * loaded from storage versus just edited — serialises differently and shows as a diff that is not a
 * change. Sorting makes the text a function of the value alone.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  // Arrays keep their order: position carries meaning in `objects`, `behaviors` and every menu.
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
  return sorted;
}

/**
 * A filename for a project.
 *
 * Kept close to what the user named the scene, because a downloads folder full of
 * `project-8f3a91.hela` is a downloads folder nobody can navigate. Characters a filesystem would
 * refuse — or a path separator somebody could smuggle in through a scene name — are replaced rather
 * than stripped, so two differently-named projects do not collapse onto one filename.
 */
export function suggestedFilename(sceneName: string): string {
  const base = sceneName
    .trim()
    .replace(/[/\\?%*:|"<>.\u0020-]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 80);

  return `${base || 'Untitled scene'}${HELA_EXTENSION}`;
}
