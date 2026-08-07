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
    return state / 2147483648 - 1;
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
          {
            wave: (t) => Math.sin(2 * Math.PI * 392 * t) * (0.5 + 0.5 * Math.sin(t * 1.1)),
            envelope: bed(1.5),
          },
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
          {
            wave: (t) => Math.sin(2 * Math.PI * 220 * t) * Math.sign(Math.sin(t * 12)),
            envelope: bed(0.6),
          },
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
          envelope: (t) =>
            t >= step * 0.2 && t < step * 0.2 + 0.25 ? decay(2)(t - step * 0.2, 0.3) : 0,
        })),
      ),
  },
  {
    id: 'audio_sfx_death',
    build: () =>
      render(1.1, [
        { wave: (t) => Math.sin(2 * Math.PI * (220 - t * 120) * t), envelope: decay(2) },
      ]),
  },

  // --- Ambience beds ---
  //
  // Long, seamless loops rather than short ones. A four-second bed repeats fifteen times a minute
  // and the ear finds the seam within two of them; twelve seconds is long enough that the loop
  // stops being a rhythm. `bed()` fades both ends so the wrap does not click.
  {
    /**
     * Wind: filtered noise whose brightness rises and falls.
     *
     * A one-pole low-pass over white noise is the whole trick. Unfiltered noise is a hiss, and a
     * hiss is a broken speaker; rolling the top off and then *moving* the cutoff is what the ear
     * hears as air rather than as static.
     */
    id: 'audio_ambience_wind',
    build: () => {
      const source = noise(1337);
      let filtered = 0;
      return render(
        12,
        [
          {
            wave: (t) => {
              // Two slow LFOs at an irrational ratio, so the gusting never lines up with itself.
              const gust = 0.5 + 0.5 * Math.sin(t * 0.7) * Math.sin(t * 0.31 + 1.2);
              const cutoff = 0.04 + gust * 0.1;
              filtered += (source() - filtered) * cutoff;
              return filtered * (0.5 + gust) * 3.2;
            },
            envelope: bed(2),
          },
        ],
        0.42,
      );
    },
  },
  {
    // Birds: sparse chirps over a very quiet air bed. Sparse is the point — a continuous dawn
    // chorus is a nature documentary, not a level somebody has to stand in for an hour.
    id: 'audio_ambience_birds',
    build: () => {
      const source = noise(4242);
      let filtered = 0;
      return render(
        12,
        [
          {
            wave: () => {
              filtered += (source() - filtered) * 0.05;
              return filtered * 1.4;
            },
            envelope: bed(2),
          },
          {
            wave: (t) => {
              // A chirp every ~1.7s, each a short rising warble. The offset per chirp is derived
              // from its index, so they are not evenly spaced.
              const index = Math.floor(t / 1.7);
              const local = t - index * 1.7 - (index % 3) * 0.13;
              if (local < 0 || local > 0.22) return 0;
              const pitch = 2400 + Math.sin(local * 90) * 500 + (index % 5) * 120;
              return Math.sin(2 * Math.PI * pitch * local) * (1 - local / 0.22) ** 2;
            },
            envelope: bed(2),
          },
        ],
        0.3,
      );
    },
  },
  {
    // Water: brighter, faster-moving noise than wind, with a low burble under it.
    id: 'audio_ambience_water',
    build: () => {
      const source = noise(909);
      let filtered = 0;
      return render(
        12,
        [
          {
            wave: (t) => {
              filtered += (source() - filtered) * (0.18 + 0.06 * Math.sin(t * 2.3));
              return filtered * 2.4;
            },
            envelope: bed(2),
          },
          {
            wave: (t) => Math.sin(2 * Math.PI * 90 * t) * 0.25 * (0.5 + 0.5 * Math.sin(t * 1.7)),
            envelope: bed(2),
          },
        ],
        0.4,
      );
    },
  },
  {
    // Night: a low hum with crickets. Quieter and darker than the day beds.
    id: 'audio_ambience_night',
    build: () => {
      const source = noise(7);
      let filtered = 0;
      return render(
        12,
        [
          {
            wave: () => {
              filtered += (source() - filtered) * 0.02;
              return filtered * 1.6;
            },
            envelope: bed(2),
          },
          {
            // Crickets: a fast pulse train that comes and goes.
            wave: (t) => {
              const chorus = Math.max(0, Math.sin(t * 0.6));
              const pulse = Math.sin(2 * Math.PI * 4200 * t) * Math.max(0, Math.sin(t * 220));
              return pulse * chorus * 0.35;
            },
            envelope: bed(2),
          },
        ],
        0.28,
      );
    },
  },
  {
    // Cave: a deep drone and a very occasional drip. Almost nothing, which is what makes it read as
    // underground rather than as a room with a fan in it.
    id: 'audio_ambience_cave',
    build: () =>
      render(
        12,
        [
          { wave: sine(58), envelope: bed(2.5) },
          { wave: (t) => Math.sin(2 * Math.PI * 87 * t) * 0.4, envelope: bed(2.5) },
          {
            wave: (t) => {
              const local = t % 3.9;
              if (local > 0.16) return 0;
              return (
                Math.sin(2 * Math.PI * (1400 - local * 2600) * local) * (1 - local / 0.16) ** 3
              );
            },
            envelope: bed(2.5),
          },
        ],
        0.34,
      ),
  },

  // --- More effects ---
  {
    // Footstep: a very short filtered noise burst. Pitch and length are all that separate a step on
    // grass from one on stone, and this is the grass one.
    id: 'audio_sfx_footstep',
    build: () => {
      const source = noise(21);
      let filtered = 0;
      return render(
        0.12,
        [
          {
            wave: () => {
              filtered += (source() - filtered) * 0.28;
              return filtered * 3;
            },
            envelope: decay(4),
          },
        ],
        0.5,
      );
    },
  },
  {
    // Jump: a short rising blip. Rising for up, falling for landing — the pair reads as one motion.
    id: 'audio_sfx_jump',
    build: () =>
      render(0.18, [
        { wave: (t) => Math.sin(2 * Math.PI * (320 + t * 900) * t), envelope: decay(2) },
      ]),
  },
  {
    id: 'audio_sfx_land',
    build: () => {
      const source = noise(88);
      let filtered = 0;
      return render(0.22, [
        { wave: (t) => Math.sin(2 * Math.PI * (260 - t * 500) * t), envelope: decay(3) },
        {
          wave: () => {
            filtered += (source() - filtered) * 0.2;
            return filtered * 2;
          },
          envelope: decay(5),
        },
      ]);
    },
  },
  {
    // Swing: a whoosh, which is noise swept from bright to dark. The sweep is the whole sound.
    id: 'audio_sfx_swing',
    build: () => {
      const source = noise(555);
      let filtered = 0;
      return render(0.3, [
        {
          wave: (t) => {
            filtered += (source() - filtered) * Math.max(0.02, 0.35 - t * 1.1);
            return filtered * 3.5;
          },
          envelope: (t, duration) => Math.sin((t / duration) * Math.PI) ** 2,
        },
      ]);
    },
  },
  {
    // Door: a low scrape with a latch at the end.
    id: 'audio_sfx_door',
    build: () => {
      const source = noise(31);
      let filtered = 0;
      return render(0.65, [
        {
          wave: () => {
            filtered += (source() - filtered) * 0.06;
            return filtered * 2.5;
          },
          envelope: (t, duration) => (t < duration - 0.12 ? 0.6 : 0),
        },
        {
          wave: (t) => Math.sin(2 * Math.PI * 900 * t),
          envelope: (t, duration) => (t > duration - 0.1 ? decay(3)(t - (duration - 0.1), 0.1) : 0),
        },
      ]);
    },
  },
  {
    // Heal: the pickup sound's optimism, slower and warmer.
    id: 'audio_sfx_heal',
    build: () =>
      render(0.5, [
        { wave: (t) => Math.sin(2 * Math.PI * (440 + t * 300) * t), envelope: decay(1.5) },
        { wave: (t) => Math.sin(2 * Math.PI * (554 + t * 300) * t), envelope: decay(1.5) },
      ]),
  },
  {
    // UI click: as short as a sound can be and still be heard. Anything longer feels laggy.
    id: 'audio_sfx_click',
    build: () => render(0.05, [{ wave: sine(1200), envelope: decay(2) }], 0.4),
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
