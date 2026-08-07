import * as THREE from 'three';
import { SWAY_AMPLITUDE, windVector, type SwayGroup, type Wind } from '@helaengine/schema';

/**
 * Vegetation that moves in the wind.
 *
 * A vertex program patched into the material the model already shipped with, rather than a
 * replacement material. Replacing it would throw away the textures, the vertex colours and the
 * transparency settings the artist chose, and would mean maintaining a second lighting model that
 * has to keep matching `MeshStandardMaterial` forever.
 *
 * ## The two things that make it look right rather than wrong
 *
 * **The pivot is the base of the model, not its centre.** Sway weighted by raw `position.y` bends a
 * tree around its middle, so the trunk swings underground and the roots leave the soil. Weighting
 * by height *above the model's lowest vertex* keeps whatever is standing on the ground standing on
 * it. This is the single mistake that makes wind look like a bug.
 *
 * **Phase comes from where the object is standing.** Every plant driven by one clock moves in
 * lockstep, which reads as a rippling sheet rather than as weather. Offsetting the phase by the
 * vertex's world position gives a wave that travels across a field for free, and costs one dot
 * product.
 *
 * ## What it deliberately does not do
 *
 * No per-leaf flutter, no bending in response to the player walking through it. Both need either
 * per-vertex authored data the shipped models do not carry, or a second pass over the scene each
 * frame. The lean is what reads at distance, and it is what one uniform can buy.
 */

/** Uniforms shared by every swaying material, so one write per frame drives the whole world. */
export interface WindUniforms {
  /** x, z direction; length is the strength in metres. */
  helaWind: { value: THREE.Vector2 };
  /** Seconds, scaled by `speed` — advanced by the host, so pausing the game pauses the wind. */
  helaWindTime: { value: number };
  helaWindGust: { value: number };
}

export function createWindUniforms(wind: Wind): WindUniforms {
  const [x, z] = windVector(wind);
  return {
    helaWind: { value: new THREE.Vector2(x * wind.strength, z * wind.strength) },
    helaWindTime: { value: 0 },
    helaWindGust: { value: wind.gustiness },
  };
}

export function updateWindUniforms(uniforms: WindUniforms, wind: Wind): void {
  const [x, z] = windVector(wind);
  uniforms.helaWind.value.set(x * wind.strength, z * wind.strength);
  uniforms.helaWindGust.value = wind.gustiness;
}

/** Marks a material as already patched, so adopting a scene twice does not stack two programs. */
const PATCHED = Symbol.for('helaengine.windPatched');

interface Patchable extends THREE.Material {
  [PATCHED]?: SwayGroup;
}

const VERTEX_HEAD = /* glsl */ `
uniform vec2 helaWind;
uniform float helaWindTime;
uniform float helaWindGust;
uniform float helaSwayAmplitude;
uniform float helaModelBase;
`;

/**
 * The sway itself.
 *
 * Applied to `transformed`, which is three.js's name for the vertex after skinning and morphing —
 * so a swaying model that is also animated gets both, in the right order.
 */
const VERTEX_BODY = /* glsl */ `
{
  /**
   * The model's full transform, instancing included.
   *
   * instanceMatrix matters twice over. Without it every blade in a batch shares one world
   * position, so a scattered field sways as a single rigid sheet — the exact artefact the phase
   * offset exists to avoid, and one that only shows up once grass is instanced. three.js applies
   * instancing inside project_vertex, which is after this, so it has to be done by hand here.
   */
  mat4 helaModel = modelMatrix;
  #ifdef USE_INSTANCING
    helaModel = modelMatrix * instanceMatrix;
  #endif

  // Height above the model's own lowest point, so the base stays planted whatever the mesh's
  // origin happens to be. Clamped because a stray vertex below the base would bend backwards.
  float helaHeight = max(transformed.y - helaModelBase, 0.0);

  // Metres of lean at two metres up, falling to nothing at the ground. Curved rather than linear —
  // a linear falloff tilts the whole plant like a signpost instead of bending it.
  float helaLean = helaSwayAmplitude * pow(helaHeight * 0.5, 1.6);

  // Phase from world position: one clock for the level, but a wave that travels across it.
  vec3 helaWorld = (helaModel * vec4(transformed, 1.0)).xyz;
  float helaPhase = helaWindTime + dot(helaWorld.xz, vec2(0.35, 0.28));

  // Two waves at an irrational ratio, so the motion never visibly repeats. The gust rides a slower
  // wave, which is what stops an even sway reading as an electric fan.
  float helaWave = sin(helaPhase) * 0.7 + sin(helaPhase * 1.618 + 1.3) * 0.3;
  float helaGust = 1.0 + helaWindGust * sin(helaPhase * 0.21);

  /**
   * The wind is a world direction, but transformed is in model space.
   *
   * Adding the offset directly makes every rotated object lean the wrong way — and scattered grass
   * is randomly rotated by design, so the error is not an edge case, it is the common case: half a
   * field would bend into the wind. The inverse is a 3×3 per vertex on geometry that is a handful
   * of triangles, which is the cheaper end of the trade against a visibly wrong world.
   */
  vec3 helaOffset = inverse(mat3(helaModel)) * vec3(helaWind.x, 0.0, helaWind.y);

  transformed += helaOffset * helaLean * helaWave * helaGust;
}
`;

