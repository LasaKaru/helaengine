import * as THREE from 'three';
import {
  EMITTER_PRESETS,
  emitterCapacity,
  type Emitter,
  type EmitterPreset,
} from '@helaengine/schema';

/**
 * Particles that come from somewhere: smoke off a chimney, sparks off a wire, dust where something
 * landed.
 *
 * Simulated on the CPU, unlike weather — and the difference is not arbitrary. Weather is a function
 * of time with no births or deaths, which is exactly what a vertex shader is good at. An emitter is
 * all births and deaths: a burst arrives, particles age out at different times, the pool has to be
 * reused. That bookkeeping is what a GPU is bad at without a compute shader, and this engine renders
 * on WebGL2.
 *
 * The pool is fixed at build time. Growing a `BufferAttribute` means reallocating a GPU buffer
 * mid-frame, so a full pool drops the newest particle instead — a puff that is briefly thinner than
 * it should be, rather than a hitch.
 */

/** One particle's state. Stored as parallel arrays rather than objects: this is the hot loop. */
interface Pool {
  /** Seconds of life left. Zero means the slot is free. */
  life: Float32Array;
  /** Total life it was born with, for working out how far through it is. */
  span: Float32Array;
  velocity: Float32Array;
  size: Float32Array;
}

const spawnPoint = new THREE.Vector3();

const VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aAge;

varying float vAge;

