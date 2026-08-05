import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { CURRENT_SCENE_VERSION, SceneSchema, type Scene } from '@helaengine/schema';
import { looksLikeHelaFile, packHelaFile, unpackHelaFile } from './container.js';
import {
  canonicalJson,
  HELA_FORMAT,
  HELA_FORMAT_VERSION,
  HelaFileError,
  MANIFEST_PATH,
  suggestedFilename,
} from './format.js';

/**
 * The `.hela` container.
 *
 * Two groups of claims. The first is that a project survives a round trip whole — scene, custom
 * models, UI media and all — which is what makes the file worth having. The second is that it
 * *refuses* clearly: a file the editor did not write is the one input a user hands it directly, and
 * every rejection has to be a sentence rather than a stack trace.
 */

function scene(overrides: Partial<Scene> = {}): Scene {
  return SceneSchema.parse({
    sceneId: 'scene_portable',
    version: CURRENT_SCENE_VERSION,
    name: 'Forest Clearing',
    objects: [
      { id: 'obj_0001', assetId: 'tree_pine_01', transform: { position: [1, 0, 2] } },
      { id: 'obj_0002', assetId: 'my_statue', transform: { position: [4, 0, 4] } },
    ],
    ...overrides,
  });
}

/** Bytes that start the way a binary glTF starts. */
function glb(payload = 'statue'): Uint8Array {
  const body = Buffer.from(payload, 'utf8');
  const bytes = new Uint8Array(12 + body.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('glTF', 'ascii'), 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  bytes.set(body, 12);
  return bytes;
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('packing and unpacking', () => {
  it('round-trips a scene', async () => {
    const original = scene();
    const bytes = await packHelaFile({ scene: original, engineVersion: '0.1.0' });
    const read = await unpackHelaFile(bytes);

    expect(read.scene).toEqual(original);
    expect(read.manifest.format).toBe(HELA_FORMAT);
    expect(read.manifest.name).toBe('Forest Clearing');
    expect(read.manifest.sceneVersion).toBe(CURRENT_SCENE_VERSION);
  });

  it('carries the custom models a scene places', async () => {
    const bytes = await packHelaFile({
      scene: scene(),
      engineVersion: '0.1.0',
      assets: [
        { assetId: 'my_statue', name: 'Stone Statue', category: 'props', bytes: glb('statue') },
      ],
    });

    const read = await unpackHelaFile(bytes);
    // The whole reason this is a container rather than a renamed scene.json: without the model, a
    // recipient opens a level with a hole in it.
    expect(read.assets).toHaveLength(1);
    expect(read.assets[0]!.assetId).toBe('my_statue');
    expect(read.assets[0]!.bytes).toEqual(glb('statue'));
    expect(read.manifest.assets[0]!.path).toBe('assets/my_statue.glb');
  });

  it('carries the UI media the shell references', async () => {
    const bytes = await packHelaFile({
      scene: scene(),
      engineVersion: '0.1.0',
      uiAssets: [
        {
          id: 'ui_title_screen',
          name: 'title.png',
          kind: 'image',
          mimeType: 'image/png',
          bytes: png,
        },
      ],
    });

    const read = await unpackHelaFile(bytes);
    expect(read.uiAssets[0]!.id).toBe('ui_title_screen');
    expect(read.uiAssets[0]!.bytes).toEqual(png);
    // The extension follows the mime type, so a file extracted by hand is openable by hand.
    expect(read.manifest.uiAssets[0]!.path).toBe('ui/ui_title_screen.png');
  });

  it('carries a thumbnail, and knows when there is none', async () => {
    const withPicture = await unpackHelaFile(
      await packHelaFile({ scene: scene(), engineVersion: '0.1.0', thumbnail: png }),
    );
    expect(withPicture.manifest.hasThumbnail).toBe(true);
    expect(withPicture.thumbnail).toEqual(png);

    const without = await unpackHelaFile(
      await packHelaFile({ scene: scene(), engineVersion: '0.1.0' }),
    );
    expect(without.manifest.hasThumbnail).toBe(false);
    expect(without.thumbnail).toBeNull();
  });

  it('migrates a scene written by an older build', async () => {
    // Packed by hand at an older document version, the way a file from six months ago would be.
    const zip = new JSZip();
    zip.file(
      MANIFEST_PATH,
      canonicalJson({
        format: HELA_FORMAT,
        formatVersion: 1,
        engineVersion: '0.0.1',
        sceneVersion: 1,
        name: 'Ancient',
        createdAt: new Date().toISOString(),
        assets: [],
        uiAssets: [],
        hasThumbnail: false,
      }),
    );
    zip.file(
      'scene.json',
      canonicalJson({
        sceneId: 'scene_old',
        version: 1,
        name: 'Ancient',
        objects: [{ id: 'obj_0001', assetId: 'tree_pine_01' }],
      }),
    );

    const read = await unpackHelaFile(await zip.generateAsync({ type: 'uint8array' }));
    // A file is untrusted input however it arrived, and one written by an older build must still
    // open — the same discipline the local store and the cloud API already apply.
    expect(read.scene.version).toBe(CURRENT_SCENE_VERSION);
    expect(read.scene.objects).toHaveLength(1);
  });
});

describe('being diffable', () => {
  it('writes the same bytes twice for an unchanged project', async () => {
    const subject = scene();
    const createdAt = '2026-01-01T00:00:00.000Z';

    const first = await packHelaFile({ scene: subject, engineVersion: '0.1.0', createdAt });
    const second = await packHelaFile({ scene: subject, engineVersion: '0.1.0', createdAt });

    // The claim the whole version-control story rests on. Zip entry dates default to *now*, so
    // without pinning them a save with no changes still produces a different file — which is
    // exactly the noise that makes people stop committing a project.
    expect(first).toEqual(second);
  });

  it('does not depend on the order keys were built in', async () => {
    /** The same value, with every object's keys inserted in the opposite order. */
    function reverseKeys(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value === null || typeof value !== 'object') return value;

      const source = value as Record<string, unknown>;
      const flipped: Record<string, unknown> = {};
      for (const key of Object.keys(source).reverse()) flipped[key] = reverseKeys(source[key]);
      return flipped;
    }

    const ordered = scene();
    // The same document, assembled with its keys in a different order — which is what happens when
    // one copy came from storage and the other was just edited. `JSON.stringify` emits insertion
    // order, so without sorting these two would serialise differently and show as a diff that is
    // not a change.
    const shuffled = reverseKeys(ordered);

    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(ordered));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(ordered));
  });

  it('stores entries uncompressed, so a diff is a delta rather than a rewrite', async () => {
    const bytes = await packHelaFile({
      scene: scene(),
      engineVersion: '0.1.0',
      assets: [{ assetId: 'my_statue', name: 'S', category: 'props', bytes: glb() }],
    });

    const zip = await JSZip.loadAsync(bytes);
    const files = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
    expect(files.length).toBeGreaterThan(1);

    for (const [name, entry] of files) {
      // JSZip records how each entry was stored. STORE's magic is two NUL bytes; DEFLATE's is
      // \u0008\u0000. Directory entries carry no data at all, which is why they are filtered out
      // above rather than asserted on.
      const stored = entry as unknown as { _data?: { compression?: { magic?: string } } };
      expect(stored._data?.compression?.magic, `${name} should be stored`).toBe('\u0000\u0000');
    }
  });

  it('names a file after the scene, without letting a name escape the folder', async () => {
    expect(suggestedFilename('Forest Clearing')).toBe('Forest-Clearing.hela');
    // A scene name is free text and ends up as a filename. A path separator in it is how a save
    // dialog is talked into writing somewhere it was not pointed at.
    expect(suggestedFilename('../../etc/passwd')).not.toContain('/');
    expect(suggestedFilename('   ')).toBe('Untitled scene.hela');
  });
});

