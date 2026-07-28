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
import { LAYER_COUNT, TerrainField } from './TerrainField.js';

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

export interface PreviewNode {
  node: THREE.Object3D;
  /** Releases anything this preview allocated. Safe to call more than once. */
  dispose(): void;
}

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
 * Rebuilds the editable terrain field from a scene document.
 *
 * A document carries the terrain as base64; everything that wants to sample, sculpt or render it
 * works from a `TerrainField`, so decoding happens once, here.
 */
export function terrainFieldFromDocument(terrain: Terrain): TerrainField {
  const field = new TerrainField({
    segments: terrain.segments,
    size: terrain.size,
    maxHeight: terrain.maxHeight,
  });
  if (terrain.heightmap) field.decodeHeights(terrain.heightmap.data);
  if (terrain.splatmap) field.decodeWeights(terrain.splatmap.data);
  return field;
}

/** Applies a document transform to a node. Rotation is authored in degrees, converted once here. */
function applyTransform(node: THREE.Object3D, object: SceneObject): void {
  const { position, rotation, scale } = object.transform;
  node.position.set(position[0], position[1], position[2]);
  node.rotation.set(rotation[0] * DEG2RAD, rotation[1] * DEG2RAD, rotation[2] * DEG2RAD);
  node.scale.set(scale[0], scale[1], scale[2]);
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
  /** Exactly the nodes this load added to `threeScene`, so teardown touches nothing else. */
  readonly #added: THREE.Object3D[];

  constructor(init: {
    threeScene: THREE.Scene;
    objects: Map<string, THREE.Object3D>;
    missingAssetIds: string[];
    disposables: DisposableResource[];
    added: THREE.Object3D[];
  }) {
    this.threeScene = init.threeScene;
    this.objects = init.objects;
    this.missingAssetIds = init.missingAssetIds;
    this.#disposables = init.disposables;
    this.#added = init.added;
  }

  /**
   * World-space bounds of the placed objects — deliberately excluding terrain and lights.
   *
   * Framing a camera on the whole scene graph would include the ground plane (often hundreds of
   * metres across) and the sun's position, pushing the camera so far back the content disappears
   * into the fog. Callers almost always want the bounds of the things the user placed.
   */
  /** The terrain mesh, or null for a scene that somehow has none. */
  get terrain(): THREE.Mesh | null {
    return (this.threeScene.getObjectByName('terrain') as THREE.Mesh | undefined) ?? null;
  }

  /** The editable height/paint data behind the terrain mesh. */
  get terrainField(): TerrainField | null {
    return (this.terrain?.userData['terrainField'] as TerrainField | undefined) ?? null;
  }

  /**
   * Pushes the field's current heights and colours into the terrain geometry.
   *
   * This is the sculpt equivalent of `syncTransforms`: a stroke mutates the field and refreshes
   * the geometry in place, without the document — and therefore the undo stack — being touched
   * until the stroke ends.
   */
  refreshTerrain(layerColors: string[]): void {
    const mesh = this.terrain;
    const field = this.terrainField;
    if (mesh && field) field.updateGeometry(mesh.geometry, layerColors);
  }

  /**
   * Re-reads the document's heightmap and paint data into the live field.
   *
   * The sculpt path deliberately edits the field directly and only writes the document when a
   * stroke ends — which means the document can also move without the field: an undo, a redo, or a
   * scene loaded from elsewhere. This is the way back, and the terrain equivalent of
   * `syncTransforms`.
   */
  syncTerrain(terrain: Terrain): void {
    const field = this.terrainField;
    if (!field) return;

    if (terrain.heightmap) field.decodeHeights(terrain.heightmap.data);
    else field.heights.fill(0);

    if (terrain.splatmap) {
      field.decodeWeights(terrain.splatmap.data);
    } else {
      field.weights.fill(0);
      for (let index = 0; index < field.width * field.width; index += 1) {
        field.weights[index * LAYER_COUNT] = 255;
      }
    }

    field.maxHeight = terrain.maxHeight;
    this.refreshTerrain(terrain.layers.map((layer) => layer.color));
  }

  getContentBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const object of this.objects.values()) {
      box.expandByObject(object);
    }
    if (!box.isEmpty()) return box;

    const terrain = this.threeScene.getObjectByName('terrain');
    return terrain ? new THREE.Box3().setFromObject(terrain) : box;
  }

  /**
   * Cheaply re-applies transforms from a scene document to the nodes already built.
   *
   * Rebuilding the whole scene on every document change is fine while edits are discrete, but a
   * gizmo drag emits a change per frame — and a rebuild mid-drag destroys the very node the gizmo
   * is attached to. This is the fast path for "same objects, different transforms"; callers must
   * still rebuild when objects are added, removed or re-assigned to a different asset.
   *
   * Returns the number of nodes updated, so a caller can notice when it should have rebuilt.
   */
  syncTransforms(scene: Scene): number {
    let updated = 0;
    for (const object of scene.objects) {
      const node = this.objects.get(object.id);
      if (!node) continue;

      applyTransform(node, object);
      updated += 1;
    }
    return updated;
  }

  dispose(): void {
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
    this.#disposables.length = 0;

    // Removing only what was added — rather than `scene.clear()` — matters when the scene is
    // owned by someone else, as it is under react-three-fiber in the editor.
    for (const node of this.#added) this.threeScene.remove(node);
    this.#added.length = 0;

    this.threeScene.background = null;
    this.threeScene.fog = null;
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

  /**
   * Builds a standalone node for an asset, outside any scene — the editor's drag ghost.
   *
   * It deliberately goes through the same path a real placement does, so the shape under the
   * cursor is the shape that lands. The caller owns the result and must dispose whatever it
   * creates; a preview built from a placeholder allocates its own geometry, while one built from
   * a preloaded model shares the cached original's.
   */
  createPreviewNode(assetId: string): PreviewNode | null {
    const entry = this.#resolver.get(assetId);
    if (!entry) return null;

    const model = this.#models.get(entry.id);
    if (model) {
      const node = model.clone(true);
      node.scale.set(...entry.defaultScale);
      return { node, dispose: () => {} };
    }

    const disposables: DisposableResource[] = [];
    const node = new THREE.Mesh(
      placeholderGeometry(entry, new Map(), disposables),
      placeholderMaterial(entry, new Map(), disposables),
    );
    node.scale.set(...entry.defaultScale);
    return {
      node,
      dispose: () => {
        for (const disposable of disposables) disposable.dispose();
      },
    };
  }

  /** Releases the models this loader preloaded. Loaded scenes hold clones and are unaffected. */
  disposeModels(): void {
    this.#models.clear();
    this.#modelSource?.dispose();
  }

  /** Builds a fresh `THREE.Scene` from a document. */
  load(scene: Scene): LoadedScene {
    return this.loadInto(new THREE.Scene(), scene);
  }

  /**
   * Populates an existing `THREE.Scene` instead of creating one.
   *
   * The editor's viewport is hosted by react-three-fiber, which owns its own scene and render
   * loop. Rather than nesting a second scene inside it — which would silently drop background and
   * fog, since Three only reads those from the root — the editor hands its scene here. Same code
   * path, same result, no editor-specific branch inside the engine.
   */
  loadInto(threeScene: THREE.Scene, scene: Scene): LoadedScene {
    threeScene.name = scene.name;
    const disposables: DisposableResource[] = [];
    const objects = new Map<string, THREE.Object3D>();
    const missingAssetIds: string[] = [];
    const added: THREE.Object3D[] = [];

    this.#applyEnvironment(threeScene, scene.environment, disposables, added);

    const terrain = this.#buildTerrain(scene.terrain, disposables);
    threeScene.add(terrain);
    added.push(terrain);

    // Identical assets share one geometry/material pair; instancing proper arrives in Sprint 12.
    const materialCache = new Map<string, THREE.Material>();
    const geometryCache = new Map<string, THREE.BufferGeometry>();

    for (const object of scene.objects) {
      const entry = this.#resolveEntry(object, missingAssetIds);
      objects.set(
        object.id,
        this.#buildObject(object, entry, geometryCache, materialCache, disposables),
      );
    }

    // Parenting is a second pass so declaration order in the document never matters — a child may
    // appear before its parent. The schema has already rejected cycles and dangling parents, but
    // the loader degrades to root placement rather than trusting that blindly.
    for (const object of scene.objects) {
      const node = objects.get(object.id);
      if (!node) continue;

      const parent = object.parentId === null ? null : objects.get(object.parentId);
      if (object.parentId !== null && !parent) {
        this.#warn(
          `object "${object.id}" has unknown parentId "${object.parentId}"; placing at root`,
        );
      }

      if (parent) {
        parent.add(node);
      } else {
        threeScene.add(node);
        added.push(node);
      }
    }

    return new LoadedScene({ threeScene, objects, missingAssetIds, disposables, added });
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
    const visual = model
      ? model.clone(true)
      : new THREE.Mesh(
          placeholderGeometry(entry, geometryCache, disposables),
          placeholderMaterial(entry, materialCache, disposables),
        );

    visual.castShadow = true;
    visual.receiveShadow = true;
    // The manifest's default scale lives on an inner node, not on the object node itself.
    // Otherwise a scaled parent would silently multiply the size of everything nested under it —
    // a rendering detail leaking into the scene graph.
    visual.scale.set(...entry.defaultScale);
    visual.name = `${object.id}:visual`;

    const node = new THREE.Group();
    node.name = object.metadata.label ?? object.id;
    node.userData['objectId'] = object.id;
    node.userData['assetId'] = object.assetId;
    // Explicit rather than inferred from the node shape: tooling needs to distinguish a real model
    // from a placeholder, and "does it have children" stopped being a reliable signal once every
    // object became a group.
    node.userData['hasModel'] = model !== undefined;
    node.add(visual);

    applyTransform(node, object);
    return node;
  }

  #buildTerrain(terrain: Terrain, disposables: DisposableResource[]): THREE.Object3D {
    const field = terrainFieldFromDocument(terrain);

    // Flat terrain keeps a single flat colour; sculpted terrain blends its four layers per vertex.
    // Per-vertex blending rather than a splat-mapped shader: at low-poly densities the vertex grid
    // *is* the paint resolution, and it keeps the material an ordinary MeshStandardMaterial that
    // any exported project can render without shader plumbing.
    const useLayers = terrain.type === 'heightmap';
    const geometry = field.buildGeometry(terrain.layers.map((layer) => layer.color));
    const material = new THREE.MeshStandardMaterial({
      color: useLayers ? new THREE.Color('#ffffff') : new THREE.Color(terrain.material.color),
      vertexColors: useLayers,
      roughness: 1,
      metalness: 0,
    });
    disposables.push(geometry, material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.userData['isTerrain'] = true;
    mesh.userData['terrainField'] = field;
    return mesh;
  }

  #applyEnvironment(
    threeScene: THREE.Scene,
    environment: Environment,
    disposables: DisposableResource[],
    added: THREE.Object3D[],
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
    added.push(ambientLight);
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
    added.push(sunLight, sunLight.target);
    disposables.push(sunLight);
  }
}
