import * as THREE from 'three';
import type {
  AssetManifestEntry,
  Environment,
  Scene,
  SceneObject,
  Terrain,
} from '@helaengine/schema';
import { MISSING_ASSET_ENTRY, type AssetResolver } from './assets.js';
import type { ModelSource } from './models.js';

const DEG2RAD = Math.PI / 180;

export interface SceneLoaderOptions {
  resolver: AssetResolver;
  /**
   * Supplies GLB models. Without one, every object renders as a manifest-sized placeholder box —
   * which is exactly what unit tests and the Sprint 1 demo want.
   */
  modelSource?: ModelSource;
  /** What to do when a scene references an unknown `assetId`. Default: 'placeholder'. */
  onMissingAsset?: 'placeholder' | 'throw';
  /** Sink for non-fatal load diagnostics. Default: `console.warn`. */
  warn?: (message: string) => void;
}

export interface PreloadFailure {
  assetId: string;
  glbPath: string;
  reason: string;
}

export interface PreloadReport {
  requested: number;
  loaded: number;
  failed: PreloadFailure[];
}

export type PreloadProgress = (completed: number, total: number) => void;

export class MissingAssetError extends Error {
  constructor(
    readonly assetId: string,
    readonly objectId: string,
  ) {
    super(`object "${objectId}" references unknown assetId "${assetId}"`);
    this.name = 'MissingAssetError';
  }
}

interface DisposableResource {
  dispose(): void;
}

/** Box standing in for an asset with no model — sized from the bounds the pipeline measured. */
function placeholderGeometry(
  entry: AssetManifestEntry,
  cache: Map<string, THREE.BufferGeometry>,
  disposables: DisposableResource[],
): THREE.BufferGeometry {
  const existing = cache.get(entry.id);
  if (existing) return existing;

  const [width, height, depth] = entry.bounds;
  const geometry = new THREE.BoxGeometry(width, height, depth);
  // Assets are authored with their pivot at the base (see the export conventions), so the
  // placeholder shifts up by half its height and y=0 means "standing on the ground".
  geometry.translate(0, height / 2, 0);
  cache.set(entry.id, geometry);
  disposables.push(geometry);
  return geometry;
}

function placeholderMaterial(
  entry: AssetManifestEntry,
  cache: Map<string, THREE.Material>,
  disposables: DisposableResource[],
): THREE.Material {
  const existing = cache.get(entry.placeholderColor);
  if (existing) return existing;

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(entry.placeholderColor),
    roughness: 0.85,
    metalness: 0,
  });
  cache.set(entry.placeholderColor, material);
  disposables.push(material);
  return material;
}

/**
 * The result of loading one scene document. Owns every GPU resource it created, so a caller can
 * swap scenes without leaking geometries/materials — the single most common Three.js memory bug.
 */
export class LoadedScene {
  readonly threeScene: THREE.Scene;
  readonly objects: ReadonlyMap<string, THREE.Object3D>;
  readonly missingAssetIds: readonly string[];
  readonly #disposables: DisposableResource[];

  constructor(init: {
    threeScene: THREE.Scene;
    objects: Map<string, THREE.Object3D>;
    missingAssetIds: string[];
    disposables: DisposableResource[];
  }) {
    this.threeScene = init.threeScene;
    this.objects = init.objects;
    this.missingAssetIds = init.missingAssetIds;
    this.#disposables = init.disposables;
  }

  /**
   * World-space bounds of the placed objects — deliberately excluding terrain and lights.
   *
   * Framing a camera on the whole scene graph would include the ground plane (often hundreds of
   * metres across) and the sun's position, pushing the camera so far back the content disappears
   * into the fog. Callers almost always want the bounds of the things the user placed.
   */
  getContentBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const object of this.objects.values()) {
      box.expandByObject(object);
    }
    if (!box.isEmpty()) return box;

    const terrain = this.threeScene.getObjectByName('terrain');
    return terrain ? new THREE.Box3().setFromObject(terrain) : box;
  }

  dispose(): void {
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
    this.#disposables.length = 0;
    this.threeScene.clear();
  }
}

/**
 * Turns a validated scene document into a Three.js scene graph.
 *
 * Deliberately framework-free and synchronous: this exact class runs inside the editor's viewport
 * and inside every exported project. If it ever needs React, Zustand or the DOM, the export story
 * is broken — see GUIDE.md section 7, risk 1.
 */
export class SceneLoader {
  readonly #resolver: AssetResolver;
  readonly #onMissingAsset: 'placeholder' | 'throw';
  readonly #warn: (message: string) => void;
  readonly #modelSource: ModelSource | null;
  readonly #models = new Map<string, THREE.Object3D>();

