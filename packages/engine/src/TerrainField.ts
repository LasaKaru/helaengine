import * as THREE from 'three';
import { base64ToBytes, bytesToBase64 } from './base64.js';

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten';

/** How many blend layers the splat map carries. Four is the industry-standard RGBA packing. */
export const LAYER_COUNT = 4;

export interface TerrainFieldOptions {
  /** Grid subdivisions per axis. Vertex count per axis is this plus one. */
  segments: number;
  /** World size in metres, [x, z]. */
  size: [number, number];
  /** World height corresponding to a normalised height of 1. */
  maxHeight: number;
}

export interface BrushOptions {
  /** Brush radius in metres. */
  radius: number;
  /** 0..1. Scaled by delta time by the caller, so strokes feel the same at any frame rate. */
  strength: number;
  /** Falloff exponent: 1 is linear, higher concentrates the effect at the centre. */
  falloff?: number;
}

/**
 * The terrain's editable data: a normalised height per vertex, plus per-vertex blend weights for
 * the four material layers.
 *
 * Deliberately plain arrays and plain maths, with no Three.js in the brush code — sculpting is
 * something the AI layout pass (see AI-PROTOTYPE-PLAN.md) and any future procedural generator will
 * want as much as the editor does, and none of them should have to own a renderer to use it.
 */
export class TerrainField {
  readonly segments: number;
  readonly width: number;
  readonly size: [number, number];
  maxHeight: number;

  /** Normalised heights in 0..1, row-major, `width * width` entries. */
  readonly heights: Float32Array;
  /** Layer weights 0..255, `width * width * LAYER_COUNT` entries, summing to 255 per vertex. */
  readonly weights: Uint8Array;

  constructor(options: TerrainFieldOptions) {
    this.segments = Math.max(1, Math.floor(options.segments));
    this.width = this.segments + 1;
    this.size = options.size;
    this.maxHeight = options.maxHeight;

    this.heights = new Float32Array(this.width * this.width);
    this.weights = new Uint8Array(this.width * this.width * LAYER_COUNT);
    // Everything starts as pure layer 0 — the base ground colour.
    for (let index = 0; index < this.width * this.width; index += 1) {
      this.weights[index * LAYER_COUNT] = 255;
    }
  }

  /** Converts a world X/Z to fractional grid coordinates. */
  worldToGrid(x: number, z: number): { gx: number; gz: number } {
    const [sizeX, sizeZ] = this.size;
    return {
      gx: ((x + sizeX / 2) / sizeX) * this.segments,
      gz: ((z + sizeZ / 2) / sizeZ) * this.segments,
    };
  }

  gridToWorld(gx: number, gz: number): { x: number; z: number } {
    const [sizeX, sizeZ] = this.size;
    return {
      x: (gx / this.segments) * sizeX - sizeX / 2,
      z: (gz / this.segments) * sizeZ - sizeZ / 2,
    };
  }

  /** World height at a world X/Z, bilinearly interpolated. Out-of-bounds clamps to the edge. */
  sampleHeight(x: number, z: number): number {
    const { gx, gz } = this.worldToGrid(x, z);
    const x0 = Math.max(0, Math.min(this.segments, Math.floor(gx)));
    const z0 = Math.max(0, Math.min(this.segments, Math.floor(gz)));
    const x1 = Math.min(this.segments, x0 + 1);
    const z1 = Math.min(this.segments, z0 + 1);
    const fx = Math.max(0, Math.min(1, gx - x0));
    const fz = Math.max(0, Math.min(1, gz - z0));

    const h00 = this.heights[z0 * this.width + x0]!;
    const h10 = this.heights[z0 * this.width + x1]!;
    const h01 = this.heights[z1 * this.width + x0]!;
    const h11 = this.heights[z1 * this.width + x1]!;

    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return (top + (bottom - top) * fz) * this.maxHeight;
  }