void main() {
  vAge = aAge;
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * view;
  // Constant world size rather than constant pixel size, so a particle does not swell as you back
  // away from it.
  gl_PointSize = aSize * 300.0 / max(-view.z, 0.1);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uFadeColor;

varying float vAge;

void main() {
  vec2 offset = gl_PointCoord - vec2(0.5);
  float distance = length(offset) * 2.0;
  if (distance > 1.0) discard;

  // Colour shifts across the particle's life: fire from yellow to red, smoke from grey to darker.
  // A single colour is the difference between "fire" and "orange dots".
  vec3 tint = mix(uColor, uFadeColor, vAge);

  // Faded in quickly and out slowly. Popping into existence at full opacity is the single most
  // visible artefact in a particle system, and it costs one smoothstep to avoid.
  float fadeIn = smoothstep(0.0, 0.12, vAge);
  float fadeOut = 1.0 - smoothstep(0.55, 1.0, vAge);
  float alpha = (1.0 - distance * distance) * fadeIn * fadeOut;
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(tint, alpha);
}
`;

/**
 * A live emitter attached to one object.
 *
 * Deliberately holds no reference to the scene object: the host tells it where to emit from each
 * frame. That keeps it usable for an emitter that follows a moving thing, one that fires at a point
 * something just broke, and a test that never builds a scene at all.
 */
export class ParticleEmitter {
  readonly points: THREE.Points;
  readonly #settings: Emitter;
  readonly #preset: EmitterPreset;
  readonly #pool: Pool;
  readonly #positions: Float32Array;
  readonly #sizes: Float32Array;
  readonly #ages: Float32Array;
  readonly #capacity: number;
  readonly #random: () => number;
  /** Fractional particles owed from the last frame, so a low rate is not rounded away to nothing. */
  #owed = 0;
  #live = 0;
  #disposed = false;

  constructor(settings: Emitter, random: () => number = Math.random) {
    this.#settings = settings;
    this.#preset = EMITTER_PRESETS[settings.kind];
    this.#capacity = emitterCapacity(settings);
    this.#random = random;

    this.#positions = new Float32Array(this.#capacity * 3);
    this.#sizes = new Float32Array(this.#capacity);
    this.#ages = new Float32Array(this.#capacity);
    this.#pool = {
      life: new Float32Array(this.#capacity),
      span: new Float32Array(this.#capacity),
      velocity: new Float32Array(this.#capacity * 3),
      size: new Float32Array(this.#capacity),
    };

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.#positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.#sizes, 1));
    geometry.setAttribute('aAge', new THREE.BufferAttribute(this.#ages, 1));
    geometry.setDrawRange(0, 0);
    // Particles leave the emitter's own bounds by design, so a computed bounding sphere would cull
    // the plume the moment the source went off screen — with the smoke still visible.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(settings.color ?? this.#preset.color) },
        uFadeColor: { value: new THREE.Color(this.#preset.fadeColor) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      // Additive reads as light — fire and sparks glow and brighten what is behind them. Normal
      // reads as matter, which is what smoke and dust are.
      blending: this.#preset.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.name = 'emitter';
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** How many particles are alive right now — what a test watches. */
  get liveCount(): number {
    return this.#live;
  }

  /** Releases `count` particles at once, from `origin`. */
  burst(origin: THREE.Vector3, count: number): void {
    for (let index = 0; index < count; index += 1) this.#spawn(origin);
  }

  /**
   * Advances one frame.
   *
   * `origin` is where the emitter is *now*, in world space, so a plume trails behind a moving
   * source rather than teleporting with it.
   */
  update(delta: number, origin: THREE.Vector3): void {
    if (this.#disposed) return;

    if (this.#settings.continuous) {
      // Accumulated rather than rounded per frame. A rate of two per second at sixty frames is
      // 0.033 particles a frame, and rounding that gives zero forever.
      this.#owed += this.#preset.rate * this.#settings.rateScale * delta;
      const due = Math.floor(this.#owed);
      this.#owed -= due;
      for (let index = 0; index < due; index += 1) this.#spawn(origin);
    }

    this.#step(delta);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }

  /** Ages every live particle, moves it, and compacts the survivors to the front of the buffer. */
  #step(delta: number): void {
    const { life, span, velocity, size } = this.#pool;
    const gravity = this.#preset.gravity;

    let write = 0;
    for (let read = 0; read < this.#live; read += 1) {
      const remaining = life[read]! - delta;
      if (remaining <= 0) continue;

      const vy = velocity[read * 3 + 1]! - gravity * delta;
      const x = this.#positions[read * 3]! + velocity[read * 3]! * delta;
      const y = this.#positions[read * 3 + 1]! + vy * delta;
      const z = this.#positions[read * 3 + 2]! + velocity[read * 3 + 2]! * delta;

      /**
       * Survivors are compacted to the front rather than left in place with a free list.
       *
       * The draw range is then simply `0..live`, which is one number the GPU already understands —
       * where a free list would mean either drawing dead particles or uploading an index buffer
       * every frame. The cost is that particle order changes, and nothing here depends on it.
       */
      life[write] = remaining;
      span[write] = span[read]!;
      velocity[write * 3] = velocity[read * 3]!;
      velocity[write * 3 + 1] = vy;
      velocity[write * 3 + 2] = velocity[read * 3 + 2]!;
      size[write] = size[read]!;

      const age = 1 - remaining / span[read]!;
      this.#positions[write * 3] = x;
      this.#positions[write * 3 + 1] = y;
      this.#positions[write * 3 + 2] = z;
      // Grown or shrunk across the life: smoke swells as it disperses, fire and sparks shrink away.
      this.#sizes[write] = size[read]! * (1 + (this.#preset.growth - 1) * age);
      this.#ages[write] = age;

      write += 1;
    }

    this.#live = write;
    this.points.geometry.setDrawRange(0, write);
    this.points.geometry.attributes['position']!.needsUpdate = true;
    this.points.geometry.attributes['aSize']!.needsUpdate = true;
    this.points.geometry.attributes['aAge']!.needsUpdate = true;
  }

  #spawn(origin: THREE.Vector3): void {
    // A full pool drops the newest rather than reallocating: growing a `BufferAttribute` means a new
    // GPU buffer mid-frame, and a puff that is briefly thin beats a hitch.
    if (this.#live >= this.#capacity) return;

    const slot = this.#live;
    const preset = this.#preset;
    const settings = this.#settings;

    spawnPoint.copy(origin).add(new THREE.Vector3(...settings.offset));

    const spread = preset.spread * settings.speedScale;
    // A cone rather than a sphere: particles from a chimney go up and outward, and a spherical
    // spread sends a quarter of them straight into whatever the emitter is standing on.
    const angle = this.#random() * Math.PI * 2;
    const radial = this.#random() * spread;

    this.#pool.velocity[slot * 3] = Math.cos(angle) * radial;
    this.#pool.velocity[slot * 3 + 1] =
      preset.rise * settings.speedScale * (0.7 + this.#random() * 0.6);
    this.#pool.velocity[slot * 3 + 2] = Math.sin(angle) * radial;

    const life = preset.seconds * settings.lifeScale * (0.8 + this.#random() * 0.4);
    this.#pool.life[slot] = life;
    this.#pool.span[slot] = life;
    this.#pool.size[slot] = preset.size * settings.sizeScale * (0.8 + this.#random() * 0.4);

    this.#positions[slot * 3] = spawnPoint.x;
    this.#positions[slot * 3 + 1] = spawnPoint.y;
    this.#positions[slot * 3 + 2] = spawnPoint.z;
    this.#sizes[slot] = this.#pool.size[slot]!;
    this.#ages[slot] = 0;

    this.#live += 1;
  }
}

export { VERTEX_SHADER as EMITTER_VERTEX_SHADER, FRAGMENT_SHADER as EMITTER_FRAGMENT_SHADER };
