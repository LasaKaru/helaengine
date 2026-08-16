import { z } from 'zod';
import { HexColorSchema } from './primitives.js';

/**
 * Particles: weather over a whole level, and emitters attached to things.
 *
 * Two separate systems, because they are two separate problems and merging them would make both
 * worse.
 *
 * **Weather** covers the camera. Rain does not come from a point — it is everywhere the player
 * looks, forever, and the only sane implementation is a volume of particles that follows the camera
 * and wraps around inside it. Nothing is spawned or retired; the same ten thousand drops fall
 * through a box for the whole level, and their positions are a function of time computed on the GPU.
 * That is why weather costs one draw call and no per-frame CPU work at all.
 *
 * **Emitters** come from somewhere. Smoke off a chimney, sparks off a broken wire, dust where
 * something landed. They have a birth, a life and a death, they can burst, and they are simulated on
 * the CPU because the interesting part is exactly the bookkeeping the GPU is bad at.
 *
 * ## Both are closed vocabularies
 *
 * A kind names a *behaviour the engine implements*, not a shader somebody supplied. `fire` rises and
 * shrinks and fades from yellow; `sparks` fall and streak. An author picks a kind and tunes numbers.
 * Nothing here can introduce a new behaviour, for the same reason nothing else in this schema can.
 */

/**
 * Weather that fills the level.
 *
 * `none` is the default and is the absence of the system rather than a zero-strength storm: no
 * geometry is built, no shader is compiled, and no uniform is updated. Every scene saved before this
 * existed renders exactly as it did.
 */
export const WEATHER_KINDS = ['none', 'rain', 'snow', 'dust', 'ash'] as const;
export const WeatherKindSchema = z.enum(WEATHER_KINDS);
export type WeatherKind = z.infer<typeof WeatherKindSchema>;

export const WEATHER_LABELS: Readonly<Record<WeatherKind, string>> = {
  none: 'None',
  rain: 'Rain',
  snow: 'Snow',
  dust: 'Dust motes',
  ash: 'Ash',
};

export const WEATHER_HINTS: Readonly<Record<WeatherKind, string>> = {
  none: 'No weather. Nothing is built and nothing is drawn.',
  rain: 'Fast vertical streaks. Reads best against a dark sky.',
  snow: 'Slow drifting flakes that wander sideways as they fall.',
  dust: 'Near-still motes hanging in the air. Interiors and shafts of light.',
  ash: 'Slow, heavy flakes falling almost straight. Aftermath.',
};

/**
 * How each kind behaves, as the numbers the shader actually uses.
 *
 * A table rather than a branch in the shader: the shader has one code path and the kind chooses its
 * constants, which keeps the compiled program identical for every weather type and means switching
 * weather does not recompile anything.
 */
export const WEATHER_PRESETS: Readonly<
  Record<
    Exclude<WeatherKind, 'none'>,
    {
      fallSpeed: number;
      drift: number;
      size: number;
      stretch: number;
      color: string;
      opacity: number;
    }
  >
> = {
  rain: { fallSpeed: 14, drift: 0.15, size: 0.035, stretch: 9, color: '#9fb6cc', opacity: 0.5 },
  snow: { fallSpeed: 1.1, drift: 1.1, size: 0.09, stretch: 1, color: '#ffffff', opacity: 0.85 },
  dust: { fallSpeed: 0.12, drift: 0.5, size: 0.045, stretch: 1, color: '#d8c9a8', opacity: 0.35 },
  ash: { fallSpeed: 0.7, drift: 0.7, size: 0.07, stretch: 1.6, color: '#b9b4ad', opacity: 0.6 },
};

/** The most weather particles one level may have. */
export const MAX_WEATHER_PARTICLES = 40_000;

export const WeatherSchema = z
  .object({
    kind: WeatherKindSchema.default('none'),
    /**
     * How much of it, as a fraction of the kind's own maximum.
     *
     * A fraction rather than a count, because "twelve thousand particles" is not a quantity anybody
     * has an opinion about, while "heavy rain" is. The count it maps to is the engine's business.
     */
    intensity: z.number().min(0).max(1).default(0.5),
    /**
     * Size of the volume that follows the camera, in metres.
     *
     * The one number with a real trade in it: too small and the player sees the edge of the weather
     * as they turn, too large and the same particle count is spread thin enough to look like
     * drizzle. Forty metres is where rain stops having a visible boundary at a normal field of view.
     */
    radius: z.number().min(5).max(300).default(40),
    /** Overrides the preset colour when set. */
    color: HexColorSchema.nullable().default(null),
    /**
     * Whether the wind pushes it sideways.
     *
     * On by default and worth it: rain falling straight down through a canopy that is visibly
     * leaning is the sort of detail that reads as wrong without anybody being able to say why.
     */
    followWind: z.boolean().default(true),
  })
  .default({});
