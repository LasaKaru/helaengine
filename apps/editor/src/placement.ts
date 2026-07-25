import type { Vec3 } from '@helaengine/schema';

export interface PlacementOptions {
  /** Round position to the nearest multiple of `gridSize`. */
  snapToGrid: boolean;
  gridSize: number;
  /** Give the object a random spin about Y — the difference between a forest and a row of trees. */
  randomRotation: boolean;
  /**
   * Tilt the object to match the surface it landed on. Off by default: upright props read better
   * on gentle slopes, and tilted buildings almost never look intentional.
   */
  alignToNormal: boolean;
  /** Injectable so tests are deterministic. */
  random?: () => number;
}

export const DEFAULT_PLACEMENT: PlacementOptions = {
  snapToGrid: false,
  gridSize: 1,
  randomRotation: false,
  alignToNormal: false,
};

export interface PlacementResult {
  position: Vec3;
  /** Euler XYZ in degrees, matching the scene schema. */
  rotation: Vec3;
}

const RAD2DEG = 180 / Math.PI;

function snap(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

/** Trims float noise so saved documents stay readable and diffable. */
function tidy(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Turns a surface hit into the transform a newly placed object should get.
 *
 * Kept free of Three.js and React so the rules — snapping, jitter, surface alignment — can be
 * tested directly rather than through a rendered viewport.
 */
export function computePlacement(
  point: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
  options: PlacementOptions = DEFAULT_PLACEMENT,
): PlacementResult {
  const random = options.random ?? Math.random;
  const gridSize = options.gridSize > 0 ? options.gridSize : 1;

  // Y is deliberately never snapped: it comes from the ground the object was dropped on, and
  // rounding it would float props above the terrain or bury them in it.
  const position: Vec3 = options.snapToGrid
    ? [tidy(snap(point.x, gridSize)), tidy(point.y), tidy(snap(point.z, gridSize))]
    : [tidy(point.x), tidy(point.y), tidy(point.z)];

  const yaw = options.randomRotation ? random() * 360 : 0;

  if (!options.alignToNormal) {
    return { position, rotation: [0, tidy(yaw), 0] };
  }

  // Tilt away from vertical, in the direction the slope faces.
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const nx = normal.x / length;
  const ny = normal.y / length;
  const nz = normal.z / length;
  const tilt = Math.acos(Math.min(1, Math.max(-1, ny))) * RAD2DEG;
  const slopeDirection = Math.atan2(nx, nz) * RAD2DEG;

  return {
    position,
    rotation: [
      tidy(tilt * Math.cos((slopeDirection * Math.PI) / 180)),
      tidy(yaw),
      tidy(-tilt * Math.sin((slopeDirection * Math.PI) / 180)),
    ],
  };
}
