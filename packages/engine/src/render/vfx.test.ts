import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  EmitterSchema,
  WeatherSchema,
  WindSchema,
  emitterCapacity,
  emitterProblems,
  weatherCount,
  weatherIsActive,
  type Emitter,
  type Weather,
} from '@helaengine/schema';
import { ParticleEmitter } from './ParticleEmitter.js';
import { createWeather, type WeatherField } from './Weather.js';

/**
 * Particles.
 *
 * The simulation is asserted by stepping it and reading the buffers, because that is where the
 * behaviour is. The shader is asserted against its own source, which is the only thing available
 * without a GPU — and the browser test carries the claim that pixels actually change.
 */

const weather = (input: Record<string, unknown> = {}): Weather => WeatherSchema.parse(input);
const emitter = (input: Record<string, unknown> = {}): Emitter => EmitterSchema.parse(input);

/** Deterministic, so a burst is the same every run and a failure is reproducible. */
const fixedRandom = (): number => 0.5;

describe('weather', () => {
  it('builds nothing at all when there is none', () => {
    // `none` is the absence of the system rather than a storm of zero strength: no geometry, no
    // shader, no draw call. Every scene saved before weather existed has to render as it did.
    expect(weatherIsActive(weather())).toBe(false);
    expect(createWeather(weather())).toBeNull();
    expect(createWeather(weather({ kind: 'rain', intensity: 0 }))).toBeNull();
  });

  it('builds a field when there is', () => {
    const field = createWeather(weather({ kind: 'rain', intensity: 0.5 }));
    expect(field).not.toBeNull();
    expect(field!.particleCount).toBeGreaterThan(1000);
    field!.dispose();
  });

  it('spends the slider where the useful range is', () => {
    // Squared, because the difference between drizzle and downpour is not linear in particle count
    // and a linear slider spends most of its travel in "far too much".
    const light = weatherCount(weather({ kind: 'rain', intensity: 0.25 }));
    const half = weatherCount(weather({ kind: 'rain', intensity: 0.5 }));
    const full = weatherCount(weather({ kind: 'rain', intensity: 1 }));

    expect(half / light).toBeGreaterThan(3.5);
    expect(full / half).toBeGreaterThan(3.5);
  });

  it('gives every particle a seed rather than a position', () => {
    const field = createWeather(weather({ kind: 'snow', intensity: 0.3 }))!;
    const seeds = field.points.geometry.getAttribute('aSeed');

    // Positions are derived in the shader from these, which is the whole reason the field costs no
    // CPU work to animate. A buffer of real positions would have to be rewritten every frame.
    expect(seeds.count).toBe(field.particleCount);
    expect(seeds.itemSize).toBe(3);
    field.dispose();
  });

  it('never culls itself away', () => {
    /**
     * The bug this exists for.
     *
     * The position attribute is all zeroes — the shader computes the real positions — so a computed
     * bounding sphere is a point at the origin. Three.js would then cull the entire field the moment
     * the camera looked away from world zero, and the rain would vanish when the player turned round.
     */
    const field = createWeather(weather({ kind: 'rain', intensity: 0.3 }))!;
    expect(field.points.frustumCulled).toBe(false);
    expect(field.points.geometry.boundingSphere?.radius).toBe(Infinity);
    field.dispose();
  });

  it('follows the camera', () => {
    const field = createWeather(weather({ kind: 'rain', intensity: 0.2 }))!;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(120, 3, -80);
    camera.updateMatrixWorld(true);

    field.update(1 / 60, camera, WindSchema.parse({}));

    // A finite box of drops looks infinite only because the player carries it with them. Read from
    // the shader source too: the uniform is useless if the shader ignores it.
    expect(field.vertexShader).toContain('uCamera');
    field.dispose();
  });

  it('leans with the wind, and stands straight without it', () => {
    const camera = new THREE.PerspectiveCamera();

    const still = createWeather(weather({ kind: 'rain', intensity: 0.2 }))!;
    still.update(1 / 60, camera, WindSchema.parse({ strength: 0 }));
    // The control half: no wind is no push, not a small one.
    expect(still.windPush.length()).toBe(0);
    still.dispose();

    const blown = createWeather(weather({ kind: 'rain', intensity: 0.2 }))!;
    blown.update(1 / 60, camera, WindSchema.parse({ strength: 1.5, direction: 90 }));

    // Rain falling straight down past a canopy that is visibly leaning reads as wrong without
    // anybody being able to say why — so the two systems share one wind. Asserted on the uniform
    // *and* on the shader reading it, because either alone is half the claim.
    expect(blown.windPush.length()).toBeCloseTo(1.5, 5);
    expect(blown.vertexShader).toContain('uWind');
    blown.dispose();
  });

  it('ignores the wind when told to', () => {
    const field = createWeather(
      weather({ kind: 'snow', intensity: 0.2, followWind: false }),
    ) as WeatherField;
    field.update(
      1 / 60,
      new THREE.PerspectiveCamera(),
      WindSchema.parse({ strength: 3, direction: 45 }),
    );

    // Snow indoors, or a stylised level that wants it falling straight. A gale outside must not
    // reach it.
    expect(field.windPush.length()).toBe(0);
    field.dispose();
  });
});