export type Weather = z.infer<typeof WeatherSchema>;

/**
 * True when weather should be built at all.
 *
 * `kind: 'none'` and `intensity: 0` are both "no weather", and both must mean *no geometry, no
 * shader, no uniform* rather than an invisible system still costing a draw call.
 */
export function weatherIsActive(weather: Weather): boolean {
  return weather.kind !== 'none' && weather.intensity > 0;
}

/** How many particles a given intensity asks for. */
export function weatherCount(weather: Weather): number {
  if (!weatherIsActive(weather)) return 0;
  // Squared, so the slider's lower half is where the useful range lives — the difference between
  // drizzle and downpour is not linear in particle count, and a linear slider spends most of its
  // travel in "too much".
  return Math.round(MAX_WEATHER_PARTICLES * weather.intensity * weather.intensity);
}

/**
 * What an emitter throws out.
 *
 * The kind decides the *shape of the behaviour* — which way particles go, whether they grow or
 * shrink, how they are blended. Everything else is a number.
 */
export const EMITTER_KINDS = ['smoke', 'fire', 'sparks', 'steam', 'dust', 'splash'] as const;
export const EmitterKindSchema = z.enum(EMITTER_KINDS);
export type EmitterKind = z.infer<typeof EmitterKindSchema>;

export const EMITTER_LABELS: Readonly<Record<EmitterKind, string>> = {
  smoke: 'Smoke',
  fire: 'Fire',
  sparks: 'Sparks',
  steam: 'Steam',
  dust: 'Dust',
  splash: 'Splash',
};

export interface EmitterPreset {
  /** Metres per second, upward at birth. Negative falls. */
  rise: number;
  /** How far particles scatter sideways, in metres per second. */
  spread: number;
  /** Downward acceleration. Sparks have it; smoke does not. */
  gravity: number;
  /** Size in metres at birth, and the factor it reaches by death. */
  size: number;
  growth: number;
  seconds: number;
  color: string;
  fadeColor: string;
  /** Additive reads as light — fire and sparks. Normal reads as matter — smoke and dust. */
  additive: boolean;
  /** Particles per second while running. */
  rate: number;
}

/**
 * The behaviour behind each kind.
 *
 * Chosen so that the *defaults alone* look like the thing named: an author who ticks `fire` and
 * changes nothing should get fire, not a starting point for fire. A preset that needs tuning before
 * it resembles its own name is a worse default than no preset.
 */
export const EMITTER_PRESETS: Readonly<Record<EmitterKind, EmitterPreset>> = {
  smoke: {
    rise: 1.4,
    spread: 0.35,
    gravity: -0.15,
    size: 0.35,
    growth: 3.2,
    seconds: 3.2,
    color: '#6b6b6b',
    fadeColor: '#3a3a3a',
    additive: false,
    rate: 18,
  },
  fire: {
    rise: 2.4,
    spread: 0.4,
    gravity: -0.6,
    size: 0.32,
    growth: 0.35,
    seconds: 0.75,
    color: '#ffcc55',
    fadeColor: '#d8442a',
    additive: true,
    rate: 45,
  },
  sparks: {
    rise: 3.2,
    spread: 2.6,
    gravity: 9.5,
    size: 0.05,
    growth: 0.4,
    seconds: 1.1,
    color: '#fff0b0',
    fadeColor: '#ff6a1e',
    additive: true,
    rate: 40,
  },
  steam: {
    rise: 1.9,
    spread: 0.3,
    gravity: -0.35,
    size: 0.25,
    growth: 3.6,
    seconds: 2.4,
    color: '#e8eef2',
    fadeColor: '#c8d4dc',
    additive: false,
    rate: 22,
  },
  dust: {
    rise: 0.5,
    spread: 1.4,
    gravity: 1.2,
    size: 0.22,
    growth: 2.1,
    seconds: 1.6,
    color: '#c6b394',
    fadeColor: '#8d7f68',
    additive: false,
    rate: 30,
  },
  splash: {
    rise: 3.4,
    spread: 1.8,
    gravity: 11,
    size: 0.07,
    growth: 0.6,
    seconds: 0.9,
    color: '#bcd8e8',
    fadeColor: '#7ba4bd',
    additive: false,
    rate: 60,
  },
};

