import * as THREE from 'three';
import { waterColor, type Water } from '@helaengine/schema';

/**
 * The water surface: one plane, shaded by how deep the ground is beneath it.
 *
 * ## Depth is sampled once, into the geometry
 *
 * The shader needs to know, per pixel, how far the ground is below the surface — that is what makes
 * shallows pale, deep water opaque, and the shoreline fade instead of cutting a line. The obvious
 * way is a depth texture and a second render pass. The cheap way, available here and not in a
 * general engine, is that the terrain's heightfield is already in memory: depth at a vertex is a
 * subtraction, baked into an attribute when the plane is built and interpolated across the
 * triangle for free.
 *
 * So there is no render target, no second pass and nothing for a browser renderer to be careful
 * about. The cost is that the depth is as coarse as the plane's own tessellation, which is why the
 * plane is subdivided rather than being two triangles.
 *
 * ## The waves are vertex motion plus a normal, not a texture
 *
 * Two crossed sine waves displace the surface and give it a normal to catch the light. That is a
 * poor ocean and a perfectly good pond, which is the honest order of priorities for a low-poly
 * engine — and it costs no texture fetch, no download, and nothing to keep in step across an
 * export.
 *
 * ## What this is not
 *
 * There is no reflection. A planar reflection is a second render of the whole scene, and adding one
 * before there is a measurement saying the frame can afford it would be exactly the mistake this
 * codebase keeps writing down. The surface takes a fresnel-weighted tint of the sky colour instead,
 * which reads as reflectivity at a glancing angle and costs three lines.
 */

/** How many segments across the plane. Depth is interpolated between vertices, so this is the resolution of the shoreline. */
const SEGMENTS = 96;

/**
 * A number, or the default where one did not arrive.
 *
 * The schema guarantees every field is present and finite, and this is not a second opinion about
 * that — it is insurance against the one failure mode this surface has. A single non-finite uniform
 * makes `sin(x / NaN)` NaN, every vertex of the plane NaN, and the whole surface disappear with no
 * error logged anywhere: no shader warning, no exception, no console output at all. It cost most of
 * an afternoon to find, working backwards from a plane that was in the scene, visible, correctly
 * positioned, with the right attributes and a compiled material, and drew nothing.
 *
 * The value that did it arrived from a partial environment patch that never went through the
 * schema. Anything that can produce silence rather than a message deserves a floor.
 */