describe('refusing a file it did not write', () => {
  it('refuses something that is not a zip at all', async () => {
    const notAZip = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(looksLikeHelaFile(notAZip)).toBe(false);
    await expect(unpackHelaFile(notAZip)).rejects.toThrow(HelaFileError);
  });

  it('refuses a zip that is not a project, and says what to do instead', async () => {
    const zip = new JSZip();
    zip.file('index.html', '<!doctype html>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    // Mistaking an exported game for a project file is the likeliest confusion this product has,
    // so it gets its own sentence rather than a generic refusal.
    expect(looksLikeHelaFile(bytes)).toBe(true);
    await expect(unpackHelaFile(bytes)).rejects.toThrow(/no hela\.json/);
  });

  it('refuses a container from a newer build rather than dropping what it cannot read', async () => {
    const zip = new JSZip();
    zip.file(
      MANIFEST_PATH,
      canonicalJson({
        format: HELA_FORMAT,
        formatVersion: HELA_FORMAT_VERSION + 1,
        engineVersion: '9.9.9',
        sceneVersion: CURRENT_SCENE_VERSION,
        name: 'From the future',
        createdAt: new Date().toISOString(),
        assets: [],
        uiAssets: [],
        hasThumbnail: false,
      }),
    );
    zip.file('scene.json', canonicalJson(scene()));

    // Opening it would silently drop entries this build does not know to carry — and then a save
    // would write that loss to disk over the user's file.
    await expect(unpackHelaFile(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      /newer version/,
    );
  });

  it('refuses a damaged manifest', async () => {
    const zip = new JSZip();
    zip.file(MANIFEST_PATH, '{ this is not json');
    await expect(unpackHelaFile(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      /manifest is damaged/,
    );
  });

  it('refuses a container whose scene does not validate', async () => {
    const zip = new JSZip();
    zip.file(
      MANIFEST_PATH,
      canonicalJson({
        format: HELA_FORMAT,
        formatVersion: HELA_FORMAT_VERSION,
        engineVersion: '0.1.0',
        sceneVersion: CURRENT_SCENE_VERSION,
        name: 'Broken',
        createdAt: new Date().toISOString(),
        assets: [],
        uiAssets: [],
        hasThumbnail: false,
      }),
    );
    zip.file('scene.json', canonicalJson({ sceneId: 'x', version: 1, objects: 'not an array' }));

    await expect(unpackHelaFile(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      /could not be read/,
    );
  });

  it('opens what it can when an embedded asset is missing', async () => {
    const bytes = await packHelaFile({
      scene: scene(),
      engineVersion: '0.1.0',
      assets: [{ assetId: 'my_statue', name: 'S', category: 'props', bytes: glb() }],
    });

    const zip = await JSZip.loadAsync(bytes);
    zip.remove('assets/my_statue.glb');
    const damaged = await zip.generateAsync({ type: 'uint8array' });

    // The rest of the level is still worth opening. The missing model draws as a placeholder,
    // exactly as it would if the asset had been deleted from an account.
    const read = await unpackHelaFile(damaged);
    expect(read.assets).toHaveLength(0);
    expect(read.scene.objects).toHaveLength(2);
  });

  it('cannot be talked into writing outside its own folders', async () => {
    const bytes = await packHelaFile({
      scene: scene(),
      engineVersion: '0.1.0',
      assets: [{ assetId: '../../escape', name: 'Sneaky', category: 'props', bytes: glb() }],
    });

    const read = await unpackHelaFile(bytes);
    // Ids are constrained where they are minted, but a container is also built from ids that
    // arrived inside somebody else's file — and `../` in a path is how an archive writes outside
    // the directory it was extracted to.
    expect(read.manifest.assets[0]!.path).toBe('assets/______escape.glb');
    expect(read.manifest.assets[0]!.path).not.toContain('..');
  });
});