/**
 * Patches one material to sway, in place.
 *
 * `onBeforeCompile` rather than a custom shader for the reason at the top of the file; the
 * `customProgramCacheKey` is not optional decoration — without it three.js reuses the compiled
 * program of an identical-looking unpatched material, and half the scene silently does not move.
 */
export function applyWindToMaterial(
  material: THREE.Material,
  uniforms: WindUniforms,
  group: SwayGroup,
  modelBase: number,
): void {
  const patchable = material as Patchable;
  if (patchable[PATCHED] === group) return;
  patchable[PATCHED] = group;

  const amplitude = { value: SWAY_AMPLITUDE[group] };
  const base = { value: modelBase };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.helaWind = uniforms.helaWind;
    shader.uniforms.helaWindTime = uniforms.helaWindTime;
    shader.uniforms.helaWindGust = uniforms.helaWindGust;
    shader.uniforms.helaSwayAmplitude = amplitude;
    shader.uniforms.helaModelBase = base;

    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      `${VERTEX_HEAD}\nvoid main() {`,
    );

    // After `project_vertex`'s input is built but before it is used: `begin_vertex` declares
    // `transformed`, and skinning and morphing have already run by the chunk we anchor to.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `${VERTEX_BODY}\n#include <project_vertex>`,
    );
  };

  material.customProgramCacheKey = () => `helaWind:${group}:${modelBase.toFixed(3)}`;
  material.needsUpdate = true;
}

/**
 * The lowest point of a model in its own space.
 *
 * Computed from the geometry rather than assumed to be zero, because the shipped models do not
 * agree: some sit on y=0, some are centred on their bounding box. Getting this wrong is what makes
 * a tree swing through the ground.
 */
export function modelBaseY(object: THREE.Object3D): number {
  let lowest = Infinity;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (box) lowest = Math.min(lowest, box.min.y);
  });
  return Number.isFinite(lowest) ? lowest : 0;
}

/** Applies the sway to every material under an object. Returns how many materials were patched. */
export function applyWindToObject(
  object: THREE.Object3D,
  uniforms: WindUniforms,
  group: SwayGroup,
): number {
  const base = modelBaseY(object);
  let patched = 0;

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = materials.map((material) => {
      if (!material) return material;

      /**
       * Two objects of the same asset can want different sway.
       *
       * Materials are shared per asset — that is what makes one compiled program serve a forest —
       * so patching in place would mean the last object placed decides how every other one moves.
       * A hedge set to `none` would stop the whole species swaying. Cloning only when the groups
       * actually disagree keeps the shared case shared, which is the case that matters for cost.
       */
      const current = (material as Patchable)[PATCHED];
      if (current !== undefined && current !== group) {
        const copy = material.clone() as Patchable;
        delete copy[PATCHED];
        applyWindToMaterial(copy, uniforms, group, base);
        patched += 1;
        return copy;
      }

      applyWindToMaterial(material, uniforms, group, base);
      patched += 1;
      return material;
    });

    if (next.some((material, index) => material !== materials[index])) {
      mesh.material = Array.isArray(mesh.material) ? (next as THREE.Material[]) : next[0]!;
    }
  });

  return patched;
}
