import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene, type AssetManifest, type Scene } from '@helaengine/schema';
import {
  buildExport,
  collectUsedAssets,
  DEFAULT_EXPORT_OPTIONS,
  formatBytes,
  SIZE_DANGER_BYTES,
  SIZE_WARN_BYTES,
  slugify,
  type ExportPlan,
} from './bundle.js';

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

/**
 * Parses generated code for real, rather than pattern-matching it.
 *
 * The bug this exists for shipped a `main.js` whose import list had been silently deleted, and
 * every regex assertion in the world passed.
 *
 * esbuild rather than `new Function`, since Sprint 34. `new Function` compiles a *script*, so the
 * import block and every `export` keyword had to be stripped before it would parse — the module
 * syntax, which is exactly the part the original bug broke, was the part not being checked. It was
 * also the single `new Function` in the repository, and a lint rule now forbids those outright:
 * this product's whole safety story is that a scene document is data and never code, and a rule
 * with an exception in it is a rule somebody will point at later.
 */
function parseAsScript(source: string): void {
  // Throws on a syntax error, which is the assertion. `esm` keeps import and export meaningful.
  transformSync(source, { loader: 'js', format: 'esm' });
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
      'CREDITS.md',
      'LICENSE.md',
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
    expect(() => parseAsScript(main)).not.toThrow();
  });

  it('keeps main.js readable even when minified', async () => {
    // Running a real minifier over the one file the user is invited to read would work against
    // the point of writing it out at all: the code survives, only the prose goes.
    const minified = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, minify: true });
    const main = textOf(minified, 'main.js');

    expect(main).toContain('new SceneLoader');
    expect(main).not.toContain('A HelaEngine game');

    const readable = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, minify: false });
    expect(textOf(readable, 'main.js')).toContain('A HelaEngine game');
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
    // And says what the controls are, since a game export opens on a menu.
    expect(readme).toContain('WASD');
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

describe('export modes', () => {
  it('starts nothing in a static export, and everything in a game one', async () => {
    const still = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, mode: 'static' });
    const staticMain = textOf(still, 'main.js');
    expect(staticMain).not.toContain('PhysicsWorld');
    expect(staticMain).not.toContain('UIRenderer');

    const playable = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, mode: 'game' });
    const gameMain = textOf(playable, 'main.js');
    for (const piece of ['PhysicsWorld', 'UIRenderer', 'startScene', 'InputManager', 'SaveStore']) {
      expect(gameMain).toContain(piece);
    }
  });

  it('tells a game export how to serve WebAssembly, because getting it wrong is silent', async () => {
    const playable = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, mode: 'game' });
    const readme = textOf(playable, 'README.md');

    expect(readme).toContain('application/wasm');
    // And is accurate about *which* WASM: `rapier3d-compat` inlines its own as base64 inside the
    // JavaScript, so there is no physics `.wasm` file to misconfigure. Only Draco's is real.
    expect(readme).toContain('draco_decoder.wasm');
    expect(readme).toContain('no separate');

    const still = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, mode: 'static' });
    expect(textOf(still, 'README.md')).toContain('static export');
  });

  it('writes the level out as readable code when asked, and not otherwise', async () => {
    const readable = await plan(scene(), {
      ...DEFAULT_EXPORT_OPTIONS,
      codeStyle: 'readable',
      minify: false,
    });
    const main = textOf(readable, 'main.js');

    expect(main).toContain('export function describeLevel');
    expect(main).toContain("place('building_hut_01'");
    expect(main).toContain("id: 'obj_0001'");
    // Cosmetic and honest about it: the engine is data-driven and this reproduces the document.
    expect(main).toContain('already in scene.json');

    const plain = await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, codeStyle: 'document' });
    expect(textOf(plain, 'main.js')).not.toContain('describeLevel');
  });

  it('lists behaviours and triggers in the readable listing', async () => {
    const withGameplay = scene({
      objects: [
        {
          id: 'obj_0001',
          assetId: 'building_hut_01',
          transform: { position: [1, 2, 3], rotation: [0, 45, 0] },
          behaviors: [{ type: 'patrol', params: { speed: 3 } }],
        },
      ],
    });
    const main = textOf(
      await plan(withGameplay, { ...DEFAULT_EXPORT_OPTIONS, codeStyle: 'readable', minify: false }),
      'main.js',
    );

    expect(main).toContain('position: [1, 2, 3]');
    expect(main).toContain('rotation: [0, 45, 0]');
    expect(main).toContain('behaviour: patrol');
  });

  it('still parses when a readable game export is minified', async () => {
    // The combination most likely to break: two templates concatenated, then comment-stripped.
    const main = textOf(
      await plan(scene(), {
        ...DEFAULT_EXPORT_OPTIONS,
        mode: 'game',
        codeStyle: 'readable',
        minify: true,
      }),
      'main.js',
    );

    expect(main).not.toContain('/*');
    expect(main).not.toContain('*/');
    expect(() => parseAsScript(main)).not.toThrow();
  });
});

