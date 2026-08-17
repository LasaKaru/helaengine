import * as THREE from 'three';
import {
  SURFACE_PRESETS,
  SURFACE_SCALE_REPEAT,
  type SurfaceKind,
  type SurfaceScale,
} from '@helaengine/schema';

/**
 * Generated PBR maps for the surface kinds.
 *
 * A normal map and one packed occlusion/roughness/metalness map per kind, computed from a height
 * field. Two textures rather than four because glTF's own convention packs them that way and Three
 * reads each channel from wherever it is told: occlusion from red, roughness from green, metalness
 * from blue. Binding the same texture three times costs one upload and one sampler fetch, which on
 * a phone is the difference between a surface being free and a surface being noticeable.
 *
 * ## Everything here is a pure function of (kind, scale)
 *
 * No `Math.random`, anywhere. The noise is hashed from the pixel coordinate, so the same kind
 * generates the same bytes on every machine and in every run — which is what lets a test assert
 * something about the *content* of a normal map rather than merely that one exists, and what stops
 * an export differing from the editor preview it was made in.
 *
 * ## The seam
 *
 * The maps repeat across an object, so every pattern has to be tileable: the noise lattice wraps at
 * the texture width, and the brick and tile grids divide it exactly. Getting this wrong does not
 * produce a subtle artefact — it produces a hard grid of visible lines wherever the texture wraps,
 * which is the single most recognisable "programmer made this texture" failure there is.
 */

/** Texture side in pixels. Big enough for the pattern to read, small enough to generate in a frame. */
const SIZE = 256;

/**
 * A hashed value in [0, 1) for a lattice point, wrapping at `period`.
 *
 * The wrap is what makes the noise tileable — without it the left edge and the right edge are
 * unrelated numbers and the repeat shows as a seam.
 */