/** The most live particles one emitter may hold. */
export const MAX_EMITTER_PARTICLES = 2000;

export const EmitterSchema = z.object({
  kind: EmitterKindSchema.default('smoke'),
  /**
   * Whether it runs continuously, or only when something asks it to.
   *
   * A chimney is continuous. A footstep puff is not — it exists to be triggered, and a continuous
   * one would be a permanent cloud round the character's ankles.
   */
  continuous: z.boolean().default(true),
  /** Particles released by one burst, when triggered. */
  burst: z.number().int().min(0).max(500).default(24),
  /**
   * An event that fires a burst, or empty for none.
   *
   * The same mechanism destructibles use to talk to the world: a name on the bus. A dust puff bound
   * to `destructibleBroken` covers every crate in the level with one emitter and no wiring.
   */
  burstEvent: z.string().max(64).default(''),

  /** Multiplies the preset's rate. 1 is the preset as designed. */
  rateScale: z.number().min(0).max(20).default(1),
  /** Multiplies the preset's size. */
  sizeScale: z.number().min(0.05).max(20).default(1),
  /** Multiplies the preset's lifetime. */
  lifeScale: z.number().min(0.05).max(20).default(1),
  /** Multiplies the preset's launch speed. */
  speedScale: z.number().min(0).max(20).default(1),

  /** Overrides the preset's birth colour when set. */
  color: HexColorSchema.nullable().default(null),
  /** Where the emitter sits relative to its object, in metres. */
  offset: z
    .tuple([
      z.number().min(-100).max(100),
      z.number().min(-100).max(100),
      z.number().min(-100).max(100),
    ])
    .default([0, 0, 0]),
});
export type Emitter = z.infer<typeof EmitterSchema>;

export const OptionalEmitterSchema = EmitterSchema.nullable().default(null);

export function defaultEmitter(kind: EmitterKind = 'smoke'): Emitter {
  return EmitterSchema.parse({ kind });
}

/**
 * Particles this emitter needs room for.
 *
 * Rate times lifetime is how many are alive at once in the steady state, plus one burst in case one
 * lands on a full pool. Sized once at build time rather than grown, because growing a
 * `BufferAttribute` means reallocating a GPU buffer mid-frame.
 */
export function emitterCapacity(emitter: Emitter): number {
  const preset = EMITTER_PRESETS[emitter.kind];
  const steady = emitter.continuous
    ? preset.rate * emitter.rateScale * preset.seconds * emitter.lifeScale
    : 0;
  return Math.min(Math.ceil(steady) + emitter.burst + 8, MAX_EMITTER_PARTICLES);
}

/** Whether an emitter would ever produce anything. */
export function emitterIsActive(emitter: Emitter): boolean {
  if (emitter.continuous && emitter.rateScale > 0) return true;
  return emitter.burst > 0 && emitter.burstEvent !== '';
}

/**
 * Problems that would make an emitter do nothing, or something surprising.
 *
 * Reported rather than thrown, and shown in the editor: an emitter that silently produces nothing is
 * indistinguishable from one somebody forgot to finish.
 */
export function emitterProblems(emitter: Emitter): string[] {
  const problems: string[] = [];

  if (!emitter.continuous && emitter.burstEvent === '') {
    // Not continuous and nothing to trigger it: the emitter exists, costs a buffer, and can never
    // emit. Nothing else about the document says so.
    problems.push('this only bursts, but no event triggers it — name one, or make it continuous');
  }

  if (emitter.continuous && emitter.rateScale === 0) {
    problems.push('the rate is zero, so nothing comes out');
  }

  if (emitterCapacity(emitter) >= MAX_EMITTER_PARTICLES) {
    problems.push(
      `at this rate and lifetime it wants more than ${MAX_EMITTER_PARTICLES} particles, and will be capped`,
    );
  }

  return problems;
}
