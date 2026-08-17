import * as THREE from 'three';

/**
 * Mesh decimation by vertex clustering.
 *
 * ## Why this and not a library
 *
 * The usual answer is meshoptimizer, and it produces better meshes than this does. It is also
 * another WebAssembly module in every exported game, and the gap between the two matters least
 * exactly where a simplified mesh is used — forty metres away and thirty pixels tall. Clustering is
 * eighty lines of arithmetic with no dependency, no download and no decode.
 *
 * ## How it works
 *
 * The mesh's bounding box is divided into a grid, every vertex is replaced by the average of the
 * vertices sharing its cell, and any triangle whose corners end up in fewer than three distinct
 * cells is dropped because it has collapsed to a line. Coarser grid, fewer triangles.
 *
 * What it is bad at is preserving a silhouette: a cylinder decimated hard becomes a lumpy prism,
 * because nothing here knows that the outline matters more than the interior. Quadric error metrics
 * are the fix and are a different project. At the distances this is used, the silhouette is a few
 * pixels wide and the difference does not survive to the screen — which is the whole argument for
 * level of detail in the first place.
 *
 * ## What it refuses
 *
 * A skinned mesh. Clustering merges vertices that may belong to different bones, and averaging bone
 * weights across a joint produces a character whose elbow tears when it bends. Rigged models are
 * also the ones there are ten of rather than five hundred, so nothing much is lost by leaving them
 * at full detail — and a torn elbow at forty metres is far more noticeable than the triangles saved.
 */

/** Attributes carried through the decimation, averaged over each cell. */
const CARRIED = ['normal', 'uv', 'uv1'] as const;

/** Whether decimation is safe for this geometry at all. */
export function canSimplify(geometry: THREE.BufferGeometry): boolean {
  if (geometry.getAttribute('skinIndex')) return false;
  const position = geometry.getAttribute('position');
  return position !== undefined && position.count >= 12;
}

/**
 * A coarser copy of a geometry, or null when there is nothing worth doing.
 *
 * `ratio` is the share of vertices aimed for, not promised: clustering hits a grid resolution rather
 * than a triangle count, and the result is whatever that grid produces. Null when the geometry
 * cannot be decimated, or when the result came out no smaller — a "simplified" mesh with the same
 * triangle count as its original is pure cost, one more buffer on the GPU drawing the same picture.
 */
