import { describe, expect, it } from 'vitest';
import { checkPolyBudget, polyBudgets } from './budgets.js';
import { readAssetMetadata } from './metadata.js';
import { metadataFile } from './paths.js';
import {
  decodeWav,
  durationSeconds,
  encodeWav,
  isAudioFile,
  levelLoudness,
  measureLoudness,
  PEAK_CEILING_DB,
  TARGET_RMS_DB,
  type DecodedAudio,
} from './audio.js';

describe('poly budgets', () => {
  it('passes an asset inside its category budget', () => {
    expect(checkPolyBudget('rocks', 400).level).toBe('ok');
  });

  it('warns between the budget and the hard limit', () => {
    expect(checkPolyBudget('rocks', polyBudgets.rocks + 1).level).toBe('warn');
    expect(checkPolyBudget('rocks', polyBudgets.rocks * 2).level).toBe('warn');
  });

  it('fails past twice the budget', () => {
    expect(checkPolyBudget('rocks', polyBudgets.rocks * 2 + 1).level).toBe('fail');
  });

  it('gives buildings a larger allowance than rocks', () => {
    expect(polyBudgets.buildings).toBeGreaterThan(polyBudgets.rocks);
  });
});

describe('asset metadata', () => {
  it('reads declared metadata for a known asset', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    const goblin = metadata.get('enemy_goblin_01');

    expect(goblin).toMatchObject({
      name: 'Goblin',
      category: 'enemies',
      colliderType: 'capsule',
      declared: true,
    });
  });

  it('falls back to a guessed category and readable name for an undeclared asset', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    const guessed = metadata.get('tree_willow_09');

    expect(guessed).toMatchObject({ name: 'Tree Willow 09', category: 'trees', declared: false });
  });

  it('lands unrecognised prefixes in props rather than throwing', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    expect(metadata.get('widget_thing_01').category).toBe('props');
  });

  it('declares every starter asset that ships in raw-assets', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    for (const assetId of [
      'tree_pine_01',
      'tree_pine_02',
      'tree_oak_01',
      'rock_boulder_01',
      'rock_shard_01',
      'building_hut_01',
      'enemy_goblin_01',
      'prop_barrel_01',
      'prop_crate_01',
      'prop_fence_01',
    ]) {
      expect(metadata.get(assetId).declared, `${assetId} should be declared`).toBe(true);
    }
  });
});

