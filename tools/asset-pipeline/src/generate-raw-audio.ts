/**
 * Synthesises the stand-in audio the engine ships with.
 *
 * The same bargain as `generate-raw-assets`: these are not sound design, they are real files with
 * real waveforms so that every stage downstream — ingest, the manifest, the mixer, an exported
 * build — has something genuine to chew on. Sprint 37 replaces them with commissioned audio and
 * nothing else has to change, because everything refers to them by `assetId`.
 *
 * Written as WAV because it is the one format that can be produced with arithmetic alone.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { encodeWav } from './audio.js';
import { rawAssetsDir } from './paths.js';

const SAMPLE_RATE = 44_100;

interface Voice {
  /** Amplitude at a point in the clip, 0..1. */
  envelope(t: number, duration: number): number;
  /** Sample value in -1..1 before the envelope. */
  wave(t: number): number;
}

function sine(frequency: number): (t: number) => number {
  return (t) => Math.sin(2 * Math.PI * frequency * t);
}

/** A cheap deterministic noise source — `Math.random` would make the files differ every run. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state / 2147483648) - 1;
  };
}

function decay(power = 3): Voice['envelope'] {
  return (t, duration) => (1 - t / duration) ** power;
}

/** Fades in and out, so a looping bed does not click at the seam. */
function bed(fade = 0.4): Voice['envelope'] {
  return (t, duration) => {
    const rise = Math.min(1, t / fade);
    const fall = Math.min(1, (duration - t) / fade);
    return Math.min(rise, fall);
  };
}

function render(duration: number, voices: Voice[], amplitude = 0.6): Uint8Array {
  const count = Math.floor(duration * SAMPLE_RATE);
  const samples = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const t = index / SAMPLE_RATE;
    let value = 0;
    for (const voice of voices) value += voice.wave(t) * voice.envelope(t, duration);
    samples[index] = (value / voices.length) * amplitude;
  }

  return encodeWav({ sampleRate: SAMPLE_RATE, channels: 1, samples });
}

/** A short chord, used as the backbone of both music beds. */
function chord(frequencies: number[], envelope: Voice['envelope']): Voice[] {
  return frequencies.map((frequency) => ({ wave: sine(frequency), envelope }));
}

interface Clip {
  id: string;
  build(): Uint8Array;
}

const CLIPS: Clip[] = [
  {
    // A slow, wide major chord: the sound of nothing being wrong.
    id: 'audio_music_menu',
    build: () => render(8, chord([174.61, 220, 261.63, 329.63], bed(1.2)), 0.5),
  },
  {
    id: 'audio_music_explore',
    build: () =>
      render(
        10,
        [
          ...chord([146.83, 196, 246.94], bed(1.5)),
          // A slow pulse over the top, so the bed is not a drone.
          { wave: (t) => Math.sin(2 * Math.PI * 392 * t) * (0.5 + 0.5 * Math.sin(t * 1.1)), envelope: bed(1.5) },
        ],
        0.45,
      ),
  },
  {
    // Minor, faster pulse, more low end. Tension without needing a drum kit.
    id: 'audio_music_combat',
    build: () =>
      render(
        8,
        [
          ...chord([110, 130.81, 164.81], bed(0.6)),
          { wave: (t) => Math.sin(2 * Math.PI * 220 * t) * Math.sign(Math.sin(t * 12)), envelope: bed(0.6) },
        ],
        0.55,
      ),
  },
  {
    // Rising two-tone: the universal "you got a thing".
    id: 'audio_sfx_pickup',
    build: () =>
      render(0.28, [
        { wave: (t) => Math.sin(2 * Math.PI * (660 + t * 1400) * t), envelope: decay(2) },
      ]),
  },
  {
    id: 'audio_sfx_damage',
    build: () => {
      const source = noise(7717);
      return render(0.3, [
        { wave: () => source(), envelope: decay(4) },
        { wave: sine(120), envelope: decay(3) },
      ]);
    },
  },
  {
    // Falling, resolved: a place to rest.
    id: 'audio_sfx_checkpoint',
    build: () =>
      render(0.6, [
        { wave: sine(523.25), envelope: (t, d) => decay(2)(t, d) * (t < 0.2 ? 1 : 0) },
        { wave: sine(783.99), envelope: (t, d) => decay(2)(t, d) * (t >= 0.2 ? 1 : 0) },
      ]),
  },
  {
    id: 'audio_sfx_shoot',
    build: () => {
      const source = noise(31337);
      return render(0.18, [
        { wave: () => source(), envelope: decay(6) },
        { wave: sine(90), envelope: decay(5) },
      ]);
    },
  },
  {
    id: 'audio_sfx_reload',
    build: () => {
      const source = noise(5150);
      return render(0.22, [{ wave: () => source() * 0.6, envelope: decay(8) }]);
    },
  },
  {
    id: 'audio_sfx_secret',
    build: () =>
      render(
        0.9,
        [523.25, 659.25, 783.99, 1046.5].map((frequency, step) => ({
          wave: sine(frequency),
          // An arpeggio: each note owns a quarter of the clip.
          envelope: (t) => (t >= step * 0.2 && t < step * 0.2 + 0.25 ? decay(2)(t - step * 0.2, 0.3) : 0),
        })),
      ),
  },
  {
    id: 'audio_sfx_death',
    build: () =>
      render(1.1, [{ wave: (t) => Math.sin(2 * Math.PI * (220 - t * 120) * t), envelope: decay(2) }]),
  },
];

async function main(): Promise<void> {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : rawAssetsDir;
  await fs.mkdir(target, { recursive: true });

  console.log(`Generating ${CLIPS.length} stand-in audio clips into ${target}\n`);
  for (const clip of CLIPS) {
    const bytes = clip.build();
    await fs.writeFile(path.join(target, `${clip.id}.wav`), bytes);
    console.log(`  ${clip.id.padEnd(24)} ${(bytes.length / 1024).toFixed(1).padStart(8)} KB`);
  }
  console.log('\nDone. Run `pnpm ingest-assets` to level and publish them.');
}

await main();