export function simplifyGeometry(
  geometry: THREE.BufferGeometry,
  ratio: number,
): THREE.BufferGeometry | null {
  if (!canSimplify(geometry)) return null;

  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triangleCount = Math.floor((index ? index.count : position.count) / 3);
  if (triangleCount < 8) return null;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return null;

  const span = new THREE.Vector3().subVectors(box.max, box.min);
  const longest = Math.max(span.x, span.y, span.z);
  if (longest <= 0) return null;

  /**
   * The grid resolution, found by measuring rather than by estimating.
   *
   * The obvious closed form — resolution is the square root of the target vertex count, because a
   * surface mesh is a shell and occupies about the square of the grid — is wrong by a factor that
   * depends on the shape. A sphere of unit radius occupies roughly three times its grid's square;
   * a flat wall occupies about exactly it. Written as a formula, "decimate to 15%" gave 54% on a
   * sphere and would have given something else again on a tree.
   *
   * So the resolution is searched for instead: counting the occupied cells at a resolution is one
   * pass over the vertices with no triangle work, and seven of those cost less than the clustering
   * they size. Binary search for the finest grid that still lands at or under the target.
   */
  const target = Math.max(8, Math.floor(position.count * ratio));

  const cellsAt = (resolution: number): number => {
    const size = longest / resolution;
    const countX = Math.max(1, Math.ceil(span.x / size));
    const countY = Math.max(1, Math.ceil(span.y / size));
    const occupied = new Set<number>();
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const x = Math.floor((position.getX(vertex) - box.min.x) / size);
      const y = Math.floor((position.getY(vertex) - box.min.y) / size);
      const z = Math.floor((position.getZ(vertex) - box.min.z) / size);
      occupied.add((z * countY + y) * countX + x);
    }
    return occupied.size;
  };

  let low = 2;
  let high = 96;
  let resolution = low;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (cellsAt(middle) <= target) {
      resolution = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const cell = longest / resolution;

  // Per axis, so a long low wall is not collapsed along its length to match its thickness. A single
  // count for every axis flattens exactly the shapes this engine is full of.
  const cellsX = Math.max(1, Math.ceil(span.x / cell));
  const cellsY = Math.max(1, Math.ceil(span.y / cell));

  const cellOf = (vertex: number): number => {
    const x = Math.floor((position.getX(vertex) - box.min.x) / cell);
    const y = Math.floor((position.getY(vertex) - box.min.y) / cell);
    const z = Math.floor((position.getZ(vertex) - box.min.z) / cell);
    return (z * cellsY + y) * cellsX + x;
  };

  const carried: Array<{ name: string; source: THREE.BufferAttribute }> = [];
  for (const name of CARRIED) {
    const source = geometry.getAttribute(name);
    // An interleaved attribute has no flat `array` of its own to read component-wise, and models
    // out of this pipeline never have one. Skipped rather than mishandled: a coarse mesh missing
    // its UVs is a wrong texture at distance, which is far better than reading another attribute's
    // bytes as if they were coordinates.
    if (source instanceof THREE.BufferAttribute) carried.push({ name, source });
  }

  // Cell id to output vertex index, plus running sums so each output vertex is the centroid of what
  // collapsed into it. A representative vertex — the first one seen — would be cheaper and would
  // make the mesh visibly jitter towards whichever corner of the cell happened to come first.
  const slotOf = new Map<number, number>();
  const sums: number[][] = [];
  const counts: number[] = [];
  const width = 3 + carried.reduce((total, entry) => total + entry.source.itemSize, 0);

  const slotFor = (vertex: number): number => {
    const key = cellOf(vertex);
    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = sums.length;
      slotOf.set(key, slot);
      sums.push(new Array<number>(width).fill(0));
      counts.push(0);
    }

    const into = sums[slot]!;
    into[0] = into[0]! + position.getX(vertex);
    into[1] = into[1]! + position.getY(vertex);
    into[2] = into[2]! + position.getZ(vertex);
    let at = 3;
    for (const entry of carried) {
      for (let component = 0; component < entry.source.itemSize; component += 1) {
        into[at] =
          into[at]! + (entry.source.array[vertex * entry.source.itemSize + component] ?? 0);
        at += 1;
      }
    }
    counts[slot] = counts[slot]! + 1;
    return slot;
  };

  const indices: number[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = index ? index.getX(triangle * 3) : triangle * 3;
    const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;

    const slotA = slotFor(a);
    const slotB = slotFor(b);
    const slotC = slotFor(c);
    // Two corners in one cell means the triangle has collapsed to a line. Keeping it would draw a
    // degenerate primitive: invisible, and still rasterised and shaded.
    if (slotA === slotB || slotB === slotC || slotA === slotC) continue;
    indices.push(slotA, slotB, slotC);
  }

  if (indices.length === 0) return null;
  // No smaller is not a level of detail, it is a second copy of the mesh. Compared on triangles
  // rather than vertices because triangles are what the saving is measured in.
  if (indices.length / 3 >= triangleCount * 0.95) return null;

  const simplified = new THREE.BufferGeometry();
  const positions = new Float32Array(sums.length * 3);
  for (const [slot, sum] of sums.entries()) {
    const total = counts[slot] ?? 1;
    positions[slot * 3] = sum[0]! / total;
    positions[slot * 3 + 1] = sum[1]! / total;
    positions[slot * 3 + 2] = sum[2]! / total;
  }
  simplified.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  let offset = 3;
  for (const entry of carried) {
    const size = entry.source.itemSize;
    const values = new Float32Array(sums.length * size);
    for (const [slot, sum] of sums.entries()) {
      const total = counts[slot] ?? 1;
      for (let component = 0; component < size; component += 1) {
        values[slot * size + component] = sum[offset + component]! / total;
      }
    }
    simplified.setAttribute(entry.name, new THREE.BufferAttribute(values, size));
    offset += size;
  }

  simplified.setIndex(indices);

  // Averaged normals do not stay unit length, and a shader that trusts them shades the coarse mesh
  // darker than the fine one — a level-of-detail swap that changes the brightness of the object,
  // which reads as a bug rather than as a saving.
  const normal = simplified.getAttribute('normal');
  if (normal) {
    const vector = new THREE.Vector3();
    for (let slot = 0; slot < normal.count; slot += 1) {
      vector.fromBufferAttribute(normal as THREE.BufferAttribute, slot);
      if (vector.lengthSq() < 1e-8) continue;
      vector.normalize();
      (normal as THREE.BufferAttribute).setXYZ(slot, vector.x, vector.y, vector.z);
    }
  } else {
    simplified.computeVertexNormals();
  }

  return simplified;
}

/** Triangles a geometry draws. Used by the tests and by the editor's statistics. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  return Math.floor((index ? index.count : (position?.count ?? 0)) / 3);
}
