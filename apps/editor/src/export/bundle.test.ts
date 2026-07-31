import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene, type AssetManifest, type Scene } from '@helaengine/schema';
import {
  buildExport,
  collectUsedAssets,
  DEFAULT_EXPORT_OPTIONS,
  slugify,
  type ExportPlan,
} from './bundle';

const manifest: AssetManifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'building_hut_01', name: 'Hut', category: 'buildings', glbPath: 'models/hut.glb' },
    { id: 'tree_pine_01', name: 'Pine', category: 'trees', glbPath: 'models/pine.glb' },
    { id: 'rock_boulder_01', name: 'Boulder', category: 'rocks', glbPath: 'models/rock.glb' },
    { id: 'audio_music_menu', name: 'Menu music', category: 'audio', audioPath: 'audio/menu.wav' },
    { id: 'audio_sfx_pickup', name: 'Pickup', category: 'audio', audioPath: 'audio/pickup.wav' },
  ],
});

function scene(overrides: Record<string, unknown> = {}): Scene {
  return parseScene({
    sceneId: 'scene_export',
    version: 1,
    name: 'Test Scene',
    objects: [
      { id: 'obj_0001', assetId: 'building_hut_01', transform: { position: [0, 0, 0] } },
      { id: 'obj_0002', assetId: 'tree_pine_01', transform: { position: [4, 0, 0] } },
    ],
    ...overrides,
  });
}

async function plan(
  sceneDocument = scene(),
  options = DEFAULT_EXPORT_OPTIONS,
): Promise<ExportPlan> {
  return buildExport({
    scene: sceneDocument,
    manifest,
    options,
    runtimeSource: '/* engine */ export const ENGINE = 1;',
    readAsset: async (path) => new TextEncoder().encode(`bytes:${path}`),
  });
}

function pathsOf(result: ExportPlan): string[] {
  return result.files.map((file) => file.path).sort();
}

function textOf(result: ExportPlan, path: string): string {
  return result.files.find((file) => file.path === path)?.text ?? '';
}

describe('slugify', () => {
  it('makes a filename out of a project name', () => {
    expect(slugify('My Great Game')).toBe('my-great-game');
    expect(slugify('  Spaces  ')).toBe('spaces');
  });

  it('refuses to produce something that escapes the folder', () => {
    // A project called `../../etc` would otherwise write outside wherever somebody extracted it.
    expect(slugify('../../etc')).toBe('etc');
    expect(slugify('a/b/c')).toBe('a-b-c');
    expect(slugify('...')).toBe('my-game');
    expect(slugify('')).toBe('my-game');
  });
});

describe('collectUsedAssets', () => {
  it('ships only what the scene places', () => {
    // A scene with one hut should not carry every tree, rock and goblin the editor knows about.
    const { usedIds } = collectUsedAssets(scene(), manifest);
    expect(usedIds).toEqual(['building_hut_01', 'tree_pine_01']);
  });

  it('follows audio, which is referenced rather than placed', () => {
    const withSound = scene({
      audioConfig: {
        music: { menuTrackAssetId: 'audio_music_menu' },
        sfx: [{ event: 'pickup', assetId: 'audio_sfx_pickup' }],
      },
    });

    expect(collectUsedAssets(withSound, manifest).usedIds).toEqual([
      'audio_music_menu',
      'audio_sfx_pickup',
      'building_hut_01',
      'tree_pine_01',
    ]);
  });

  it('reports an asset the library does not have', () => {
    const broken = scene({
      objects: [{ id: 'obj_0001', assetId: 'not_a_real_asset' }],
    });
    expect(collectUsedAssets(broken, manifest).missing).toEqual(['not_a_real_asset']);
  });

  it('does not report built-in trigger volumes as missing', () => {
    // They have no files at all — the engine draws them — so a manifest never contains one.
    const withTrigger = scene({
      objects: [{ id: 'obj_0001', assetId: 'logic_trigger_box' }],
    });
    expect(collectUsedAssets(withTrigger, manifest).missing).toEqual([]);
  });
});