describe('audio ingest', () => {
  /** A pure tone, at a known amplitude, so every measurement below has an expected answer. */
  function tone(amplitude: number, seconds = 0.1, sampleRate = 44_100): DecodedAudio {
    const count = Math.floor(seconds * sampleRate);
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude;
    }
    return { sampleRate, channels: 1, samples };
  }

  it('round-trips a WAV through encode and decode', () => {
    const original = tone(0.5, 0.05);
    const decoded = decodeWav(encodeWav(original));

    expect(decoded.sampleRate).toBe(44_100);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(original.samples.length);
    // 16-bit quantisation, so exact equality is the wrong assertion.
    for (let index = 0; index < original.samples.length; index += 100) {
      expect(decoded.samples[index]).toBeCloseTo(original.samples[index]!, 3);
    }
  });

  it('rejects something that is not a WAV rather than producing noise', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a readable WAV/);
    expect(() => decodeWav(new TextEncoder().encode('RIFF....NOTAWAVE'))).toThrow(/WAVE/);
  });

  it('walks chunks rather than assuming the data starts at byte 44', () => {
    // Real encoders interleave LIST and fact chunks; a decoder that assumed a fixed offset works
    // on exactly the files it was written against and nothing else.
    const plain = encodeWav(tone(0.5, 0.01));
    const extra = new TextEncoder().encode('LIST');
    const padded = new Uint8Array(plain.length + 12);
    padded.set(plain.subarray(0, 36), 0);
    padded.set(extra, 36);
    new DataView(padded.buffer).setUint32(40, 4, true);
    padded.set(new TextEncoder().encode('INFO'), 44);
    padded.set(plain.subarray(36), 48);
    // The RIFF size field has to grow with the file.
    new DataView(padded.buffer).setUint32(4, padded.length - 8, true);

    expect(decodeWav(padded).samples.length).toBe(decodeWav(plain).samples.length);
  });

  it('measures RMS and peak in dBFS', () => {
    const { rmsDb, peakDb } = measureLoudness(tone(1).samples);

    // A full-scale sine is -3.01 dBFS RMS and 0 dBFS peak. Those are the textbook numbers, which
    // is exactly why they make a good assertion.
    expect(rmsDb).toBeCloseTo(-3.01, 1);
    expect(peakDb).toBeCloseTo(0, 1);
  });

  it('levels a quiet clip up towards the target', () => {
    const quiet = tone(0.02);
    const { audio, gainDb } = levelLoudness(quiet);

    expect(gainDb).toBeGreaterThan(0);
    expect(measureLoudness(audio.samples).rmsDb).toBeCloseTo(TARGET_RMS_DB, 1);
  });

  it('levels a loud clip down', () => {
    const { audio, gainDb } = levelLoudness(tone(1));

    expect(gainDb).toBeLessThan(0);
    expect(measureLoudness(audio.samples).rmsDb).toBeCloseTo(TARGET_RMS_DB, 1);
  });

  it('stops short of the target rather than clipping a peaky clip', () => {
    // A clip whose RMS is far below its peak — one spike in silence. Levelling it to the target by
    // RMS alone would push the spike past full scale, which is audible distortion.
    const samples = new Float32Array(44_100);
    samples[0] = 0.95;
    const { audio } = levelLoudness({ sampleRate: 44_100, channels: 1, samples });

    const after = measureLoudness(audio.samples);
    expect(after.peakDb).toBeLessThanOrEqual(PEAK_CEILING_DB + 0.01);
    expect(after.rmsDb).toBeLessThan(TARGET_RMS_DB);
  });

  it('leaves silence alone rather than dividing by zero', () => {
    const silence = { sampleRate: 44_100, channels: 1, samples: new Float32Array(1000) };
    const { gainDb, audio } = levelLoudness(silence);

    expect(gainDb).toBe(0);
    expect(audio.samples.every((sample) => sample === 0)).toBe(true);
  });

  it('clamps on encode, so an over-unity sample is quiet rather than a click', () => {
    // Without the clamp, a sample above 1 wraps to a large negative integer — the loudest possible
    // click rather than the loudest possible sound.
    const hot = { sampleRate: 44_100, channels: 1, samples: new Float32Array([2, -2, 0]) };
    const decoded = decodeWav(encodeWav(hot));

    expect(decoded.samples[0]).toBeCloseTo(1, 2);
    expect(decoded.samples[1]).toBeCloseTo(-1, 2);
  });

  it('reports duration from the sample count', () => {
    expect(durationSeconds(tone(0.5, 2.5))).toBeCloseTo(2.5, 3);
  });

  it('recognises the formats the step handles', () => {
    expect(isAudioFile('music.wav')).toBe(true);
    expect(isAudioFile('SHOUT.OGG')).toBe(true);
    expect(isAudioFile('model.glb')).toBe(false);
  });
});

/**
 * Sprint 37 — every shipped asset says where it came from and on what terms.
 *
 * The sprint plan asks to "confirm licensing terms are clear and correctly attached per asset" as
 * groundwork for a marketplace. Confirming it once by reading the file is how it was wrong in the
 * first place: at the start of this sprint **not one of the twenty shipped assets had a licence
 * recorded**, so every exported game wrote a CREDITS.md that said "licence not recorded" twenty
 * times — which reads like stripped attribution to whoever made the art and like a bug to whoever
 * shipped the game.
 *
 * Asserted against the *declared metadata* rather than the generated manifest, so it fails at the
 * moment somebody adds an asset rather than after an ingest run somebody may not have done.
 */
describe('asset attribution', () => {
  it('records a licence, an author and an origin for every declared asset', async () => {
    const lookup = await readAssetMetadata(metadataFile);
    const declared = await readDeclaredIds();

    const gaps: string[] = [];
    for (const assetId of declared) {
      const metadata = lookup.get(assetId);
      if (!metadata.license) gaps.push(`${assetId}: no licence`);
      if (!metadata.author) gaps.push(`${assetId}: no author`);
      if (!metadata.origin) gaps.push(`${assetId}: no origin`);
    }

    expect(gaps).toEqual([]);
  });

  it('marks everything shipped in this repository as first-party', async () => {
    const lookup = await readAssetMetadata(metadataFile);
    const declared = await readDeclaredIds();

    // Not cosmetic. `origin` is what a marketplace will filter on, and the alternative — inferring
    // ownership from whether a row has an organisation — stops being true the day somebody else
    // contributes, silently and with no schema change to notice.
    const foreign = declared.filter((id) => lookup.get(id).origin !== 'first-party');
    expect(foreign).toEqual([]);
  });
});

async function readDeclaredIds(): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const raw = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as Record<string, unknown>;
  return Object.keys(raw);
}