function latticeValue(ix: number, iy: number, periodX: number, periodY = periodX): number {
  const x = ((ix % periodX) + periodX) % periodX;
  const y = ((iy % periodY) + periodY) % periodY;
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smoothstep, so the interpolated noise has no visible lattice creases. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Tileable value noise. The periods are how many lattice cells span the texture on each axis.
 *
 * Separate periods rather than one, and *not* for expressiveness: stretching noise by scaling the
 * coordinate — `noise(u * 0.02, v, 128)`, the obvious way to write brushed metal — silently breaks
 * the wrap, because the lattice index at u = 1 is then no longer the one at u = 0. The pattern looks
 * right in isolation and grows a hard vertical line the moment it repeats. Anisotropy has to live in
 * the period, where the modulo can still see it.
 */
function noise(u: number, v: number, periodX: number, periodY = periodX): number {
  const x = u * periodX;
  const y = v * periodY;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);

  const a = latticeValue(ix, iy, periodX, periodY);
  const b = latticeValue(ix + 1, iy, periodX, periodY);
  const c = latticeValue(ix, iy + 1, periodX, periodY);
  const d = latticeValue(ix + 1, iy + 1, periodX, periodY);

  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Several octaves of it, for anything meant to look weathered rather than manufactured. */
function fbm(u: number, v: number, period: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    // The period doubles rather than the coordinate scaling, so every octave still wraps.
    sum += noise(u, v, period * 2 ** octave) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  return sum / total;
}

/** A groove mask: 1 well inside a cell, falling to 0 across a joint of width `joint`. */
function inset(distance: number, joint: number): number {
  return Math.min(1, Math.max(0, distance / joint));
}

/** Distance from `value` to the nearest edge of the unit cell it sits in. */
function cellEdgeDistance(value: number, cells: number): number {
  const local = value * cells - Math.floor(value * cells);
  return Math.min(local, 1 - local) / cells;
}

interface Sample {
  /** 0 is the bottom of a joint, 1 the face of a brick. Drives both the normal map and occlusion. */
  height: number;
  /** Absolute roughness for this texel, not a multiplier — mortar is rougher than the brick. */
  roughness: number;
  metalness: number;
}

/**
 * The height, roughness and metalness of one texel of one kind.
 *
 * One function with a switch rather than a class per kind, because every kind is a dozen lines of
 * arithmetic and the interesting thing about them is how they differ — which is legible in one place
 * and invisible across seven files.
 */
function sample(kind: SurfaceKind, u: number, v: number): Sample {
  const preset = SURFACE_PRESETS[kind];

  switch (kind) {
    case 'brick': {
      const rows = 8;
      const perRow = 4;
      const row = Math.floor(v * rows);
      // Running bond: every other course is offset by half a brick. Stacking them square instead is
      // the difference between a wall and a pile of boxes.
      const shifted = u + (row % 2 === 0 ? 0 : 0.5 / perRow);
      const joint = 0.012;
      const face =
        inset(cellEdgeDistance(v, rows), joint) * inset(cellEdgeDistance(shifted, perRow), joint);
      // Per-brick variation, hashed from the brick rather than the texel, so a whole brick sits
      // slightly proud or slightly sunk the way a real course does.
      // Period `perRow`, not a multiple of it: the column the wrap lands on has to hash to the
      // same brick as column zero, or the last course of bricks is a different shade from the first.
      const brick = latticeValue(Math.floor(shifted * perRow), row, perRow, rows);
      const grain = fbm(u, v, 32, 3);
      return {
        height: face * (0.82 + brick * 0.18) + (1 - face) * 0.1 + grain * 0.05,
        roughness: face > 0.5 ? preset.roughness - 0.06 + grain * 0.1 : 1,
        metalness: 0,
      };
    }

    case 'tile': {
      const cells = 4;
      const joint = 0.02;
      const face =
        inset(cellEdgeDistance(u, cells), joint) * inset(cellEdgeDistance(v, cells), joint);
      const speckle = fbm(u, v, 64, 2);
      return {
        height: face * 0.95 + speckle * 0.04,
        // Glazed face, unglazed grout. Roughness is what actually reads as "tile" here — the shine
        // travels across the face and stops dead at the joint.
        roughness: face > 0.5 ? preset.roughness + speckle * 0.08 : 0.95,
        metalness: 0,
      };
    }

    case 'plank': {
      const boards = 6;
      const gap = 0.006;
      const board = Math.floor(v * boards);
      const face = inset(cellEdgeDistance(v, boards), gap);
      // Grain runs along the board: high frequency across it, very low along it.
      const grain = noise(u, v + board * 0.017, 5, 48);
      const knots = fbm(u, v, 12, 2);
      return {
        height: face * (0.8 + grain * 0.2) + (1 - face) * 0.05,
        roughness: preset.roughness + grain * 0.12 - knots * 0.06,
        metalness: 0,
      };
    }

    case 'stone': {
      // Jittered grid: each cell centre is displaced by a hashed amount, and the joint is where two
      // centres are equally close. A plain grid would be tile; the jitter is what makes it masonry.
      const cells = 4;
      let nearest = Infinity;
      let second = Infinity;
      const cx = Math.floor(u * cells);
      const cy = Math.floor(v * cells);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const gx = cx + dx;
          const gy = cy + dy;
          const jx = (gx + latticeValue(gx, gy, cells) * 0.8 + 0.1) / cells;
          const jy = (gy + latticeValue(gy, gx, cells) * 0.8 + 0.1) / cells;
          const distance = Math.hypot(u - jx, v - jy);
          if (distance < nearest) {
            second = nearest;
            nearest = distance;
          } else if (distance < second) {
            second = distance;
          }
        }
      }
      const joint = inset(second - nearest, 0.04);
      const weather = fbm(u, v, 16, 3);
      return {
        height: joint * (0.75 + weather * 0.25),
        roughness: joint > 0.5 ? preset.roughness - weather * 0.1 : 1,
        metalness: 0,
      };
    }

    case 'plaster': {
      const render = fbm(u, v, 24, 4);
      return {
        // Shallow on purpose. Plaster that reads as strongly as brick reads as damage.
        height: 0.6 + render * 0.4,
        roughness: preset.roughness + (render - 0.5) * 0.1,
        metalness: 0,
      };
    }

    case 'concrete': {
      const body = fbm(u, v, 12, 4);
      const pitting = fbm(u + 0.37, v + 0.11, 96, 2);
      // Air pockets: only the deepest part of the fine noise becomes a hole, so the surface is
      // mostly flat with occasional pits rather than uniformly bubbly.
      const pit = pitting < 0.28 ? (0.28 - pitting) * 2.4 : 0;
      return {
        height: 0.7 + body * 0.3 - pit,
        roughness: preset.roughness - body * 0.06,
        metalness: 0,
      };
    }

    case 'metal': {
      // Brushed: the noise is stretched hundreds of times along one axis, so it becomes streaks
      // rather than blotches. The streaks are almost the whole effect — a flat metal is a mirror,
      // and a mirror in a low-poly scene reads as a bug.
      const brush = noise(u, v, 2, 160);
      const dents = fbm(u, v, 8, 2);
      return {
        height: 0.85 + brush * 0.1 + dents * 0.05,
        roughness: preset.roughness + brush * 0.22,
        metalness: preset.metalness,
      };
    }

    default: {
      // The other half of the closed vocabulary. A kind added to the schema without a generator
      // here fails to compile, rather than shipping as a wall with no pattern on it.
      const unreachable: never = kind;
      throw new Error(`unhandled surface kind: ${String(unreachable)}`);
    }
  }
}