describe('buildExport', () => {
  it('writes a complete, runnable folder', async () => {
    const result = await plan();

    expect(pathsOf(result)).toEqual([
      'README.md',
      'assets/draco/draco_decoder.js',
      'assets/draco/draco_decoder.wasm',
      'assets/draco/draco_wasm_wrapper.js',
      'assets/manifest.json',
      'assets/models/hut.glb',
      'assets/models/pine.glb',
      'engine/runtime.js',
      'index.html',
      'main.js',
      'scene.json',
      'scene.source.json',
    ]);
  });

  it('uses relative paths everywhere', async () => {
    // An export is a folder somebody extracts wherever they like and serves from whatever root
    // they like, so an absolute path is always wrong — and wrong only on somebody else's machine.
    const result = await plan();
    const html = textOf(result, 'index.html');
    const main = textOf(result, 'main.js');

    expect(html).toContain('src="./main.js"');
    expect(main).toContain("'./engine/runtime.js'");
    expect(main).toContain("'./scene.json'");
    expect(main).toContain("'./assets/manifest.json'");
    expect(main).toContain("baseUrl: './assets/'");

    for (const file of [html, main]) {
      expect(file).not.toMatch(/(?:src|href|from)=?\s*["']\//);
      expect(file).not.toContain('http://localhost');
    }
  });

  it('ships a manifest listing only what it shipped', async () => {
    // One still advertising the whole library would send the loader after files that are not there.
    const result = await plan();
    const shipped = JSON.parse(textOf(result, 'assets/manifest.json')) as AssetManifest;

    expect(shipped.assets.map((asset) => asset.id)).toEqual(['building_hut_01', 'tree_pine_01']);
    expect(result.skippedAssetIds).toContain('rock_boulder_01');
  });

  it('ships the Draco decoder, without which every model silently fails to appear', async () => {
    const result = await plan();
    expect(pathsOf(result)).toContain('assets/draco/draco_decoder.wasm');
  });

  it('leaves the Draco decoder out of a scene with no models', async () => {
    const empty = await plan(scene({ objects: [] }));
    expect(pathsOf(empty).some((path) => path.includes('draco'))).toBe(false);
  });

  it('writes the scene compact, and a readable copy when asked', async () => {
    const withSource = await plan();
    expect(textOf(withSource, 'scene.json')).not.toContain('\n');
    expect(textOf(withSource, 'scene.source.json')).toContain('\n  ');

    const without = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, includeSource: false });
    expect(pathsOf(without)).not.toContain('scene.source.json');
  });

  it('produces a main.js that is still valid JavaScript when minified', async () => {
    // The bug this exists for: stripping `*`-prefixed lines before removing block comments leaves
    // an unclosed `/**` that swallows the import list. The export still looked plausible.
    const minified = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, minify: true });
    const main = textOf(minified, 'main.js');

    expect(main).toContain('GltfModelSource');
    expect(main).toContain('ManifestAssetResolver');
    expect(main).toContain('const loader = new SceneLoader');
    // Built twice: `load()` is synchronous and reads the model cache as it stands, so a single
    // build before `preload` renders placeholder boxes forever.
    expect(main.match(/viewport\.setScene/g)).toHaveLength(2);
    expect(main).not.toContain('/*');
    expect(main).not.toContain('*/');
    // Parsed for real rather than pattern-matched: the only assertion that catches the next
    // variation of the same mistake.
    expect(() => new Function(`return async () => {\n${main.replace(/^import[\s\S]*?;\n/, '')}\n}`))
      .not.toThrow();
  });

  it('keeps main.js readable even when minified', async () => {
    // Running a real minifier over the one file the user is invited to read would work against
    // the point of writing it out at all.
    const minified = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, minify: true });
    const main = textOf(minified, 'main.js');

    expect(main).toContain('new SceneLoader');
    expect(main).not.toContain('This file is yours');

    const readable = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, minify: false });
    expect(textOf(readable, 'main.js')).toContain('This file is yours');
  });

  it('puts the scene name in the page title, escaped', async () => {
    const nasty = await plan(scene({ name: '<script>alert(1)</script>' }));
    const html = textOf(nasty, 'index.html');

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('tells the reader how to run it, and why double-clicking will not work', async () => {
    const result = await plan();
    const readme = textOf(result, 'README.md');

    expect(readme).toContain('npx serve');
    expect(readme).toContain('file://');
    // And is honest about what a static export leaves out.
    expect(readme).toContain('static export');
  });

  it('warns rather than failing when an asset cannot be read', async () => {
    const result = await buildExport({
      scene: scene(),
      manifest,
      options: DEFAULT_EXPORT_OPTIONS,
      runtimeSource: '',
      readAsset: async (path) => {
        if (path.includes('pine')) throw new Error('gone');
        return new TextEncoder().encode('bytes');
      },
    });

    // One unreadable file must not cost somebody their whole export.
    expect(result.warnings.some((warning) => warning.includes('pine'))).toBe(true);
    expect(pathsOf(result)).toContain('assets/models/hut.glb');
  });

  it('warns about an asset the scene names but the library lacks', async () => {
    const result = await plan(scene({ objects: [{ id: 'obj_0001', assetId: 'ghost_asset' }] }));
    expect(result.warnings.some((warning) => warning.includes('ghost_asset'))).toBe(true);
  });

  it('ships audio when the scene uses it', async () => {
    const result = await plan(
      scene({
        audioConfig: { sfx: [{ event: 'pickup', assetId: 'audio_sfx_pickup' }] },
      }),
    );
    expect(pathsOf(result)).toContain('assets/audio/pickup.wav');
  });
});