describe('emitters', () => {
  it('emits over time, and nothing at all when the rate is zero', () => {
    // The control case: an emitter with no rate is a buffer that costs a draw call and produces
    // nothing, and "particles appeared" would otherwise be a claim about the pool being non-empty.
    const idle = new ParticleEmitter(emitter({ kind: 'smoke', rateScale: 0 }), fixedRandom);
    idle.update(1, new THREE.Vector3());
    expect(idle.liveCount).toBe(0);
    idle.dispose();

    const running = new ParticleEmitter(emitter({ kind: 'smoke' }), fixedRandom);
    running.update(1, new THREE.Vector3());
    expect(running.liveCount).toBeGreaterThan(10);
    running.dispose();
  });

  it('emits a slow trickle rather than rounding it away to nothing', () => {
    /**
     * Why the owed count is accumulated across frames.
     *
     * A rate of two per second at sixty frames a second is 0.033 particles per frame. Rounded each
     * frame that is zero, forever — and a low-rate emitter would produce absolutely nothing while
     * looking completely configured.
     */
    const slow = new ParticleEmitter(emitter({ kind: 'smoke', rateScale: 0.05 }), fixedRandom);
    for (let frame = 0; frame < 120; frame += 1) slow.update(1 / 60, new THREE.Vector3());

    expect(slow.liveCount).toBeGreaterThan(0);
    slow.dispose();
  });

  it('retires particles at the end of their life', () => {
    const puff = new ParticleEmitter(
      emitter({ kind: 'sparks', continuous: false, burst: 20 }),
      fixedRandom,
    );
    puff.burst(new THREE.Vector3(), 20);
    expect(puff.liveCount).toBe(20);

    // Sparks live about 1.1s. Four seconds later there must be nothing left, or every burst in a
    // level is permanent.
    for (let frame = 0; frame < 240; frame += 1) puff.update(1 / 60, new THREE.Vector3());
    expect(puff.liveCount).toBe(0);
    puff.dispose();
  });

  it('moves them, and moves them differently by kind', () => {
    const smoke = new ParticleEmitter(emitter({ kind: 'smoke' }), fixedRandom);
    const sparks = new ParticleEmitter(emitter({ kind: 'sparks' }), fixedRandom);

    smoke.burst(new THREE.Vector3(), 1);
    sparks.burst(new THREE.Vector3(), 1);
    for (let frame = 0; frame < 30; frame += 1) {
      smoke.update(1 / 60, new THREE.Vector3());
      sparks.update(1 / 60, new THREE.Vector3());
    }

    const heightOf = (system: ParticleEmitter): number =>
      system.points.geometry.getAttribute('position').getY(0);

    // Smoke rises against a negative gravity; sparks are thrown up and pulled back down hard. Half a
    // second in, the two have to have parted company — a system where every kind moved the same way
    // would be one preset wearing six names.
    expect(heightOf(smoke)).toBeGreaterThan(0.3);
    expect(heightOf(sparks)).toBeLessThan(heightOf(smoke));
    smoke.dispose();
    sparks.dispose();
  });

  it('grows smoke and shrinks fire', () => {
    const smoke = new ParticleEmitter(emitter({ kind: 'smoke' }), fixedRandom);
    smoke.burst(new THREE.Vector3(), 1);
    const born = smoke.points.geometry.getAttribute('aSize').getX(0);
    for (let frame = 0; frame < 60; frame += 1) smoke.update(1 / 60, new THREE.Vector3());
    expect(smoke.points.geometry.getAttribute('aSize').getX(0)).toBeGreaterThan(born);
    smoke.dispose();

    const fire = new ParticleEmitter(emitter({ kind: 'fire' }), fixedRandom);
    fire.burst(new THREE.Vector3(), 1);
    const lit = fire.points.geometry.getAttribute('aSize').getX(0);
    for (let frame = 0; frame < 20; frame += 1) fire.update(1 / 60, new THREE.Vector3());
    expect(fire.points.geometry.getAttribute('aSize').getX(0)).toBeLessThan(lit);
    fire.dispose();
  });

  it('spawns where the emitter is now, not where it started', () => {
    const trail = new ParticleEmitter(emitter({ kind: 'smoke' }), fixedRandom);
    trail.update(0.2, new THREE.Vector3(0, 0, 0));
    trail.update(0.2, new THREE.Vector3(50, 0, 0));

    const positions = trail.points.geometry.getAttribute('position');
    let far = 0;
    for (let index = 0; index < trail.liveCount; index += 1) {
      if (positions.getX(index) > 25) far += 1;
    }

    // A plume has to trail behind a moving source rather than teleport with it, which means the
    // origin is an argument per frame and not something the emitter remembers.
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(trail.liveCount);
    trail.dispose();
  });

  it('drops the newest rather than growing the buffer', () => {
    const capped = new ParticleEmitter(
      emitter({ kind: 'sparks', continuous: false, burst: 10 }),
      fixedRandom,
    );
    capped.burst(new THREE.Vector3(), 100_000);

    // Growing a `BufferAttribute` means a new GPU buffer mid-frame. A puff that is briefly thinner
    // than asked for beats a hitch.
    expect(capped.liveCount).toBe(capped.capacity);
    capped.dispose();
  });

  it('never draws a dead particle', () => {
    const puff = new ParticleEmitter(
      emitter({ kind: 'dust', continuous: false, burst: 30 }),
      fixedRandom,
    );
    puff.burst(new THREE.Vector3(), 30);

    for (let frame = 0; frame < 200; frame += 1) {
      puff.update(1 / 60, new THREE.Vector3());
      // The draw range is the live count, always. Survivors are compacted to the front of the
      // buffer so this stays one number rather than an index buffer uploaded every frame.
      expect(puff.points.geometry.drawRange.count).toBe(puff.liveCount);
    }
    puff.dispose();
  });

  it('blends light additively and matter normally', () => {
    const fire = new ParticleEmitter(emitter({ kind: 'fire' }), fixedRandom);
    const smoke = new ParticleEmitter(emitter({ kind: 'smoke' }), fixedRandom);

    // Additive reads as light and brightens what is behind it; normal reads as matter. Getting this
    // backwards gives grey fire and glowing smoke.
    expect((fire.points.material as THREE.ShaderMaterial).blending).toBe(THREE.AdditiveBlending);
    expect((smoke.points.material as THREE.ShaderMaterial).blending).toBe(THREE.NormalBlending);
    fire.dispose();
    smoke.dispose();
  });
});

describe('emitterProblems', () => {
  it('catches a burst emitter nothing triggers', () => {
    // It exists, costs a buffer, and can never emit. Nothing else about the document says so.
    expect(emitterProblems(emitter({ continuous: false, burstEvent: '' })).join('\n')).toContain(
      'no event triggers it',
    );
  });

  it('catches a continuous emitter with no rate', () => {
    expect(emitterProblems(emitter({ rateScale: 0 })).join('\n')).toContain('nothing comes out');
  });

  it('warns when the pool would be capped', () => {
    const greedy = emitter({ kind: 'splash', rateScale: 20, lifeScale: 20 });
    expect(emitterCapacity(greedy)).toBeLessThanOrEqual(2000);
    expect(emitterProblems(greedy).join('\n')).toContain('capped');
  });

  it('says nothing about an ordinary emitter', () => {
    expect(emitterProblems(emitter({ kind: 'smoke' }))).toEqual([]);
  });
});
