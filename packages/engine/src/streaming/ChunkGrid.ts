import * as THREE from 'three';

/**
 * A uniform grid over the level's ground plane, and the objects that fall in each cell.
 *
 * The partition, kept separate from what uses it. `SceneLoader` asks it which chunks are within a
 * distance of the camera; nothing here knows what a chunk is *for*, which is what makes it testable
 * against arithmetic rather than against pixels.
 *
 * ## The membership rule
 *
 * An object belongs to the chunk containing its **origin**, not to every chunk its bounds overlap.
 * Multi-chunk membership is the correct answer for a query like "what does this ray hit" and the
 * wrong one here: an object in two chunks is drawn when either is in range, so the cheap test
 * ("is this chunk's centre within the distance") stops being conservative and starts being
 * arbitrary. Instead the distance test is widened by each chunk's own half-diagonal plus the
 * largest object radius in it, which keeps membership simple and the culling conservative — an
 * object is never culled while any part of it is inside the distance.
 */
export class ChunkGrid {
  readonly #size: number;
  readonly #objects = new Map<string, string[]>();
  readonly #centres = new Map<string, THREE.Vector3>();
  /** The largest object radius in each chunk, so the distance test can be widened by it. */
  readonly #reach = new Map<string, number>();

  constructor(size: number) {
    // A zero or negative size divides by zero and puts every object in one chunk named NaN. Guarded
    // here rather than trusted to the schema, because the engine is also driven by exported
    // documents and by tests.
    this.#size = Math.max(1, size);
  }

  static keyFor(size: number, x: number, z: number): string {
    const cell = Math.max(1, size);
    return `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  }

  /** Files an object under the chunk containing `position`, and widens that chunk's reach. */
  add(objectId: string, position: THREE.Vector3, radius: number): void {
    const key = ChunkGrid.keyFor(this.#size, position.x, position.z);
    const existing = this.#objects.get(key);
    if (existing) existing.push(objectId);
    else this.#objects.set(key, [objectId]);

    if (!this.#centres.has(key)) {
      const [column, row] = key.split(',').map(Number) as [number, number];
      this.#centres.set(
        key,
        new THREE.Vector3((column + 0.5) * this.#size, 0, (row + 0.5) * this.#size),
      );
    }
    this.#reach.set(key, Math.max(this.#reach.get(key) ?? 0, radius));
  }

  get chunkCount(): number {
    return this.#objects.size;
  }

  get objectCount(): number {
    let total = 0;
    for (const ids of this.#objects.values()) total += ids.length;
    return total;
  }

  /** Every chunk that exists, as its key. */
  keys(): IterableIterator<string> {
    return this.#objects.keys();
  }

  objectsIn(key: string): readonly string[] {
    return this.#objects.get(key) ?? [];
  }

  /**
   * Whether a chunk is within `distance` of a point, measured horizontally.
   *
   * Horizontally because the grid is horizontal: including the camera's height would cull the
   * ground beneath a camera looking straight down at it, which is the top-down view this engine
   * ships as a camera mode.
   *
   * Widened by the chunk's half-diagonal and by the largest object in it, so nothing is culled while
   * any part of it is still inside the distance. Over-drawing a chunk at the boundary is invisible;
   * under-drawing one is a building that vanishes as you walk towards it.
   */
  isWithin(key: string, point: THREE.Vector3, distance: number): boolean {
    const centre = this.#centres.get(key);
    if (!centre) return false;
    const margin = (this.#size * Math.SQRT2) / 2 + (this.#reach.get(key) ?? 0);
    const dx = centre.x - point.x;
    const dz = centre.z - point.z;
    return Math.hypot(dx, dz) <= distance + margin;
  }
}
