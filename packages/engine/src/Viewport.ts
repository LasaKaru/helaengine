import * as THREE from 'three';
import type { Scene } from '@helaengine/schema';
import { OrbitCamera } from './OrbitCamera.js';
import { type LoadedScene, type SceneLoader } from './SceneLoader.js';

export interface ViewportOptions {
  container: HTMLElement;
  loader: SceneLoader;
  /** Cap the device pixel ratio — 2 is plenty and keeps fill rate sane on retina displays. */
  maxPixelRatio?: number;
  antialias?: boolean;
}

export type FrameCallback = (deltaSeconds: number, elapsedSeconds: number) => void;

/**
 * Owns the renderer, camera and render loop for one canvas.
 *
 * This is the piece the editor's viewport and an exported project's `main.js` both mount — the
 * only difference between them is who calls `setScene`.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitCamera;

  readonly #container: HTMLElement;
  readonly #loader: SceneLoader;
  readonly #clock = new THREE.Clock();
  readonly #frameCallbacks = new Set<FrameCallback>();
  readonly #resizeObserver: ResizeObserver;

  #loaded: LoadedScene | null = null;
  #animationFrame: number | null = null;
  #disposed = false;

  constructor(options: ViewportOptions) {
    this.#container = options.container;
    this.#loader = options.loader;

    this.renderer = new THREE.WebGLRenderer({ antialias: options.antialias ?? true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.#container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    this.controls = new OrbitCamera(this.camera, this.renderer.domElement);

    this.#resizeObserver = new ResizeObserver(() => this.resize());
    this.#resizeObserver.observe(this.#container);
    this.resize();
  }

  /** Loads a scene document, disposing whatever was displayed before it. */
  setScene(scene: Scene): LoadedScene {
    this.#loaded?.dispose();
    const loaded = this.#loader.load(scene);
    this.#loaded = loaded;
    return loaded;
  }

  get loadedScene(): LoadedScene | null {
    return this.#loaded;
  }

  /** Points the camera at the objects in the current scene. */
  frameScene(): void {
    if (!this.#loaded) return;
    this.controls.frame(this.#loaded.getContentBounds());
  }

  onFrame(callback: FrameCallback): () => void {
    this.#frameCallbacks.add(callback);
    return () => this.#frameCallbacks.delete(callback);
  }

  resize(): void {
    const width = this.#container.clientWidth || 1;
    const height = this.#container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
  }

  start(): void {
    if (this.#animationFrame !== null || this.#disposed) return;
    this.#clock.start();
    const tick = (): void => {
      this.#animationFrame = requestAnimationFrame(tick);
      const delta = this.#clock.getDelta();
      const elapsed = this.#clock.elapsedTime;
      for (const callback of this.#frameCallbacks) callback(delta, elapsed);
      // Animations advance here rather than inside the game runtime, and the placement is the
      // whole design rather than convenience.
      //
      // *After* the callbacks, because a callback is where the game runtime lives: an animator
      // plays the state it was last told about, so ticking it first would show every character one
      // frame behind its own behaviour.
      //
      // *Here* rather than in the runtime, because this is the only loop all three cases share. A
      // static export has no game runtime at all, and neither does the editor's viewport — so a
      // torch or a windmill would stand still while you built the level around it, and stand still
      // in the export as well. Ticking in both places instead would run every clip at double
      // speed in a game export, which is the kind of bug that gets blamed on the model.
      this.#loaded?.updateAnimations(delta);
      if (this.#loaded) this.renderer.render(this.#loaded.threeScene, this.camera);
    };
    this.#animationFrame = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.#animationFrame !== null) {
      cancelAnimationFrame(this.#animationFrame);
      this.#animationFrame = null;
    }
    this.#clock.stop();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    this.#frameCallbacks.clear();
    this.#resizeObserver.disconnect();
    this.controls.dispose();
    this.#loaded?.dispose();
    this.#loaded = null;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
