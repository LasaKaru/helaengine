import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/**
 * Supplies the model for an asset. Kept as an interface so the loader never knows whether a model
 * came from a GLB over the network, a preloaded bundle, or a test double.
 */
export interface ModelSource {
  load(assetId: string, glbPath: string): Promise<THREE.Object3D>;
  dispose(): void;
}

export interface GltfModelSourceOptions {
  /** Base URL that `glbPath` values in the manifest resolve against, e.g. `./assets/`. */
  baseUrl: string;
  /** Location of the Draco decoder files. Defaults to `draco/` under `baseUrl`. */
  dracoDecoderPath?: string;
  /** Location of the Basis/KTX2 transcoder files. Only needed for KTX2-textured assets. */
  ktx2TranscoderPath?: string;
  /**
   * Renderer used to detect which compressed texture formats the GPU supports. Required only if
   * assets use KTX2 textures; without it, KTX2 support stays off.
   */
  renderer?: THREE.WebGLRenderer;
}

function joinUrl(base: string, relative: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(relative) || relative.startsWith('/')) return relative;
  return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}

/**
 * Loads Draco-compressed GLBs produced by the ingest pipeline.
 *
 * Models are cached and de-duplicated by `assetId`: a scene with 200 identical trees performs one
 * fetch and one decode, then clones. Concurrent requests for the same asset share a promise rather
 * than racing.
 */
export class GltfModelSource implements ModelSource {
  readonly #gltfLoader: GLTFLoader;
  readonly #dracoLoader: DRACOLoader;
  readonly #ktx2Loader: KTX2Loader | null;
  readonly #baseUrl: string;
  readonly #cache = new Map<string, Promise<THREE.Object3D>>();
  readonly #loaded = new Set<THREE.Object3D>();

  constructor(options: GltfModelSourceOptions) {
    this.#baseUrl = options.baseUrl;

    this.#dracoLoader = new DRACOLoader();
    this.#dracoLoader.setDecoderPath(
      options.dracoDecoderPath ?? joinUrl(options.baseUrl, 'draco/'),
    );

    this.#gltfLoader = new GLTFLoader();
    this.#gltfLoader.setDRACOLoader(this.#dracoLoader);

    // KTX2 needs the renderer to know which GPU texture formats are available. No renderer means
    // no KTX2 support — fine today, since the ingest pipeline only compresses geometry.
    if (options.ktx2TranscoderPath && options.renderer) {
      this.#ktx2Loader = new KTX2Loader()
        .setTranscoderPath(options.ktx2TranscoderPath)
        .detectSupport(options.renderer);
      this.#gltfLoader.setKTX2Loader(this.#ktx2Loader);
    } else {
      this.#ktx2Loader = null;
    }
  }

  load(assetId: string, glbPath: string): Promise<THREE.Object3D> {
    const cached = this.#cache.get(assetId);
    if (cached) return cached;

    const pending = this.#gltfLoader.loadAsync(joinUrl(this.#baseUrl, glbPath)).then((gltf) => {
      const model = gltf.scene;
      model.name = assetId;
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      // The clips live on the `GLTF` result, not on the scene, so anything that only kept
      // `gltf.scene` — as this did until rigged models arrived — silently threw every animation
      // away at load. Parked on the shared model so each placement can read them without a second
      // fetch: clips are immutable and safe to share, unlike the skeleton they drive.
      setModelClips(model, gltf.animations ?? []);
      this.#loaded.add(model);
      return model;
    });

    // A failed load must not poison the cache — the next attempt should be able to retry.
    pending.catch(() => this.#cache.delete(assetId));

    this.#cache.set(assetId, pending);
    return pending;
  }

  dispose(): void {
    for (const model of this.#loaded) disposeObjectTree(model);
    this.#loaded.clear();
    this.#cache.clear();
    this.#dracoLoader.dispose();
    this.#ktx2Loader?.dispose();
  }
}

/**
 * Where a loaded model's animation clips are kept.
 *
 * `userData` rather than a side map, so the clips travel with the model through every code path
 * that already passes an `Object3D` around — including a `ModelSource` implemented by a test.
 */
const CLIPS_KEY = 'helaengineClips';

export function setModelClips(model: THREE.Object3D, clips: THREE.AnimationClip[]): void {
  model.userData[CLIPS_KEY] = clips;
}

/** The clips a model carries, or an empty array. Never null, so callers need no guard. */
export function modelClips(model: THREE.Object3D): readonly THREE.AnimationClip[] {
  const clips = model.userData[CLIPS_KEY] as THREE.AnimationClip[] | undefined;
  return clips ?? [];
}

/** Releases every geometry and material under an object. */
export function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.dispose();
    }
  });
}
