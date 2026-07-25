import { ENGINE_VERSION, ManifestAssetResolver, SceneLoader, Viewport } from '@helaengine/engine';
import { migrateScene, parseAssetManifest } from '@helaengine/schema';

/**
 * The Sprint 1 proof: a scene document goes in, a rendered world comes out, with no UI framework
 * and no state library anywhere in the chain. Whatever this file can do, an exported project can
 * do — it is deliberately close to what the exporter will emit in Sprint 13.
 */

const viewportElement = requireElement('viewport');

async function main(): Promise<void> {
  const [manifestJson, sceneJson] = await Promise.all([
    fetchJson('./manifest.json'),
    fetchJson('./demo-scene.json'),
  ]);

  // Both documents are validated before anything touches the renderer: a bad scene should fail
  // loudly at the boundary, never as a mystery NaN inside a transform ten frames later.
  const manifest = parseAssetManifest(manifestJson);
  const scene = migrateScene(sceneJson);

  const loader = new SceneLoader({ resolver: new ManifestAssetResolver(manifest) });
  const viewport = new Viewport({ container: viewportElement, loader });

  const loaded = viewport.setScene(scene);
  viewport.frameScene();
  viewport.start();

  if (loaded.missingAssetIds.length > 0) {
    console.warn('[demo] scene references unknown assets:', loaded.missingAssetIds);
  }

  setText('stat-scene', scene.name);
  setText('stat-objects', String(loaded.objects.size));
  setText('stat-version', ENGINE_VERSION);

  let framesSinceSample = 0;
  let secondsSinceSample = 0;
  viewport.onFrame((delta) => {
    framesSinceSample += 1;
    secondsSinceSample += delta;
    if (secondsSinceSample >= 0.5) {
      setText('stat-fps', Math.round(framesSinceSample / secondsSinceSample).toString());
      setText('stat-calls', String(viewport.renderer.info.render.calls));
      framesSinceSample = 0;
      secondsSinceSample = 0;
    }
  });

  // Hot reload in dev would otherwise stack a second renderer and controls onto the same element.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => viewport.dispose());
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

function showError(error: unknown): void {
  console.error(error);
  const panel = document.getElementById('error');
  const body = document.getElementById('error-body');
  if (!panel || !body) return;
  panel.style.display = 'grid';
  body.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

main().catch(showError);
