import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import type * as InspectModel from './inspectModel';
import {
  deleteLocalAsset,
  importLocalAsset,
  listLocalAssets,
  LocalAssetError,
  localAssetEntries,
  MAX_LOCAL_ASSET_BYTES,
  refreshLocalAssets,
  releaseLocalAssetUrls,
  toManifestEntry,
} from './localAssets';

/**
 * Storing, replacing and describing an imported model.
 *
 * **`inspectModel` is stubbed here, and that is a deliberate split rather than a shortcut.** It
 * decodes a glTF file with `GLTFLoader`, which loads the model's textures through an `<img>` — and
 * jsdom has no image decoder, so a real model with a texture never finishes parsing. Faking an
 * image decoder to make the test run would be testing a fiction.
 *
 * Measuring a model is a browser's job, so it is verified in a browser: `inspectModel` is run
 * against the real Fox in `e2e/import-model.spec.ts`, where the numbers are checked against the
 * ones `pnpm ingest-assets` records for the same file. What is left here is everything that is
 * genuinely storage logic — ids, replacement, attribution, survival across a reload — and all of
 * it runs fast and in CI.
 */

const REPORT = {
  polyCount: 576,
  bounds: [25.1854, 79.0289, 154.7199] as [number, number, number],
  baseOffset: 0,
  animations: ['Survey', 'Walk', 'Run'],
  skinned: true,
  suggestedScale: 0.01 as number | null,
};

vi.mock('./inspectModel', async () => {
  const actual = await vi.importActual<typeof InspectModel>('./inspectModel');
  return {
    ...actual,
    inspectModel: vi.fn(async (bytes: ArrayBuffer, filename: string) => {
      // Still refuses what a real inspection would refuse, so the "not really a glTF file" test is
      // exercising the import's own error path rather than the stub's convenience.
      if (bytes.byteLength < 512) {
        throw new actual.ModelInspectionError(
          `${filename} could not be read as a glTF model (too short). ` +
            'It must be a .glb or .gltf file.',
        );
      }
      return REPORT;
    }),
  };
});

/** Bytes long enough to pass the stub's sanity check. Content is never decoded here. */
function modelFile(name = 'enemy_fox.glb'): File {
  return new File([new Uint8Array(2048)], name, { type: 'model/gltf-binary' });
}

async function foxFile(name = 'enemy_fox.glb'): Promise<File> {
  return modelFile(name);
}

beforeEach(async () => {
  await db.localAssets.clear();
  await refreshLocalAssets();
});

afterEach(() => {
  releaseLocalAssetUrls();
});

describe('importLocalAsset', () => {
  it('stores what the inspector measured', async () => {
    const result = await importLocalAsset(await foxFile());

    // What the inspector reported is what gets stored — nothing is recomputed, guessed or
    // rounded on the way into the database.
    expect(result.asset.polyCount).toBe(576);
    expect(result.asset.skinned).toBe(true);
    expect(result.asset.animations).toEqual(['Survey', 'Walk', 'Run']);
    expect(result.asset.bounds).toEqual([25.1854, 79.0289, 154.7199]);
  });

  it('spots a model authored in centimetres before it is placed', async () => {
    // The Fox is 155 units long. So is every Mixamo character, and the first thing somebody places
    // is a skyscraper. Reported rather than silently corrected — a model really might be that big.
    const result = await importLocalAsset(await foxFile());
    expect(result.suggestedScale).toBe(0.01);
    expect(result.warnings.join(' ')).toContain('centimetres');
  });

  it('refuses a file that is not a model, naming the file', async () => {
    const notAModel = new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' });
    await expect(importLocalAsset(notAModel)).rejects.toThrow(LocalAssetError);
    await expect(importLocalAsset(notAModel)).rejects.toThrow('notes.txt');
    expect(await listLocalAssets()).toHaveLength(0);
  });

  it('refuses a .glb that is not really a glTF file', async () => {
    // The extension check is not the real check. A renamed file passes it and then fails to parse,
    // and finding that out here — with the filename in the message — beats a grey box in a level.
    const renamed = new File([new Uint8Array(8)], 'broken.glb', { type: 'model/gltf-binary' });
    await expect(importLocalAsset(renamed)).rejects.toThrow(/could not be read as a glTF model/);
    expect(await listLocalAssets()).toHaveLength(0);
  });

  it('refuses a model too large to survive an export', async () => {
    const huge = new File([new Uint8Array(MAX_LOCAL_ASSET_BYTES + 1)], 'huge.glb');
    await expect(importLocalAsset(huge)).rejects.toThrow(/limit is 64 MB/);
  });

  it('replaces rather than duplicates when the same file is imported twice', async () => {
    await importLocalAsset(await foxFile());
    await importLocalAsset(await foxFile());
    // The id comes from the filename, so re-importing after fixing a model in Blender updates the
    // asset every scene already references instead of adding a second one nothing points at.
    expect(await listLocalAssets()).toHaveLength(1);
  });

  it('keeps two different files apart', async () => {
    await importLocalAsset(await foxFile('hero.glb'));
    await importLocalAsset(await foxFile('villain.glb'));
    expect((await listLocalAssets()).map((asset) => asset.id).sort()).toEqual([
      'local_hero',
      'local_villain',
    ]);
  });

  it('records attribution when it is given, and nothing when it is not', async () => {
    await importLocalAsset(await foxFile('credited.glb'), {
      author: 'Somebody',
      license: 'CC-BY-4.0',
    });
    const [credited] = await listLocalAssets();
    expect(credited?.author).toBe('Somebody');
    expect(credited?.license).toBe('CC-BY-4.0');

    await importLocalAsset(await foxFile('anonymous.glb'));
    const uncredited = (await listLocalAssets()).find((asset) => asset.id === 'local_anonymous');
    // Absent rather than an empty string: the export's CREDITS file distinguishes "licence not
    // recorded" from a licence of "".
    expect(uncredited?.author).toBeUndefined();
  });

  it('survives being reloaded, which is the whole reason it is stored', async () => {
    await importLocalAsset(await foxFile());
    // Simulates a page reload: the in-memory list is emptied and rebuilt from the database. Models
    // that arrive in a `.hela` file cannot do this — they are blob URLs that die with the tab —
    // and that limitation is what this table exists to remove.
    releaseLocalAssetUrls();
    const entries = await refreshLocalAssets();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.animations).toEqual(['Survey', 'Walk', 'Run']);
  });

  it('is forgotten when deleted', async () => {
    await importLocalAsset(await foxFile());
    await deleteLocalAsset('local_enemy_fox');
    expect(await listLocalAssets()).toHaveLength(0);
    expect(localAssetEntries()).toHaveLength(0);
  });
});

describe('toManifestEntry', () => {
  it('produces an entry the engine and the exporter both accept', async () => {
    const { asset } = await importLocalAsset(await foxFile(), { category: 'enemies' });
    const entry = toManifestEntry(asset);

    expect(entry.category).toBe('enemies');
    expect(entry.origin).toBe('customer');
    // Absolute, which the engine's `joinUrl` passes through untouched and which the exporter
    // rewrites to a real path inside the zip. Both were needed before this could work at all.
    expect(entry.glbPath).toMatch(/^blob:/);
    // Carried through so the inspector's animation dropdowns are populated before the model loads.
    expect(entry.animations).toEqual(['Survey', 'Walk', 'Run']);
    expect(entry.skinned).toBe(true);
  });

  it('falls back to props for a category it does not recognise', async () => {
    const { asset } = await importLocalAsset(await foxFile());
    expect(toManifestEntry({ ...asset, category: 'spaceships' }).category).toBe('props');
  });
});