function number(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export interface WaterSurface {
  mesh: THREE.Mesh;
  /** Advances the waves. Called once a frame with the elapsed time. */
  update(elapsedSeconds: number): void;
  dispose(): void;
}

/**
 * Builds the surface for one level.
 *
 * `groundAt` is the terrain height at a world point — the loader passes the heightfield's own
 * sampler, so the shoreline is derived from the same data the collider uses and cannot disagree
 * with it.
 */
export function buildWater(
  water: Water,
  size: readonly [number, number],
  groundAt: (x: number, z: number) => number,
  skyColor: string,
): WaterSurface {
  const geometry = new THREE.PlaneGeometry(size[0], size[1], SEGMENTS, SEGMENTS);
  // Flat, not upright: `PlaneGeometry` is built in the XY plane and water lies in XZ.
  geometry.rotateX(-Math.PI / 2);

  /**
   * Depth per vertex, baked once.
   *
   * Negative where the ground is above the surface, and that sign is load-bearing: the shader fades
   * the surface out over the last few centimetres of positive depth, so a bank rising through the
   * water gets a soft edge rather than the plane simply ending. Clamping this to zero would make
   * every point on land identical to the waterline and the shore hard again.
   */
  const position = geometry.getAttribute('position');
  const depth = new Float32Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    depth[vertex] = water.height - groundAt(position.getX(vertex), position.getZ(vertex));
  }
  geometry.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(waterColor(water)) },
    uSky: { value: new THREE.Color(skyColor) },
    uClarity: { value: number(water.clarity, 3.5) },
    uWaveHeight: { value: number(water.waveHeight, 0.06) },
    // Floored, because the wave length is a divisor: at zero every vertex is `sin(x / 0)`, which is
    // `sin(inf)`, which is NaN — and a NaN position is not a wrong wave, it is a plane that vanishes.
    uWaveScale: { value: Math.max(0.2, number(water.waveScale, 4)) },
    uWaveSpeed: { value: number(water.waveSpeed, 0.7) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    // A surface you can see through has to be sorted, but it must not carve a hole in the depth
    // buffer for everything drawn after it — without this the terrain under the water disappears.
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uWaveHeight;
      uniform float uWaveScale;
      uniform float uWaveSpeed;
      attribute float aDepth;

      varying float vDepth;
      varying vec3 vNormal;
      varying vec3 vToCamera;

      /** Two crossed waves. Crossed rather than one, because a single sine is a corrugated roof. */
      float waveAt(vec2 at) {
        float first = sin(at.x / uWaveScale + uTime * uWaveSpeed);
        float second = sin(at.y / (uWaveScale * 0.7) + uTime * uWaveSpeed * 1.3);
        return (first + second) * 0.5;
      }

      void main() {
        vDepth = aDepth;

        vec3 shifted = position;
        // Waves are damped as the water gets shallow, so a ripple does not stand proud of the bank
        // it is lapping against.
        float shallow = clamp(aDepth * 2.0, 0.0, 1.0);
        shifted.y += waveAt(position.xz) * uWaveHeight * shallow;

        // The normal from the wave's own slope, by sampling it either side. Cheaper than deriving
        // it analytically and impossible to get out of step with the displacement above.
        float step = 0.5;
        float dx = waveAt(position.xz + vec2(step, 0.0)) - waveAt(position.xz - vec2(step, 0.0));
        float dz = waveAt(position.xz + vec2(0.0, step)) - waveAt(position.xz - vec2(0.0, step));
        vNormal = normalize(vec3(-dx * uWaveHeight, 1.0, -dz * uWaveHeight));

        vec4 world = modelMatrix * vec4(shifted, 1.0);
        vToCamera = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uSky;
      uniform float uClarity;

      varying float vDepth;
      varying vec3 vNormal;
      varying vec3 vToCamera;

      void main() {
        // Dry land: the ground here is above the surface, so there is no water to draw. Discarded
        // rather than drawn transparent, so it cannot tint what is behind it.
        if (vDepth <= 0.0) discard;

        // How much water is between the eye and the bottom. Shallow water shows what is under it;
        // past the clarity distance it is the water's own colour and nothing else.
        float thickness = clamp(vDepth / uClarity, 0.0, 1.0);

        /**
         * Fresnel: a surface seen edge-on reflects the sky, and seen from above shows its depth.
         * This is the whole of the "reflection" here, and it is deliberate — a planar reflection is
         * a second render of the scene, and nothing has measured that the frame can afford one.
         */
        float facing = clamp(dot(normalize(vNormal), normalize(vToCamera)), 0.0, 1.0);
        float glancing = pow(1.0 - facing, 3.0);

        vec3 body = mix(uColor * 1.35, uColor, thickness);
        vec3 color = mix(body, uSky, glancing * 0.6);

        // Fades out over the last of the shallows rather than ending at a hard line, which is what
        // makes a shore read as a shore rather than as a plane laid over a hill.
        float edge = clamp(vDepth * 4.0, 0.0, 1.0);
        gl_FragColor = vec4(color, mix(0.0, mix(0.55, 0.92, thickness), edge));
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = water.height;
  mesh.name = 'water';
  // A flat plane at a known height has no business being culled by its own bounds, and a wave
  // displacing a vertex upwards puts it outside a sphere computed before the displacement.
  mesh.frustumCulled = false;
  // Water receives light but casting a shadow from a transparent plane darkens the bed beneath it.
  mesh.receiveShadow = false;
  mesh.castShadow = false;

  return {
    mesh,
    update(elapsedSeconds: number): void {
      uniforms.uTime.value = elapsedSeconds;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