  constructor(options: SceneLoaderOptions) {
    this.#resolver = options.resolver;
    this.#onMissingAsset = options.onMissingAsset ?? 'placeholder';
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));
    this.#modelSource = options.modelSource ?? null;
  }

  /**
   * Fetches the models a scene needs, so that `load()` can stay synchronous.
   *
   * Keeping the load path synchronous matters more than it looks: it means `load()` can be called
   * mid-frame, in a test, or from an editor action without any of them having to be async, and it
   * keeps the "what does this scene look like" question separate from "have the bytes arrived".
   * An asset that fails to download degrades to a placeholder rather than failing the whole scene.
   */
  async preload(scene: Scene, onProgress?: PreloadProgress): Promise<PreloadReport> {
    const failed: PreloadFailure[] = [];
    if (!this.#modelSource) return { requested: 0, loaded: 0, failed };

    const wanted = new Map<string, string>();
    for (const object of scene.objects) {
      const entry = this.#resolver.get(object.assetId);
      if (entry?.glbPath && !this.#models.has(entry.id)) wanted.set(entry.id, entry.glbPath);
    }

    const total = wanted.size;
    let completed = 0;
    onProgress?.(0, total);

    await Promise.all(
      [...wanted].map(async ([assetId, glbPath]) => {
        try {
          this.#models.set(assetId, await this.#modelSource!.load(assetId, glbPath));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failed.push({ assetId, glbPath, reason });
          this.#warn(`failed to load model for "${assetId}" (${glbPath}): ${reason}`);
        } finally {
          completed += 1;
          onProgress?.(completed, total);
        }
      }),
    );

    return { requested: total, loaded: total - failed.length, failed };
  }

  /** Releases the models this loader preloaded. Loaded scenes hold clones and are unaffected. */
  disposeModels(): void {
    this.#models.clear();
    this.#modelSource?.dispose();
  }

  load(scene: Scene): LoadedScene {
    const threeScene = new THREE.Scene();
    threeScene.name = scene.name;
    const disposables: DisposableResource[] = [];
    const objects = new Map<string, THREE.Object3D>();
    const missingAssetIds: string[] = [];

    this.#applyEnvironment(threeScene, scene.environment, disposables);
    threeScene.add(this.#buildTerrain(scene.terrain, disposables));

    // Identical assets share one geometry/material pair; instancing proper arrives in Sprint 12.
    const materialCache = new Map<string, THREE.Material>();
    const geometryCache = new Map<string, THREE.BufferGeometry>();

    for (const object of scene.objects) {
      const entry = this.#resolveEntry(object, missingAssetIds);
      const mesh = this.#buildObject(object, entry, geometryCache, materialCache, disposables);
      objects.set(object.id, mesh);
      threeScene.add(mesh);
    }

    return new LoadedScene({ threeScene, objects, missingAssetIds, disposables });
  }

  #resolveEntry(object: SceneObject, missingAssetIds: string[]): AssetManifestEntry {
    const entry = this.#resolver.get(object.assetId);
    if (entry) return entry;

    if (this.#onMissingAsset === 'throw') {
      throw new MissingAssetError(object.assetId, object.id);
    }
    missingAssetIds.push(object.assetId);
    this.#warn(`object "${object.id}" references unknown assetId "${object.assetId}"`);
    return MISSING_ASSET_ENTRY;
  }

  #buildObject(
    object: SceneObject,
    entry: AssetManifestEntry,
    geometryCache: Map<string, THREE.BufferGeometry>,
    materialCache: Map<string, THREE.Material>,
    disposables: DisposableResource[],
  ): THREE.Object3D {
    // A preloaded model wins; otherwise the manifest's measured bounds become a placeholder box.
    // Clones share the source geometry and materials, so a hundred trees cost one of each.
    const model = this.#models.get(entry.id);
    const node = model
      ? model.clone(true)
      : new THREE.Mesh(
          placeholderGeometry(entry, geometryCache, disposables),
          placeholderMaterial(entry, materialCache, disposables),
        );

    node.name = object.metadata.label ?? object.id;
    node.castShadow = true;
    node.receiveShadow = true;
    node.userData['objectId'] = object.id;
    node.userData['assetId'] = object.assetId;

    const { position, rotation, scale } = object.transform;
    node.position.set(position[0], position[1], position[2]);
    node.rotation.set(rotation[0] * DEG2RAD, rotation[1] * DEG2RAD, rotation[2] * DEG2RAD);
    node.scale.set(
      scale[0] * entry.defaultScale[0],
      scale[1] * entry.defaultScale[1],
      scale[2] * entry.defaultScale[2],
    );

    return node;
  }

  #buildTerrain(terrain: Terrain, disposables: DisposableResource[]): THREE.Object3D {
    const [sizeX, sizeZ] = terrain.size;
    const geometry = new THREE.PlaneGeometry(sizeX, sizeZ, terrain.segments, terrain.segments);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(terrain.material.color),
      roughness: 1,
      metalness: 0,
    });
    disposables.push(geometry, material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.userData['isTerrain'] = true;
    return mesh;
  }

  #applyEnvironment(
    threeScene: THREE.Scene,
    environment: Environment,
    disposables: DisposableResource[],
  ): void {
    const background = new THREE.Color(environment.background);
    threeScene.background = background;

    if (environment.fog) {
      threeScene.fog = new THREE.Fog(
        new THREE.Color(environment.fog.color),
        environment.fog.near,
        environment.fog.far,
      );
    }

    const { sun, ambient } = environment.lighting;
    const ambientLight = new THREE.AmbientLight(0xffffff, ambient);
    ambientLight.name = 'ambient';
    threeScene.add(ambientLight);
    disposables.push(ambientLight);

    const sunLight = new THREE.DirectionalLight(new THREE.Color(sun.color), sun.intensity);
    sunLight.name = 'sun';
    const elevation = sun.elevation * DEG2RAD;
    const azimuth = sun.azimuth * DEG2RAD;
    const distance = 100;
    sunLight.position.set(
      distance * Math.cos(elevation) * Math.sin(azimuth),
      distance * Math.sin(elevation),
      distance * Math.cos(elevation) * Math.cos(azimuth),
    );
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 400;
    sunLight.shadow.camera.left = -100;
    sunLight.shadow.camera.right = 100;
    sunLight.shadow.camera.top = 100;
    sunLight.shadow.camera.bottom = -100;
    threeScene.add(sunLight);
    threeScene.add(sunLight.target);
    disposables.push(sunLight);
  }
}
