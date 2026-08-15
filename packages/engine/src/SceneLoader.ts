import * as THREE from 'three';
import {
  destructibleAssets,
  SHADOW_MAP_SIZE,
  type AssetManifestEntry,
  type Environment,
  type MaterialOverride,
  type Scene,
  type SceneObject,
  type Terrain,
  resolveSway,
  windIsActive,
  NO_WIND,
  type Wind,
} from '@helaengine/schema';
import { MISSING_ASSET_ENTRY, type AssetResolver } from './assets.js';
import { applyMaterialOverride, restoreOriginalMaterials } from './materials.js';
import { buildScatter, buildScatterMeshes } from './scatter/ScatterField.js';
import {
  applyWindToObject,
  createWindUniforms,
  updateWindUniforms,
  type WindUniforms,
} from './render/wind.js';
import { InstanceManager } from './InstanceManager.js';
import { modelClips, type ModelSource } from './models.js';
import { Animator } from './animation/Animator.js';
import { cloneModel } from './animation/clone.js';
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
  /**
   * How many copies of one asset it takes before they are drawn as instances. 0 disables batching.
   *
   * Below the threshold a batch costs more than it saves — an extra buffer, an extra bounding
   * sphere that never culls — so a handful of huts stay ordinary meshes and a forest does not.
   */
  instanceThreshold?: number;
}

/** Default batching threshold. Eight is where one buffer starts beating eight draw calls. */
export const DEFAULT_INSTANCE_THRESHOLD = 8;

/** Ceiling on recycled nodes per asset, so a pool can never become a slow leak. */
export const POOL_LIMIT_PER_ASSET = 64;

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

/** How the environment is built. One implementation, used by the initial load and by every resync. */
type EnvironmentBuilder = (
  threeScene: THREE.Scene,
  environment: Environment,
  disposables: DisposableResource[],
  added: THREE.Object3D[],
) => void;

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

/**
 * The outline drawn for a trigger volume.
 *
 * A unit box or unit sphere, sized entirely by the object's own scale — so the scale gizmo the
 * user already knows is the tool for resizing a trigger, and there is only one answer to how big
 * the volume is.
 */