describe('credits and licence', () => {
  it('credits every asset that shipped, and says when a licence is not recorded', async () => {
    // A gap somebody can see is worth more than a tidy file that quietly leaves things out.
    const result = await plan();
    const text = textOf(result, 'CREDITS.md');

    expect(text).toContain('building_hut_01');
    expect(text).toContain('tree_pine_01');
    expect(text).not.toContain('rock_boulder_01');
    expect(text).toContain('licence not recorded');
    expect(text).toContain('Three.js');
  });

  it('uses the attribution the manifest carries', async () => {
    const credited = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'building_hut_01',
          name: 'Hut',
          category: 'buildings',
          glbPath: 'models/hut.glb',
          author: 'Someone',
          license: 'CC-BY-4.0',
          sourceUrl: 'https://example.invalid/hut',
        },
      ],
    });
    const result = await buildExport({
      scene: scene({ objects: [{ id: 'obj_0001', assetId: 'building_hut_01' }] }),
      manifest: credited,
      options: DEFAULT_EXPORT_OPTIONS,
      runtimeSource: '',
      readAsset: async () => new Uint8Array(),
    });

    const text = textOf(result, 'CREDITS.md');
    expect(text).toContain('by Someone');
    expect(text).toContain('CC-BY-4.0');
    expect(text).toContain('https://example.invalid/hut');
  });

  it('credits the physics engine only when it ships', async () => {
    expect(
      textOf(await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, mode: 'game' }), 'CREDITS.md'),
    ).toContain('Rapier');
    expect(
      textOf(await plan(scene(), { ...DEFAULT_EXPORT_OPTIONS, mode: 'static' }), 'CREDITS.md'),
    ).not.toContain('Rapier');
  });

  it('leaves the author their own licence to choose', async () => {
    const text = textOf(await plan(), 'LICENSE.md');
    expect(text).toContain('<your name here>');
    expect(text).toContain('MIT');
  });
});

describe('size budgeting', () => {
  it('reports what the export weighs, uncompressed', async () => {
    const result = await plan();
    const summed = result.files.reduce(
      (sum, file) => sum + (file.bytes ? file.bytes.byteLength : new Blob([file.text ?? '']).size),
      0,
    );

    expect(result.totalBytes).toBe(summed);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  it('says nothing about size when there is nothing to say', async () => {
    const result = await plan();
    expect(result.warnings.some((warning) => warning.includes('before compression'))).toBe(false);
  });

  it('warns past the soft budget and escalates past the hard one', async () => {
    // Sized by the asset reader rather than by building a real scene: what is under test is the
    // threshold, and a 200 MB fixture on disk would be a poor way to check a comparison.
    const big = async (bytes: number): Promise<ExportPlan> =>
      buildExport({
        scene: scene(),
        manifest,
        options: DEFAULT_EXPORT_OPTIONS,
        runtimeSource: '',
        readAsset: async () => new Uint8Array(bytes),
      });

    const warned = (await big(Math.ceil(SIZE_WARN_BYTES / 2) + 1)).warnings.join(' ');
    expect(warned).toContain('before compression');
    expect(warned).not.toContain('memory');

    const dangerous = (await big(Math.ceil(SIZE_DANGER_BYTES / 2) + 1)).warnings.join(' ');
    expect(dangerous).toContain("browser's memory");
  });

  it('formats bytes the way a person reads them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('troubleshooting docs', () => {
  it('documents the failures that actually happen, and only those', async () => {
    const text = textOf(await plan(), 'README.md');

    expect(text).toContain('Troubleshooting');
    // The two silent ones: modules refused over file://, and a Draco decoder served as the wrong
    // content type — which turns every model into a grey box with nothing in the console about it.
    expect(text).toContain('file://');
    expect(text).toContain('application/wasm');
    expect(text).toContain('draco_decoder.wasm');
    // And not the failure that cannot happen: rapier3d-compat inlines its WASM as base64, so a
    // game export has no physics `.wasm` for a host to mis-serve.
    expect(text).not.toContain('rapier_wasm');
  });
});