/** The maps for one kind, as raw bytes. Generated once per kind and shared by every scale. */
interface SurfaceImages {
  normal: Uint8Array;
  orm: Uint8Array;
}

function generate(kind: SurfaceKind): SurfaceImages {
  const heights = new Float32Array(SIZE * SIZE);
  const orm = new Uint8Array(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = y * SIZE + x;
      // Sampled at the texel centre. Sampling at the corner puts the joint half a texel off and
      // makes the first and last column of a tiled pattern different widths.
      const { height, roughness, metalness } = sample(kind, (x + 0.5) / SIZE, (y + 0.5) / SIZE);
      heights[index] = Math.min(1, Math.max(0, height));
      orm[index * 4 + 1] = Math.round(Math.min(1, Math.max(0, roughness)) * 255);
      orm[index * 4 + 2] = Math.round(Math.min(1, Math.max(0, metalness)) * 255);
      orm[index * 4 + 3] = 255;
    }
  }

  const at = (x: number, y: number): number =>
    heights[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)]!;

  const normal = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = y * SIZE + x;

      // Central differences, wrapped — the wrap is why the normal map tiles as cleanly as the height
      // field it came from. `STRENGTH` converts a height difference per texel into a slope; it is
      // tuned by eye, and the per-object `depth` scales the result at bind time.
      const STRENGTH = 6;
      const dx = (at(x + 1, y) - at(x - 1, y)) * STRENGTH;
      const dy = (at(x, y + 1) - at(x, y - 1)) * STRENGTH;
      const length = Math.hypot(dx, dy, 1);
      normal[index * 4] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      normal[index * 4 + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      normal[index * 4 + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      normal[index * 4 + 3] = 255;

      // Occlusion from a blur of the height field: a texel sitting lower than its neighbourhood is
      // in a crease and gets less ambient light. Cheap, and for grooves — which is all these
      // patterns have — indistinguishable from a real ambient-occlusion bake.
      let neighbourhood = 0;
      for (let oy = -3; oy <= 3; oy += 1) {
        for (let ox = -3; ox <= 3; ox += 1) neighbourhood += at(x + ox, y + oy);
      }
      const relative = at(x, y) - neighbourhood / 49;
      orm[index * 4] = Math.round(Math.min(1, Math.max(0, 0.75 + relative * 1.6)) * 255);
    }
  }

  return { normal, orm };
}

/** The bound pair for one (kind, scale). */
export interface SurfaceMaps {
  readonly normalMap: THREE.Texture;
  /** Occlusion in red, roughness in green, metalness in blue. Bound three times. */
  readonly ormMap: THREE.Texture;
}

function textureFrom(
  data: Uint8Array,
  repeat: number,
  colorSpace: THREE.ColorSpace,
): THREE.Texture {
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The generated maps for a scene, made on demand and freed with it.
 *
 * Owned by the loader rather than kept in a module-level cache, because a module-level one is never
 * freed: the editor rebuilds a scene constantly, and textures that outlive every object that
 * referenced them are a leak that only shows up as a browser tab getting slower over an afternoon.
 *
 * Sharing within a scene is the whole point — fifty brick walls at the same scale are one pair of
 * textures — and it is safe because nothing ever writes to a generated map. The cache is bounded by
 * construction at kinds times scales, which is why `scale` is a word rather than a number.
 */
export class SurfaceTextures {
  readonly #images = new Map<SurfaceKind, SurfaceImages>();
  readonly #maps = new Map<string, SurfaceMaps>();

  get(kind: SurfaceKind, scale: SurfaceScale): SurfaceMaps {
    const key = `${kind}:${scale}`;
    const existing = this.#maps.get(key);
    if (existing) return existing;

    let images = this.#images.get(kind);
    if (!images) {
      images = generate(kind);
      this.#images.set(kind, images);
    }

    const repeat = SURFACE_SCALE_REPEAT[scale];
    const maps: SurfaceMaps = {
      // Normals and packed data are *not* colour: sampling them through sRGB decoding bends every
      // value on the curve, and the symptom is lighting that is subtly wrong everywhere rather than
      // anything that looks broken.
      normalMap: textureFrom(images.normal, repeat, THREE.NoColorSpace),
      ormMap: textureFrom(images.orm, repeat, THREE.NoColorSpace),
    };
    this.#maps.set(key, maps);
    return maps;
  }

  dispose(): void {
    for (const maps of this.#maps.values()) {
      maps.normalMap.dispose();
      maps.ormMap.dispose();
    }
    this.#maps.clear();
    this.#images.clear();
  }
}