function buildTriggerVisual(
  shape: 'box' | 'sphere',
  disposables: DisposableResource[],
): THREE.Object3D {
  const geometry =
    shape === 'sphere' ? new THREE.SphereGeometry(0.5, 16, 12) : new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(geometry, 20);
  const material = new THREE.LineBasicMaterial({ color: '#f2c14e' });
  geometry.dispose();
  disposables.push(edges, material);

  const outline = new THREE.LineSegments(edges, material);
  // Volumes are centred on their object rather than sitting on it: a doorway trigger wants to
  // straddle the threshold, not perch above it.
  outline.position.y = 0.5;
  outline.name = 'trigger-outline';
  return outline;
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
  readonly #objects: Map<string, THREE.Object3D>;
  readonly missingAssetIds: readonly string[];
  readonly #disposables: DisposableResource[];
  /**
   * Resources owned by exactly one object, so deleting that object can free them immediately.
   *
   * The split matters and is not cosmetic. Placeholder geometries and materials are *cached per
   * asset* and shared by every object using that asset — freeing one on delete would blank every
   * other tree in the level. What lands here is only what was built for one object and is reachable
   * from nowhere else: a trigger volume's edges geometry and its line material.
   */
  readonly #owned: Map<string, DisposableResource[]>;
  /** Exactly the nodes this load added to `threeScene`, so teardown touches nothing else. */
  readonly #added: THREE.Object3D[];

  /** Batched static objects, if any. Their nodes live in `objects` but not in the scene graph. */
  readonly instances: InstanceManager | null;
  /** Wind uniforms, or null when nothing in this scene sways. */
  #wind: WindUniforms | null;
  /** The current wind settings, kept in step by `syncEnvironment`. */
  #windSettings: Wind;
  readonly #scatterCount: number;

  /**
   * Rigged objects, keyed by object id.
   *
   * Maintained as objects are adopted and released rather than derived on demand, because the
   * frame loop reads it: scanning 500 objects sixty times a second to find the four rigged ones is
   * work with an answer that only changes when something spawns or dies.
   */
  readonly #animators = new Map<string, Animator>();

  /** The animator for one object, for callers that drive a specific character. */
  animator(objectId: string): Animator | undefined {
    return this.#animators.get(objectId);
  }

  /** How many objects in this scene are animated. */
  get animatedCount(): number {
    return this.#animators.size;
  }

  /** Advances every animator. Called once a frame by the game runtime. */
  /** How many scattered instances this scene grew, across every layer. */
  get scatterCount(): number {
    return this.#scatterCount;
  }

  get windActive(): boolean {
    return this.#wind !== null;
  }

  /**
   * Advances the wind by a frame.
   *
   * Driven by delta rather than by a clock, so pausing the game stops the world moving — a paused
   * level whose grass keeps waving looks like the pause did not take. Wrapped at an hour so the
   * float does not lose precision in a session somebody leaves open all day, and wrapped at a
   * multiple of 2π so the wave does not jump at the seam.
   */
  updateWind(deltaSeconds: number): void {
    if (!this.#wind) return;
    const WRAP = Math.PI * 2 * 1000;
    this.#wind.helaWindTime.value =
      (this.#wind.helaWindTime.value + deltaSeconds * this.#windSettings.speed * Math.PI * 2) %
      WRAP;
    updateWindUniforms(this.#wind, this.#windSettings);
  }

  /**
   * Takes new wind settings without rebuilding anything.
   *
   * Strength, direction, speed and gustiness are uniforms, so dragging a slider is free. Changing
   * *which groups* sway is not — it decides which materials carry the program at all — so that one
   * is reported rather than applied, and the caller reloads.
   */
  setWind(wind: Wind): boolean {
    const groupsChanged =
      this.#windSettings.affects.join() !== wind.affects.join() ||
      windIsActive(this.#windSettings) !== windIsActive(wind);
    this.#windSettings = wind;
    if (this.#wind) updateWindUniforms(this.#wind, wind);
    return !groupsChanged;
  }

  updateAnimations(deltaSeconds: number): void {
    for (const animator of this.#animators.values()) animator.update(deltaSeconds);
  }

  /**
   * The lights, fog and background this scene built, so they can be replaced without a full reload.
   *
   * Tracked separately from `#added` because they are the one part of a scene that changes on its
   * own schedule: a colour picker moves sixty times a second while it is dragged, and rebuilding
   * every object for each frame of that would destroy the node a gizmo is attached to, mid-drag.
   */
  readonly #environmentNodes: THREE.Object3D[] = [];
  readonly #environmentDisposables: DisposableResource[] = [];

  /** Called by the loader as it builds the environment, so the scene knows what to take back. */
  registerEnvironment(nodes: THREE.Object3D[], disposables: DisposableResource[]): void {
    this.#environmentNodes.push(...nodes);
    this.#environmentDisposables.push(...disposables);
  }

  /**
   * Applies, changes or clears one object's material override, in place.
   *
   * Incremental for the same reason the environment sync is: a colour picker moves sixty times a
   * second while it is dragged, and rebuilding the object per frame would destroy the node a gizmo
   * is attached to. It also exists for the same reason — until it did, a material override was
   * written to the document, saved and exported, and changed nothing in the viewport.
   */
  setMaterial(objectId: string, override: MaterialOverride | null): void {
    const node = this.#objects.get(objectId);
    if (!node) return;

    for (const material of (node.userData['materialClones'] as THREE.Material[] | undefined) ??
      []) {
      material.dispose();
    }
    delete node.userData['materialClones'];
    restoreOriginalMaterials(node);

    if (override) node.userData['materialClones'] = applyMaterialOverride(node, override);
  }

  /**
   * Replaces the lights, fog and background from a changed document.
   *
   * The environment equivalent of `syncTerrain`, and it exists because until now **no environment
   * change reached the viewport at all**. The editor rebuilds a scene when objects or terrain
   * change; a sun colour, an ambient intensity or a shadow quality was written to the document and
   * silently ignored, because nothing was keyed on it. The setting appeared to work — it was
   * saved, it survived a reload, it exported — and did nothing while you were looking at it.
   */
  syncEnvironment(environment: Environment, build: EnvironmentBuilder): void {
    for (const node of this.#environmentNodes) {
      node.removeFromParent();
      const at = this.#added.indexOf(node);
      if (at >= 0) this.#added.splice(at, 1);
    }
    for (const disposable of this.#environmentDisposables) disposable.dispose();
    this.#environmentNodes.length = 0;
    this.#environmentDisposables.length = 0;

    const nodes: THREE.Object3D[] = [];
    const disposables: DisposableResource[] = [];
    build(this.threeScene, environment, disposables, nodes);
    this.#added.push(...nodes);
    this.registerEnvironment(nodes, disposables);
  }

  constructor(init: {
    threeScene: THREE.Scene;
    objects: Map<string, THREE.Object3D>;
    missingAssetIds: string[];
    disposables: DisposableResource[];
    owned?: Map<string, DisposableResource[]>;
    added: THREE.Object3D[];
    instances?: InstanceManager | null;
    wind?: WindUniforms | null;
    windSettings?: Wind;
    scatterCount?: number;
  }) {
    this.threeScene = init.threeScene;
    this.objects = init.objects;
    this.#objects = init.objects;
    this.missingAssetIds = init.missingAssetIds;
    this.#disposables = init.disposables;
    this.#owned = init.owned ?? new Map();
    this.#added = init.added;
    this.instances = init.instances ?? null;
    this.#wind = init.wind ?? null;
    this.#windSettings = init.windSettings ?? NO_WIND;
    this.#scatterCount = init.scatterCount ?? 0;

    // Objects placed by the initial load arrive here already built, without passing through
    // `adopt` — so the index has to be seeded, or a scene's animators would only ever be the ones
    // spawned after it loaded.
    for (const [id, node] of this.#objects) {
      const animator = node.userData['animator'] as Animator | undefined;
      if (animator) this.#animators.set(id, animator);
    }
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

  /**
   * Takes ownership of a node created after the initial load — something a trigger spawned.
   *
   * The runtime needs spawned objects to behave exactly like placed ones: pickable, transform-
   * syncable, and disposed with the rest of the scene. Registering them here rather than adding
   * them to `threeScene` directly is what makes that true.
   */
  adopt(objectId: string, node: THREE.Object3D, disposables: DisposableResource[] = []): void {
    this.#objects.set(objectId, node);
    this.threeScene.add(node);
    this.#added.push(node);

    // A node coming back out of the loader's pool carries the resources it owned before it was
    // recycled, since `release` parked them there rather than freeing them. Re-registering both
    // sources is what keeps a spawn/despawn/respawn cycle from either leaking or double-freeing.
    const parked = (node.userData['ownedDisposables'] as DisposableResource[] | undefined) ?? [];
    delete node.userData['ownedDisposables'];

    const owned = [...parked, ...disposables];
    if (owned.length > 0) this.#owned.set(objectId, owned);

    const animator = node.userData['animator'] as Animator | undefined;
    if (animator) this.#animators.set(objectId, animator);
  }

  /**
   * Removes a node this scene owns and takes it out of the world, freeing what only it was using.
   *
   * Deleting an object used to detach the node and leave its GPU resources on the scene-wide list
   * until the project closed — so a session that placed and deleted fifty trigger volumes held
   * fifty edges geometries and fifty line materials it could never reach again. That is the
   * un-disposed-on-delete leak, and this is where it is paid off.
   *
   * `keepResources` is for the object pool: a recycled node is going to be used again, so its
   * resources are parked on the node rather than freed, and `adopt` picks them back up.
   */
  release(objectId: string, options: { keepResources?: boolean } = {}): void {
    const node = this.#objects.get(objectId);
    if (!node) return;

    const owned = this.#owned.get(objectId);
    // Deleted from the map either way: leaving the entry behind would make `dispose` free
    // resources a second time, or free ones the pool has already handed to another object.
    this.#owned.delete(objectId);
    if (owned) {
      if (options.keepResources) node.userData['ownedDisposables'] = owned;
      else for (const disposable of owned) disposable.dispose();
    }

    // Material clones are per object and reachable from nowhere else, so a session that recolours
    // fifty objects and deletes them must not keep fifty materials it can never reach again.
    if (!options.keepResources) {
      for (const material of (node.userData['materialClones'] as THREE.Material[] | undefined) ??
        []) {
        material.dispose();
      }
      delete node.userData['materialClones'];
    }

    this.instances?.remove(objectId);
    this.#objects.delete(objectId);
    // Removed whether or not its resources were freed: a pooled node keeps its animator parked on
    // `userData` and `adopt` re-registers it, so leaving the entry here would drive an animator
    // belonging to an object that is no longer in the world.
    this.#animators.delete(objectId);
    node.removeFromParent();
    const at = this.#added.indexOf(node);
    if (at >= 0) this.#added.splice(at, 1);
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
      // A batched object's node is detached, so nothing updates its world matrix for us — and the
      // instance buffer is the only place its new transform actually shows up.
      if (this.instances?.has(object.id)) {
        node.updateMatrixWorld(true);
        this.instances.setMatrix(object.id, node.matrixWorld);
      }
      updated += 1;
    }
    return updated;
  }

  dispose(): void {
    this.instances?.dispose();
    // Per-object resources first, and only the ones still held: anything already released has been
    // freed and taken out of the map, so nothing here is disposed twice.
    for (const owned of this.#owned.values()) {
      for (const disposable of owned) disposable.dispose();
    }
    this.#owned.clear();

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
  readonly #instanceThreshold: number;
  /**
   * Nodes kept for reuse, by asset id.
   *
   * Spawning is the one thing a running game does over and over — a wave of enemies, a projectile,
   * a pickup — and building a node means cloning a model tree and allocating a matrix per part
   * every time. Recycling the tree instead turns a steady drip of garbage into none, which matters
   * far more than the allocation itself: a collection pause is a dropped frame.
   */
  readonly #pool = new Map<string, THREE.Object3D[]>();

  constructor(options: SceneLoaderOptions) {
    this.#resolver = options.resolver;
    this.#onMissingAsset = options.onMissingAsset ?? 'placeholder';
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));
    this.#modelSource = options.modelSource ?? null;
    this.#instanceThreshold = options.instanceThreshold ?? DEFAULT_INSTANCE_THRESHOLD;
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
    const want = (assetId: string): void => {
      const entry = this.#resolver.get(assetId);
      if (entry?.glbPath && !this.#models.has(entry.id)) wanted.set(entry.id, entry.glbPath);
    };

    for (const object of scene.objects) want(object.assetId);
    // Scatter layers name models nothing else in the document references. Without this a field
    // would ask the cache for a model no pass ever fetched, and simply never grow — silently, since
    // an empty field renders perfectly well.
    for (const layer of scene.scatter) if (layer.enabled) want(layer.assetId);
    // Debris is the same trap one step later: a crate's fragments are named nowhere else, so
    // without this the first break asks the cache for a model no pass fetched. The crate would
    // disappear and leave nothing behind — which looks exactly like an effect that does not work.
    for (const object of scene.objects) {
      if (object.destructible)
        for (const assetId of destructibleAssets(object.destructible)) want(assetId);
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
    // Pooled nodes may be parked holding resources they exclusively own (see `recycle`). Dropping
    // the pool without freeing those is the same leak in a quieter place.
    for (const pool of this.#pool.values()) {
      for (const node of pool) {
        const parked = node.userData['ownedDisposables'] as DisposableResource[] | undefined;
        for (const disposable of parked ?? []) disposable.dispose();
        delete node.userData['ownedDisposables'];
      }
    }
    this.#pool.clear();
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

    // Built into its own lists as well as the scene-wide ones, so `syncEnvironment` can take
    // exactly these back later without touching anything an object owns.
    const environmentNodes: THREE.Object3D[] = [];
    const environmentDisposables: DisposableResource[] = [];
    this.#applyEnvironment(threeScene, scene.environment, environmentDisposables, environmentNodes);
    added.push(...environmentNodes);

    const terrain = this.#buildTerrain(scene.terrain, disposables);
    threeScene.add(terrain);
    added.push(terrain);

    // Identical assets share one geometry/material pair; instancing proper arrives in Sprint 12.
    const materialCache = new Map<string, THREE.Material>();
    const geometryCache = new Map<string, THREE.BufferGeometry>();

    const owned = new Map<string, DisposableResource[]>();

    for (const object of scene.objects) {
      const entry = this.#resolveEntry(object, missingAssetIds);
      const mine: DisposableResource[] = [];
      objects.set(
        object.id,
        this.#buildObject(object, entry, geometryCache, materialCache, disposables, mine),
      );
      if (mine.length > 0) owned.set(object.id, mine);
    }

    const batched = this.#chooseBatched(scene);

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

      // Batched objects keep their node — transforms, bounds and selection all still work on it —
      // but it never enters the scene graph, because the instanced mesh is what gets drawn.
      if (batched.has(object.id)) {
        node.updateMatrixWorld(true);
        continue;
      }

      if (parent) {
        parent.add(node);
      } else {
        threeScene.add(node);
        added.push(node);
      }
    }

    const instances = this.#buildInstances(batched, objects, threeScene, added);

    const scatter = this.#buildScatter(scene, terrain, threeScene, added, disposables);

    const wind = this.#applyWind(scene, objects, batched, instances, scatter);

    const loaded = new LoadedScene({
      threeScene,
      objects,
      missingAssetIds,
      disposables,
      owned,
      added,
      instances,
      wind,
      windSettings: scene.environment.wind,
      scatterCount: [...scatter.values()].reduce(
        // One layer makes one batch per mesh in its model, and every batch holds the same instances
        // — so counting batches would multiply a two-part plant by two.
        (total, meshes) => total + (meshes[0]?.count ?? 0),
        0,
      ),
    });
    loaded.registerEnvironment(environmentNodes, environmentDisposables);
    return loaded;
  }

  /**
   * Rebuilds the lights, fog and background of an already-loaded scene.
   *
   * On the loader rather than on `LoadedScene` because the builder is the loader's, and passing it
   * across keeps one implementation of "what an environment is" rather than two that have to agree.
   */
  applyEnvironmentTo(loaded: LoadedScene, environment: Environment): void {
    loaded.syncEnvironment(environment, (threeScene, nextEnvironment, disposables, added) => {
      this.#applyEnvironment(threeScene, nextEnvironment, disposables, added);
    });
  }

  /**
   * Decides which objects are safe to batch, as `objectId -> assetId`.
   *
   * The rules are all about "does anything ever touch this object individually". A behaviour moves
   * it, a trigger listens through it, a dynamic body is moved by the solver, and a parent or child
   * relationship means its transform is not its own — any of those and it stays a real node. What
   * is left is scenery, which is also the overwhelming majority of a scene and the entire reason
   * instancing is worth doing.
   */
  /**
   * Makes vegetation sway, and returns the uniforms that drive it.
   *
   * Returns null when the scene has no wind, and that is the whole cost story: no uniforms are
   * allocated, no material is patched, no shader is recompiled, and the frame loop has nothing to
   * update. A level built before wind existed is bit-identical to what it was.
   *
   * Batches are handled separately from placed objects because they are a different thing to patch
   * — one `InstancedMesh` per asset rather than one node per object — and because a batch's group
   * can only come from the asset, which `#chooseBatched` guarantees by excluding overrides.
   */
  #applyWind(
    scene: Scene,
    objects: Map<string, THREE.Object3D>,
    batched: Map<string, string>,
    instances: InstanceManager | null,
    scatter: Map<string, THREE.InstancedMesh[]>,
  ): WindUniforms | null {
    const wind = scene.environment.wind;
    if (!windIsActive(wind)) return null;

    const uniforms = createWindUniforms(wind);
    let patched = 0;

    for (const object of scene.objects) {
      if (batched.has(object.id)) continue;
      const node = objects.get(object.id);
      if (!node) continue;

      const entry = this.#resolver.get(object.assetId);
      const group = resolveSway(wind, object.sway, object.assetId, entry?.category ?? '');
      if (group) patched += applyWindToObject(node, uniforms, group);
    }

    for (const [assetId, meshes] of instances?.batchMeshes ?? []) {
      const entry = this.#resolver.get(assetId);
      const group = resolveSway(wind, 'auto', assetId, entry?.category ?? '');
      if (!group) continue;
      for (const mesh of meshes) patched += applyWindToObject(mesh, uniforms, group);
    }

    // Scattered vegetation is the case wind exists for. It has no per-object override — a scatter
    // layer is one rule, so the rule's own asset decides — and it is instanced, which is why the
    // shader had to learn about `instanceMatrix` before any of this looked right.
    for (const [assetId, meshes] of scatter) {
      const entry = this.#resolver.get(assetId);
      const group = resolveSway(wind, 'auto', assetId, entry?.category ?? '');
      if (!group) continue;
      for (const mesh of meshes) patched += applyWindToObject(mesh, uniforms, group);
    }

    // Nothing in the scene is vegetation. Reported as no wind rather than as a wind with nothing to
    // blow, so the frame loop does not spend the level updating a uniform no shader reads.
    return patched > 0 ? uniforms : null;
  }

  /**
   * Expands every scatter layer into instanced meshes.
   *
   * Needs the terrain, which is why it runs after it is built rather than alongside the objects:
   * every candidate is tested against the height field, and a scatter layer over a terrain that
   * does not exist yet would grow a flat field on a hilly map.
   *
   * A layer whose asset is missing is skipped with a warning rather than substituted. The
   * missing-asset placeholder is a magenta box, and forty thousand magenta boxes is not a more
   * useful error than none.
   */
  #buildScatter(
    scene: Scene,
    terrain: THREE.Object3D,
    threeScene: THREE.Scene,
    added: THREE.Object3D[],
    disposables: DisposableResource[],
  ): Map<string, THREE.InstancedMesh[]> {
    const byAsset = new Map<string, THREE.InstancedMesh[]>();
    if (scene.scatter.length === 0) return byAsset;

    const field = terrain.userData['terrainField'] as TerrainField | undefined;
    if (!field) return byAsset;

    const root = new THREE.Object3D();
    root.name = 'scatter';
    let total = 0;

    for (const layer of scene.scatter) {
      if (!layer.enabled) continue;

      const entry = this.#resolver.get(layer.assetId);
      if (!entry) {
        this.#warn(`scatter layer "${layer.name}" names unknown asset "${layer.assetId}"; skipped`);
        continue;
      }

      // Straight from the loader's own model cache. A layer whose model has not been fetched yet
      // grows nothing this pass and everything on the next: `preload` bumps the epoch that rebuilds
      // the scene, which is the same path a placed object takes.
      const template = this.#models.get(entry.id);
      if (!template) continue;

      const placements = buildScatter(layer, { terrain: field, size: scene.terrain.size });
      const meshes = buildScatterMeshes(template, placements);
      if (meshes.length === 0) continue;

      for (const mesh of meshes) {
        root.add(mesh);
        // The geometry and materials belong to the cached template; only the batch is ours.
        disposables.push(mesh);
      }
      byAsset.set(layer.assetId, [...(byAsset.get(layer.assetId) ?? []), ...meshes]);
      total += placements.length;
    }

    if (total > 0) {
      threeScene.add(root);
      added.push(root);
    }
    return byAsset;
  }

  #chooseBatched(scene: Scene): Map<string, string> {
    if (this.#instanceThreshold <= 0) return new Map();

    const hasChildren = new Set<string>();
    for (const object of scene.objects) {
      if (object.parentId !== null) hasChildren.add(object.parentId);
    }

    const candidates = new Map<string, string[]>();
    for (const object of scene.objects) {
      const eligible =
        object.parentId === null &&
        !hasChildren.has(object.id) &&
        object.behaviors.length === 0 &&
        object.trigger === null &&
        // An animated object cannot be batched. An `InstancedMesh` draws one geometry many times
        // with per-instance matrices; a skinned mesh's pose lives in bone matrices the batch has no
        // way to vary, so instancing a rigged asset renders every copy in the same pose — and
        // silently, because it still draws. Rigged assets are also the ones there are ten of, not
        // two hundred, so nothing is lost by excluding them.
        object.animation === null &&
        // An `InstancedMesh` draws one geometry with one material, so a batch cannot give two
        // copies different colours. Batching an overridden object would apply whichever override
        // the batch's template happened to carry to all of them — silently, since it still draws.
        object.material === null &&
        // An `InstancedMesh` has one material, so one batch can only sway one way. Objects with an
        // explicit sway override are excluded rather than silently taking the batch's answer —
        // otherwise setting a single hedge to `none` would either do nothing or stop the whole
        // species moving, depending on build order. The default `auto` is the same for every copy
        // of an asset, so nothing that would have batched stops batching.
        object.sway === 'auto' &&
        object.physics.body === 'static';
      if (!eligible) continue;

      const group = candidates.get(object.assetId) ?? [];
      group.push(object.id);
      candidates.set(object.assetId, group);
    }

    const batched = new Map<string, string>();
    for (const [assetId, ids] of candidates) {
      if (ids.length < this.#instanceThreshold) continue;
      for (const id of ids) batched.set(id, assetId);
    }
    return batched;
  }

  #buildInstances(
    batched: Map<string, string>,
    objects: Map<string, THREE.Object3D>,
    threeScene: THREE.Scene,
    added: THREE.Object3D[],
  ): InstanceManager | null {
    if (batched.size === 0) return null;

    const byAsset = new Map<string, Map<string, THREE.Matrix4>>();
    for (const [objectId, assetId] of batched) {
      const node = objects.get(objectId);
      if (!node) continue;
      const group = byAsset.get(assetId) ?? new Map<string, THREE.Matrix4>();
      group.set(objectId, node.matrixWorld.clone());
      byAsset.set(assetId, group);
    }

    // A group of its own, so the batches are added and removed as one and never confused with the
    // objects a caller placed in the scene.
    const root = new THREE.Group();
    root.name = 'instances';
    threeScene.add(root);
    added.push(root);

    const manager = new InstanceManager(root);
    for (const [assetId, matrices] of byAsset) {
      const [firstId] = matrices.keys();
      const template = firstId ? objects.get(firstId) : undefined;
      if (template) manager.addBatch(assetId, template, matrices);
    }
    return manager;
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

  /**
   * Instantiates one object into a scene that is already loaded.
   *
   * Spawning at runtime goes through the same construction path a placed object does, so a
   * trigger-spawned enemy is indistinguishable from one the level designer put there — same
   * transform handling, same placeholder fallback, same disposal.
   */
  instantiateInto(loaded: LoadedScene, object: SceneObject): THREE.Object3D {
    const pooled = this.#pool.get(object.assetId)?.pop();
    if (pooled) {
      // A recycled node is the same shape as a fresh one; only its identity and placement differ.
      pooled.name = object.metadata.label ?? object.id;
      pooled.userData['objectId'] = object.id;
      pooled.visible = true;
      applyTransform(pooled, object);
      loaded.adopt(object.id, pooled);
      return pooled;
    }

    // Both sinks are the same array here, and legitimately so: the caches are created fresh for
    // this one call, so nothing built below is shared with any other object and all of it can be
    // freed the moment this object is deleted.
    const own: DisposableResource[] = [];
    const entry = this.#resolver.get(object.assetId) ?? MISSING_ASSET_ENTRY;
    const node = this.#buildObject(object, entry, new Map(), new Map(), own, own);
    loaded.adopt(object.id, node, own);
    return node;
  }

  /**
   * Takes an object out of the world and keeps its node for the next spawn of the same asset.
   *
   * The cap is what stops a wave-spawner from turning the pool into a leak: past it, the node is
   * dropped — and anything it exclusively owned is freed here, because a dropped node is the one
   * path where nobody else will ever get the chance to.
   */
  recycle(loaded: LoadedScene, objectId: string): void {
    const node = loaded.objects.get(objectId);
    // `keepResources` because a pooled node is going to be spawned again: freeing its geometry
    // here would hand the next spawn a node with nothing left to draw. `release` parks them on the
    // node, and `adopt` picks them back up when it is reused.
    loaded.release(objectId, { keepResources: true });
    if (!node) return;

    const assetId = String(node.userData['assetId'] ?? '');
    const pool = assetId === '' ? null : (this.#pool.get(assetId) ?? []);

    if (!pool || pool.length >= POOL_LIMIT_PER_ASSET) {
      const parked = node.userData['ownedDisposables'] as DisposableResource[] | undefined;
      for (const disposable of parked ?? []) disposable.dispose();
      delete node.userData['ownedDisposables'];
      return;
    }

    node.visible = false;
    pool.push(node);
    this.#pool.set(assetId, pool);
  }

  /** How many nodes are waiting to be reused. For tests and the perf readout. */
  pooledCount(assetId?: string): number {
    if (assetId !== undefined) return this.#pool.get(assetId)?.length ?? 0;
    let total = 0;
    for (const pool of this.#pool.values()) total += pool.length;
    return total;
  }

  /**
   * Builds one object's node.
   *
   * Two sinks rather than one, and which resource goes where is the whole leak story: `disposables`
   * takes the *shared* things — the placeholder geometry and material caches, keyed by asset, used
   * by every object of that asset — and `owned` takes what belongs to this object alone. Only the
   * second can be freed when the object is deleted.
   */
  #buildObject(
    object: SceneObject,
    entry: AssetManifestEntry,
    geometryCache: Map<string, THREE.BufferGeometry>,
    materialCache: Map<string, THREE.Material>,
    disposables: DisposableResource[],
    owned: DisposableResource[],
  ): THREE.Object3D {
    // A trigger is not a thing you look at, so it gets an outline instead of a model.
    const model = object.trigger ? undefined : this.#models.get(entry.id);
    const visual = object.trigger
      ? buildTriggerVisual(object.trigger.shape, owned)
      : model
        ? cloneModel(model, entry.skinned)
        : new THREE.Mesh(
            placeholderGeometry(entry, geometryCache, disposables),
            placeholderMaterial(entry, materialCache, disposables),
          );

    visual.castShadow = !object.trigger;
    visual.receiveShadow = !object.trigger;
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
    // Editor furniture, not scenery: the preview hides these the moment play starts, and an
    // exported project never renders them at all.
    if (object.trigger) node.userData['isTrigger'] = true;
    node.add(visual);

    // Materials are cloned per object, so the ones this creates belong to this object alone and
    // land on its own disposal list — freeing them on delete is what keeps a session that
    // recolours fifty objects from holding fifty materials it can never reach again.
    if (object.material && !object.trigger) {
      node.userData['materialClones'] = applyMaterialOverride(visual, object.material);
    }

    // Built here rather than by the game runtime, because the animator has to be bound to *this*
    // clone's skeleton and this is the only place that clone exists. The runtime finds it through
    // `LoadedScene.animators`.
    if (object.animation && model) {
      const clips = modelClips(model);
      if (clips.length > 0) {
        const animator = new Animator(visual, clips, object.animation);
        node.userData['animator'] = animator;
        owned.push(animator);
        for (const name of animator.missing) {
          this.#warn(
            `object "${object.id}" binds animation clip "${name}", which is not in asset ` +
              `"${entry.id}" (it has: ${clips.map((clip) => clip.name).join(', ') || 'none'})`,
          );
        }
      } else {
        this.#warn(
          `object "${object.id}" is animated but asset "${entry.id}" contains no animation clips`,
        );
      }
    }

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

    const { sun, ambient, ambientColor, hemisphere, shadows } = environment.lighting;
    const ambientLight = new THREE.AmbientLight(new THREE.Color(ambientColor), ambient);
    ambientLight.name = 'ambient';
    threeScene.add(ambientLight);
    added.push(ambientLight);
    disposables.push(ambientLight);

    if (hemisphere) {
      const hemisphereLight = new THREE.HemisphereLight(
        new THREE.Color(hemisphere.skyColor),
        new THREE.Color(hemisphere.groundColor),
        hemisphere.intensity,
      );
      hemisphereLight.name = 'hemisphere';
      threeScene.add(hemisphereLight);
      added.push(hemisphereLight);
      disposables.push(hemisphereLight);
    }

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

    sunLight.castShadow = shadows.quality !== 'off';
    if (sunLight.castShadow) {
      const size = SHADOW_MAP_SIZE[shadows.quality];
      sunLight.shadow.mapSize.set(size, size);
      sunLight.shadow.bias = shadows.bias;
      // The shadow camera is an orthographic box centred on the origin, and `distance` is its
      // width. The whole map is stretched over it, so doubling this halves the resolution
      // everywhere — which is why it is a setting rather than something derived from scene size.
      const half = shadows.distance / 2;
      sunLight.shadow.camera.near = 1;
      sunLight.shadow.camera.far = shadows.distance * 2;
      sunLight.shadow.camera.left = -half;
      sunLight.shadow.camera.right = half;
      sunLight.shadow.camera.top = half;
      sunLight.shadow.camera.bottom = -half;
      sunLight.shadow.camera.updateProjectionMatrix();
    }

    threeScene.add(sunLight);
    threeScene.add(sunLight.target);
    added.push(sunLight, sunLight.target);
    disposables.push(sunLight);
  }
}
