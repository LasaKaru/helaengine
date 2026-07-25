import {
  ENGINE_VERSION,
  GltfModelSource,
  ManifestAssetResolver,
  SceneLoader,
  Viewport,
} from '@helaengine/engine';
import { migrateScene, parseAssetManifest } from '@helaengine/schema';

/**
 * The proof that the engine stands alone: a scene document and an asset manifest go in, a rendered
 * world comes out, with no UI framework and no state library in the chain. Whatever this file can
 * do, an exported project can do — it is deliberately close to what the exporter emits in Sprint 13.
 */

const ASSET_BASE_URL = './assets/';

const viewportElement = requireElement('viewport');

async function main(): Promise<void> {
  setStatus('Loading scene…');

  const [manifestJson, sceneJson] = await Promise.all([
    fetchJson(`${ASSET_BASE_URL}manifest.json`),
    fetchJson('./demo-scene.json'),
  ]);

  // Both documents are validated before anything touches the renderer: a bad scene should fail
  // loudly at the boundary, never as a mystery NaN inside a transform ten frames later.
  const manifest = parseAssetManifest(manifestJson);
  const scene = migrateScene(sceneJson);

  const loader = new SceneLoader({
    resolver: new ManifestAssetResolver(manifest),
    modelSource: new GltfModelSource({ baseUrl: ASSET_BASE_URL }),
  });

  // Models are fetched up front so `load()` stays synchronous. Anything that fails to arrive
  // degrades to a placeholder box rather than taking the whole scene down with it.
  const report = await loader.preload(scene, (completed, total) => {
    setStatus(`Loading models… ${completed}/${total}`);
  });

  const viewport = new Viewport({ container: viewportElement, loader });
  const loaded = viewport.setScene(scene);
  viewport.frameScene();
  viewport.start();

  setStatus(null);

  if (loaded.missingAssetIds.length > 0) {
    console.warn('[demo] scene references unknown assets:', loaded.missingAssetIds);
  }
  if (report.failed.length > 0) {
    console.warn('[demo] some models fell back to placeholders:', report.failed);
  }

  setText('stat-scene', scene.name);
  setText('stat-objects', String(loaded.objects.size));
  setText('stat-models', `${report.loaded}/${report.requested}`);
  setText('stat-version', ENGINE_VERSION);

  let framesSinceSample = 0;
  let secondsSinceSample = 0;
  viewport.onFrame((delta) => {
    framesSinceSample += 1;
    secondsSinceSample += delta;
    if (secondsSinceSample >= 0.5) {
      setText('stat-fps', Math.round(framesSinceSample / secondsSinceSample).toString());
      setText('stat-calls', String(viewport.renderer.info.render.calls));
      setText('stat-tris', viewport.renderer.info.render.triangles.toLocaleString());
      framesSinceSample = 0;
      secondsSinceSample = 0;
    }
  });

  // Hot reload in dev would otherwise stack a second renderer and controls onto the same element.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      viewport.dispose();
      loader.disposeModels();
    });
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id} element`);
  return element;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

/** Shows or hides the loading overlay. Pass `null` once the first frame is on screen. */
function setStatus(message: string | null): void {
  const panel = document.getElementById('loading');
  const label = document.getElementById('loading-label');
  if (!panel || !label) return;
  panel.style.display = message === null ? 'none' : 'grid';
  label.textContent = message ?? '';
}

function showError(error: unknown): void {
  console.error(error);
  setStatus(null);
  const panel = document.getElementById('error');
  const body = document.getElementById('error-body');
  if (!panel || !body) return;
  panel.style.display = 'grid';
  body.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

main().catch(showError);
