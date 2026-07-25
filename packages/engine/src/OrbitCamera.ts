import * as THREE from 'three';

export interface OrbitCameraOptions {
  target?: THREE.Vector3;
  distance?: number;
  /** Polar angle from the +Y axis, radians. */
  polar?: number;
  /** Azimuthal angle around +Y, radians. */
  azimuth?: number;
  minDistance?: number;
  maxDistance?: number;
}

const MIN_POLAR = 0.05;
const MAX_POLAR = Math.PI / 2 - 0.02;

/**
 * A deliberately small orbit controller.
 *
 * Three's own `OrbitControls` lives in `three/examples/jsm`, which is fine for an app but drags
 * example-tree code into every exported bundle. Exports need to stay small and dependency-light,
 * so the runtime carries its own ~100-line version instead.
 */
export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly target: THREE.Vector3;

  #distance: number;
  #polar: number;
  #azimuth: number;
  readonly #minDistance: number;
  readonly #maxDistance: number;

  readonly #element: HTMLElement;
  #dragging = false;
  #lastX = 0;
  #lastY = 0;
  #disposed = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    element: HTMLElement,
    options: OrbitCameraOptions = {},
  ) {
    this.camera = camera;
    this.#element = element;
    this.target = options.target?.clone() ?? new THREE.Vector3(0, 0, 0);
    this.#distance = options.distance ?? 30;
    this.#polar = options.polar ?? Math.PI / 3.2;
    this.#azimuth = options.azimuth ?? Math.PI / 4;
    this.#minDistance = options.minDistance ?? 2;
    this.#maxDistance = options.maxDistance ?? 500;

    element.addEventListener('pointerdown', this.#onPointerDown);
    element.addEventListener('pointermove', this.#onPointerMove);
    element.addEventListener('pointerup', this.#onPointerUp);
    element.addEventListener('pointercancel', this.#onPointerUp);
    element.addEventListener('wheel', this.#onWheel, { passive: false });
    element.addEventListener('contextmenu', this.#onContextMenu);

    this.update();
  }

  #onPointerDown = (event: PointerEvent): void => {
    this.#dragging = true;
    this.#lastX = event.clientX;
    this.#lastY = event.clientY;
    this.#element.setPointerCapture(event.pointerId);
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (!this.#dragging) return;
    const dx = event.clientX - this.#lastX;
    const dy = event.clientY - this.#lastY;
    this.#lastX = event.clientX;
    this.#lastY = event.clientY;

    this.#azimuth -= dx * 0.005;
    this.#polar = THREE.MathUtils.clamp(this.#polar - dy * 0.005, MIN_POLAR, MAX_POLAR);
    this.update();
  };

  #onPointerUp = (event: PointerEvent): void => {
    this.#dragging = false;
    if (this.#element.hasPointerCapture(event.pointerId)) {
      this.#element.releasePointerCapture(event.pointerId);
    }
  };

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.001);
    this.#distance = THREE.MathUtils.clamp(
      this.#distance * factor,
      this.#minDistance,
      this.#maxDistance,
    );
    this.update();
  };

  #onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  /** Frames the camera on a bounding box, e.g. after loading a scene. */
  frame(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    box.getCenter(this.target);
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    this.#distance = THREE.MathUtils.clamp(
      (radius / Math.sin(fov / 2)) * 1.1,
      this.#minDistance,
      this.#maxDistance,
    );
    this.update();
  }

  update(): void {
    const sinPolar = Math.sin(this.#polar);
    this.camera.position.set(
      this.target.x + this.#distance * sinPolar * Math.sin(this.#azimuth),
      this.target.y + this.#distance * Math.cos(this.#polar),
      this.target.z + this.#distance * sinPolar * Math.cos(this.#azimuth),
    );
    this.camera.lookAt(this.target);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#element.removeEventListener('pointerdown', this.#onPointerDown);
    this.#element.removeEventListener('pointermove', this.#onPointerMove);
    this.#element.removeEventListener('pointerup', this.#onPointerUp);
    this.#element.removeEventListener('pointercancel', this.#onPointerUp);
    this.#element.removeEventListener('wheel', this.#onWheel);
    this.#element.removeEventListener('contextmenu', this.#onContextMenu);
  }
}