  /**
   * Visits every vertex inside a world-space brush, with its falloff weight.
   * Returns false when the brush touched nothing, so callers can skip an upload.
   */
  #forEachInBrush(
    x: number,
    z: number,
    radius: number,
    falloff: number,
    visit: (index: number, weight: number) => void,
  ): boolean {
    const [sizeX, sizeZ] = this.size;
    const metresPerCellX = sizeX / this.segments;
    const metresPerCellZ = sizeZ / this.segments;
    const { gx, gz } = this.worldToGrid(x, z);

    const spanX = Math.ceil(radius / metresPerCellX);
    const spanZ = Math.ceil(radius / metresPerCellZ);
    const minX = Math.max(0, Math.floor(gx) - spanX);
    const maxX = Math.min(this.segments, Math.ceil(gx) + spanX);
    const minZ = Math.max(0, Math.floor(gz) - spanZ);
    const maxZ = Math.min(this.segments, Math.ceil(gz) + spanZ);

    let touched = false;
    for (let cz = minZ; cz <= maxZ; cz += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        const dx = (cx - gx) * metresPerCellX;
        const dz = (cz - gz) * metresPerCellZ;
        const distance = Math.hypot(dx, dz);
        if (distance > radius) continue;

        const weight = Math.pow(1 - distance / radius, falloff);
        visit(cz * this.width + cx, weight);
        touched = true;
      }
    }
    return touched;
  }

  /** Applies a sculpt brush. `strength` is in normalised height units for raise/lower. */
  sculpt(x: number, z: number, mode: SculptMode, options: BrushOptions): boolean {
    const falloff = options.falloff ?? 2;

    if (mode === 'raise' || mode === 'lower') {
      const sign = mode === 'raise' ? 1 : -1;
      return this.#forEachInBrush(x, z, options.radius, falloff, (index, weight) => {
        this.heights[index] = clamp01(this.heights[index]! + sign * options.strength * weight);
      });
    }

    if (mode === 'flatten') {
      // Flatten pulls towards the height under the brush centre, which is what makes it useful for
      // levelling a building site rather than just averaging everything towards nothing.
      const target = this.sampleHeight(x, z) / this.maxHeight;
      return this.#forEachInBrush(x, z, options.radius, falloff, (index, weight) => {
        const blend = Math.min(1, options.strength * weight * 4);
        this.heights[index] = clamp01(
          this.heights[index]! + (target - this.heights[index]!) * blend,
        );
      });
    }

    // Smooth reads from a snapshot so that already-smoothed neighbours do not feed back into the
    // rest of the stroke and drag the whole brush towards one corner.
    const snapshot = this.heights.slice();
    return this.#forEachInBrush(x, z, options.radius, falloff, (index, weight) => {
      const cx = index % this.width;
      const cz = Math.floor(index / this.width);

      let total = 0;
      let count = 0;
      for (let oz = -1; oz <= 1; oz += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = cx + ox;
          const nz = cz + oz;
          if (nx < 0 || nz < 0 || nx >= this.width || nz >= this.width) continue;
          total += snapshot[nz * this.width + nx]!;
          count += 1;
        }
      }

      const average = total / count;
      const blend = Math.min(1, options.strength * weight * 4);
      this.heights[index] = clamp01(
        this.heights[index]! + (average - this.heights[index]!) * blend,
      );
    });
  }

  /** Paints layer weights, renormalising so each vertex's weights still sum to 255. */
  paint(x: number, z: number, layer: number, options: BrushOptions): boolean {
    const target = Math.max(0, Math.min(LAYER_COUNT - 1, Math.floor(layer)));
    const falloff = options.falloff ?? 2;

    return this.#forEachInBrush(x, z, options.radius, falloff, (index, weight) => {
      const base = index * LAYER_COUNT;
      const blend = Math.min(1, options.strength * weight * 4);

      for (let channel = 0; channel < LAYER_COUNT; channel += 1) {
        const goal = channel === target ? 255 : 0;
        const current = this.weights[base + channel]!;
        this.weights[base + channel] = Math.round(current + (goal - current) * blend);
      }

      // Rounding can leave the four channels off by a unit or two; fix the largest one so the
      // total stays exactly 255 and the blend never dims or blows out.
      let sum = 0;
      let largest = 0;
      for (let channel = 0; channel < LAYER_COUNT; channel += 1) {
        sum += this.weights[base + channel]!;
        if (this.weights[base + channel]! > this.weights[base + largest]!) largest = channel;
      }
      this.weights[base + largest] = Math.max(
        0,
        Math.min(255, this.weights[base + largest]! + (255 - sum)),
      );
    });
  }

  /** True when the terrain is still perfectly flat — used to skip persisting an empty heightmap. */
  isFlat(): boolean {
    return this.heights.every((height) => height === 0);
  }

  encodeHeights(): string {
    // 16 bits per vertex: at a 40m maxHeight that is sub-millimetre precision, and half the size
    // of the float32 it is stored as in memory.
    const quantised = new Uint16Array(this.heights.length);
    for (let index = 0; index < this.heights.length; index += 1) {
      quantised[index] = Math.round(clamp01(this.heights[index]!) * 65535);
    }
    return bytesToBase64(new Uint8Array(quantised.buffer));
  }

  encodeWeights(): string {
    return bytesToBase64(this.weights);
  }

  decodeHeights(encoded: string): void {
    const bytes = base64ToBytes(encoded);
    const quantised = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const count = Math.min(quantised.length, this.heights.length);
    for (let index = 0; index < count; index += 1) {
      this.heights[index] = quantised[index]! / 65535;
    }
  }

  decodeWeights(encoded: string): void {
    const bytes = base64ToBytes(encoded);
    this.weights.set(bytes.subarray(0, this.weights.length));
  }

  /** Builds the terrain geometry, with per-vertex colours blended from the layer palette. */
  buildGeometry(layerColors: string[]): THREE.BufferGeometry {
    const geometry = new THREE.PlaneGeometry(
      this.size[0],
      this.size[1],
      this.segments,
      this.segments,
    );
    geometry.rotateX(-Math.PI / 2);
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(this.width * this.width * 3), 3),
    );
    this.updateGeometry(geometry, layerColors);
    return geometry;
  }

  /**
   * Re-applies heights and colours to an existing geometry.
   *
   * Updating in place rather than rebuilding is what keeps a sculpt stroke smooth: the geometry
   * the raycaster and the renderer hold onto stays the same object, so neither has to be rewired
   * sixty times a second.
   */
  updateGeometry(geometry: THREE.BufferGeometry, layerColors: string[]): void {
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;

    const palette = layerColors.map((hex) => new THREE.Color(hex));
    const blended = new THREE.Color();

    for (let index = 0; index < this.heights.length; index += 1) {
      position.setY(index, this.heights[index]! * this.maxHeight);

      if (!color) continue;
      const base = index * LAYER_COUNT;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let channel = 0; channel < LAYER_COUNT; channel += 1) {
        const weight = this.weights[base + channel]! / 255;
        if (weight === 0) continue;
        const layer = palette[channel] ?? palette[0]!;
        r += layer.r * weight;
        g += layer.g * weight;
        b += layer.b * weight;
      }
      blended.setRGB(r, g, b);
      color.setXYZ(index, blended.r, blended.g, blended.b);
    }

    position.needsUpdate = true;
    if (color) color.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
