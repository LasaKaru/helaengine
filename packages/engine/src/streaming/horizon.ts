import type * as THREE from 'three';
import type { TerrainField } from '../TerrainField.js';

/**
 * Occlusion culling against the terrain.
 *
 * ## Why terrain and not everything
 *
 * The general problem — is this object hidden behind *any* other object — needs either hardware
 * occlusion queries or a software depth rasteriser. WebGL2 has the queries and Three does not expose
 * them; a depth rasteriser is a second renderer, written by hand, that has to agree with the first
 * one about every transform in the scene or it hides something that was visible.
 *
 * But an outdoor level does not have a general occlusion problem. It has one enormous occluder — the
 * ground it is standing on — and a hill either interrupts the line of sight to a chunk or it does
 * not. That is a dozen height samples along a segment, per chunk, against a heightfield the engine
 * already has in memory for its collider. It is the ninety per cent of the benefit for one per cent
 * of the machinery.
 *
 * The honest limit is the other side of the same coin: a level built from walls and rooms gets
 * nothing at all from this, and a flat level gets nothing either. The panel says so rather than
 * leaving an author to conclude the feature is broken.
 *
 * ## Why it is conservative by construction
 *
 * Culling something that is actually visible is not a performance win with a small artefact — it is
 * a building that is not there. So every choice below rounds towards drawing:
 *
 * - the sight line is aimed at the **nearest** point of the chunk, not its centre;
 * - it is aimed at the **top** of the tallest thing in the chunk, not at the ground;
 * - the samples skip the ends of the segment, so the ground under the camera and the ground the
 *   chunk stands on cannot occlude it;
 * - the terrain has to clear the line by a margin before it counts as blocking.
 */

/** How many points along the sight line are sampled. */
const SAMPLES = 12;

/**
 * How far above the line of sight the terrain must rise before the chunk is called hidden.
 *
 * Without it, ground that is merely *level* with the line — a chunk on a flat plain, seen from
 * standing height — reads as an occluder because the interpolated heightfield wobbles by a
 * centimetre either side. Half a metre is below anything an author would notice and well above the
 * noise.
 */
const CLEARANCE = 0.5;

/**
 * Whether the terrain hides everything in a chunk from a viewer at `eye`.
 *
 * `target` is the point being tested for — the nearest point of the chunk, raised to the top of the
 * tallest thing standing in it.
 */
export function terrainHides(
  terrain: TerrainField,
  eye: THREE.Vector3,
  target: THREE.Vector3,
): boolean {
  // Nothing between the two points to sample: a chunk the camera is standing in cannot be hidden by
  // the ground it is standing on, and the arithmetic below would be dividing a segment of length
  // zero into twelve.
  const span = Math.hypot(target.x - eye.x, target.z - eye.z);
  if (span < 1) return false;

  /**
   * The ends are skipped, and both for the same reason in mirror image.
   *
   * At the camera end, the ground directly beneath a standing viewer is close to eye height on the
   * line and would occlude everything. At the chunk end, the hill the chunk is *standing on* is by
   * definition at the line's height there, so sampling it would hide every chunk on a slope from
   * itself.
   */
  for (let step = 1; step < SAMPLES; step += 1) {
    const along = step / SAMPLES;
    const x = eye.x + (target.x - eye.x) * along;
    const z = eye.z + (target.z - eye.z) * along;
    const lineY = eye.y + (target.y - eye.y) * along;
    if (terrain.sampleHeight(x, z) > lineY + CLEARANCE) return true;
  }
  return false;
}

/**
 * How much height the terrain actually has, in metres between its lowest and highest point.
 *
 * Reported so the editor can say when the occlusion test has nothing to work with. A flat field
 * runs the whole test, finds nothing, and costs a dozen samples per chunk to say so — and "I
 * switched it on and nothing happened" is otherwise indistinguishable from a broken feature.
 *
 * Sampled on a coarse lattice rather than over every vertex: this is asked once per load, the
 * answer only has to be right to a metre, and a 512-segment heightfield is a quarter of a million
 * values to walk for a number that decides whether to show a sentence.
 */
export function terrainRelief(terrain: TerrainField): number {
  const [sizeX, sizeZ] = terrain.size;
  let lowest = Infinity;
  let highest = -Infinity;
  const steps = 24;
  for (let row = 0; row <= steps; row += 1) {
    for (let column = 0; column <= steps; column += 1) {
      const height = terrain.sampleHeight(
        (column / steps - 0.5) * sizeX,
        (row / steps - 0.5) * sizeZ,
      );
      lowest = Math.min(lowest, height);
      highest = Math.max(highest, height);
    }
  }
  return Number.isFinite(highest - lowest) ? highest - lowest : 0;
}
