import * as THREE from 'three';
import {
  WEATHER_PRESETS,
  weatherCount,
  weatherIsActive,
  type Weather,
  type Wind,
} from '@helaengine/schema';

/**
 * Weather, as a volume of particles that follows the camera.
 *
 * Rain does not come from anywhere. It is everywhere the player looks, for as long as they look, and
 * the naive implementation — spawn drops above the camera, retire them when they land — spends all
 * its time on bookkeeping for particles that are individually meaningless.
 *
 * So nothing is ever spawned or retired. A fixed box of particles is built once, centred on the
 * camera, and each one's position is a *function of time*: it falls, and when it reaches the bottom
 * of the box it wraps to the top. That wrap is a modulo in the vertex shader, which means the whole
 * system is one draw call, one uniform update per frame, and no per-particle CPU work at all.
 *
 * The box moving with the camera is what makes a finite number of drops look infinite. The player
 * carries their own weather around and cannot reach its edge.
 */

/**
 * The vertex shader.
 *
 * Each particle carries a seed rather than a position: the seed picks where in the box it sits and
 * how fast it falls, so the same buffer produces a field that does not visibly repeat. Positions are
 * derived, never stored, which is the whole reason this costs nothing to animate.
 */
const VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uRadius;
uniform float uFallSpeed;
uniform float uDrift;
uniform float uSize;
uniform vec3 uCamera;
uniform vec2 uWind;

attribute vec3 aSeed;

varying float vFade;

void main() {
  float span = uRadius * 2.0;

  // Wrapped around the camera in x and z, so turning never reveals an edge: a particle that would be
  // behind the player is the same particle, one box-width along.
  vec3 base = aSeed * span;
  float x = mod(base.x + uCamera.x + uRadius, span) - uRadius;
  float z = mod(base.z + uCamera.z + uRadius, span) - uRadius;

  // Falling is the modulo. Faster particles wrap sooner, which is what stops the field looking like
  // a single sheet descending — and the per-particle speed comes from the seed, so it costs nothing.
  float speed = uFallSpeed * (0.75 + aSeed.y * 0.5);
  float fallen = mod(base.y - uTime * speed, span);
  float y = fallen - uRadius;

  // Sideways wander. Snow and dust want this to be most of their motion; rain barely uses it.
  float phase = uTime * 0.7 + aSeed.x * 31.4 + aSeed.z * 17.3;
  vec2 wander = vec2(sin(phase), cos(phase * 0.83)) * uDrift;

  // Wind blows the whole field over. Applied as an offset that grows with how far the particle has
  // fallen, so drops lean rather than simply being somewhere else — a uniform shift would move the
  // rain without tilting it, and the eye reads the tilt rather than the position.
  vec2 blown = uWind * (span - fallen) * 0.06;

  vec3 world = vec3(x + wander.x + blown.x, y + uCamera.y, z + wander.y + blown.y);

  // Faded out at the top and bottom of the box, so particles appear and vanish rather than popping
  // in and out at the wrap. Without it the wrap is the most visible thing in the effect.
  float edge = abs(fallen / span - 0.5) * 2.0;
  vFade = 1.0 - smoothstep(0.75, 1.0, edge);

  vec4 view = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * view;
  // Divided by distance so a particle keeps a constant world size rather than a constant pixel size.
  gl_PointSize = uSize * 300.0 / max(-view.z, 0.1);
}
`;

/**
 * The fragment shader.
 *
 * A soft round dot rather than a texture. A texture would be one more file to ship and fetch, and at
 * the sizes weather particles are drawn at — a few pixels — the difference is invisible.
 */
const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uStretch;

varying float vFade;

void main() {
  vec2 offset = gl_PointCoord - vec2(0.5);
  // Stretched vertically for rain, which is what makes a drop read as falling fast rather than as a
  // dot that happens to be moving. Anything else leaves it round.
  offset.y /= uStretch;

  float distance = length(offset) * 2.0;
  if (distance > 1.0) discard;

  float alpha = (1.0 - distance * distance) * uOpacity * vFade;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

export interface WeatherUniforms {
  uTime: { value: number };
  uRadius: { value: number };
  uFallSpeed: { value: number };
  uDrift: { value: number };
  uSize: { value: number };
  uCamera: { value: THREE.Vector3 };
  uWind: { value: THREE.Vector2 };
  uColor: { value: THREE.Color };
  uOpacity: { value: number };
  uStretch: { value: number };
}

/** Weather built for one scene, or null when the scene has none. */
export class WeatherField {
  readonly points: THREE.Points;
  readonly #uniforms: WeatherUniforms;
  readonly #settings: Weather;
  #elapsed = 0;

  constructor(settings: Weather) {
    this.#settings = settings;
    const preset = WEATHER_PRESETS[settings.kind === 'none' ? 'rain' : settings.kind];
    const count = weatherCount(settings);

    // Three seeds per particle rather than a position. `aSeed` is 0..1 in each axis and the shader
    // scales it, so the same buffer works at any radius — changing the radius is a uniform, not a
    // rebuild.
    const seeds = new Float32Array(count * 3);
    for (let index = 0; index < seeds.length; index += 1) seeds[index] = Math.random();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    // Positions are computed in the shader, so the attribute exists only to give Three.js a count.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    // The bounding sphere would otherwise be computed from those zeroed positions and cull the whole
    // field the moment the camera looks away from the origin.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.#uniforms = {
      uTime: { value: 0 },
      uRadius: { value: settings.radius },
      uFallSpeed: { value: preset.fallSpeed },
      uDrift: { value: preset.drift },
      uSize: { value: preset.size },
      uCamera: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Color(settings.color ?? preset.color) },
      uOpacity: { value: preset.opacity },
      uStretch: { value: preset.stretch },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.#uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      // Depth writing off: thousands of overlapping transparent dots that wrote depth would occlude
      // each other in whatever order they happened to be drawn, and the field would flicker.
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.name = 'weather';
  }

  get particleCount(): number {
    return weatherCount(this.#settings);
  }

  /** For tests: the shader the field was actually built with. */
  get vertexShader(): string {
    return VERTEX_SHADER;
  }

  /** The sideways push currently being applied, in metres per second. Zero when the wind is off. */
  get windPush(): THREE.Vector2 {
    return this.#uniforms.uWind.value;
  }

  /**
   * Advances the field and moves it with the camera.
   *
   * `wind` is the level's wind, already resolved to a direction and strength. Passing it here rather
   * than reading it means weather and vegetation lean the same way without either knowing about the
   * other — and rain falling straight down past a canopy that is visibly leaning is the sort of
   * detail that reads as wrong without anybody being able to say why.
   */
  update(delta: number, camera: THREE.Camera, wind: Wind): void {
    this.#elapsed += delta;
    this.#uniforms.uTime.value = this.#elapsed;
    camera.getWorldPosition(this.#uniforms.uCamera.value);

    if (this.#settings.followWind && wind.strength > 0) {
      const radians = (wind.direction * Math.PI) / 180;
      this.#uniforms.uWind.value
        .set(Math.sin(radians), Math.cos(radians))
        .multiplyScalar(wind.strength);
    } else {
      this.#uniforms.uWind.value.set(0, 0);
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Builds weather for a scene, or null when it has none. */
export function createWeather(settings: Weather): WeatherField | null {
  return weatherIsActive(settings) ? new WeatherField(settings) : null;
}

export { VERTEX_SHADER as WEATHER_VERTEX_SHADER, FRAGMENT_SHADER as WEATHER_FRAGMENT_SHADER };
