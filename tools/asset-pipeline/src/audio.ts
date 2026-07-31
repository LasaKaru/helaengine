/**
 * Audio ingest: decode, measure, level, re-encode.
 *
 * WAV in and WAV out, and that is a deliberate limit rather than an oversight. Transcoding to a
 * compressed codec needs an encoder — ffmpeg, or a WASM build of one — and this repository has
 * neither, so the pipeline does the parts it genuinely can (format normalisation to one sample
 * rate and bit depth, and loudness levelling) and says clearly what it has not done. Claiming to
 * have produced a web-optimised Ogg while shipping a 10 MB WAV would be worse than the gap.
 *
 * Everything here is plain arithmetic over a `Uint8Array`, so it runs in Node with no native
 * dependency and is testable without a sound card.
 */

export interface DecodedAudio {
  sampleRate: number;
  channels: number;
  /** Interleaved samples in -1..1. */
  samples: Float32Array;
}

export interface LoudnessReport {
  /** Root-mean-square level in dBFS. Negative; -20 or so is a comfortable game mix. */
  rmsDb: number;
  /** Loudest single sample in dBFS. 0 is full scale, above which a sample would clip. */
  peakDb: number;
}

/** The RMS level every ingested file is levelled towards, in dBFS. */
export const TARGET_RMS_DB = -20;

/**
 * Headroom kept below full scale.
 *
 * Levelling by RMS alone can push a peaky sample past 0 dBFS, which clips audibly. The gain is
 * capped so the loudest sample lands here instead — quieter than asked for, rather than distorted.
 */
export const PEAK_CEILING_DB = -1;

class WavError extends Error {
  constructor(message: string) {
    super(`not a readable WAV file: ${message}`);
    this.name = 'WavError';
  }
}

function readAscii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/**
 * Decodes a PCM WAV file.
 *
 * Chunks are walked rather than assumed to be at fixed offsets: real encoders interleave `LIST`,
 * `fact` and other chunks between `fmt ` and `data`, and a decoder that assumed byte 44 works on
 * exactly the files it was written against and nothing else.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  if (bytes.length < 12) throw new WavError('shorter than a header');
  if (readAscii(bytes, 0, 4) !== 'RIFF') throw new WavError('missing RIFF marker');
  if (readAscii(bytes, 8, 4) !== 'WAVE') throw new WavError('missing WAVE marker');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = readAscii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;

    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, bytes.length - body);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte that is not counted in it.
    at = body + size + (size % 2);
  }

  if (dataStart < 0) throw new WavError('no data chunk');
  if (format !== 1) throw new WavError(`unsupported format ${format} (only PCM is handled)`);
  if (channels < 1 || channels > 2) throw new WavError(`unsupported channel count ${channels}`);

  const bytesPerSample = bitsPerSample / 8;
  const count = Math.floor(dataLength / bytesPerSample);
  const samples = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const offset = dataStart + index * bytesPerSample;
    if (bitsPerSample === 16) {
      samples[index] = view.getInt16(offset, true) / 32768;
    } else if (bitsPerSample === 8) {
      // 8-bit WAV is unsigned, centred on 128 — the one place the format changes its mind.
      samples[index] = (view.getUint8(offset) - 128) / 128;
    } else if (bitsPerSample === 24) {
      const low = view.getUint8(offset);
      const mid = view.getUint8(offset + 1);
      const high = view.getInt8(offset + 2);
      samples[index] = ((high << 16) | (mid << 8) | low) / 8_388_608;
    } else if (bitsPerSample === 32) {
      samples[index] = view.getInt32(offset, true) / 2_147_483_648;
    } else {
      throw new WavError(`unsupported bit depth ${bitsPerSample}`);
    }
  }

  return { sampleRate, channels, samples };
}

/** Encodes 16-bit PCM WAV — one bit depth out, whatever came in. That is the normalisation. */
export function encodeWav(audio: DecodedAudio): Uint8Array {
  const { sampleRate, channels, samples } = audio;
  const dataLength = samples.length * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);

  const ascii = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(at + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < samples.length; index += 1) {
    // Clamped before conversion: a sample above 1 would wrap to a large negative integer, which is
    // the loudest possible click rather than the loudest possible sound.
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }

  return bytes;
}

export function measureLoudness(samples: Float32Array): LoudnessReport {
  if (samples.length === 0) return { rmsDb: -Infinity, peakDb: -Infinity };

  let sumOfSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    sumOfSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }

  const rms = Math.sqrt(sumOfSquares / samples.length);
  return { rmsDb: toDb(rms), peakDb: toDb(peak) };
}

function toDb(amplitude: number): number {
  return amplitude <= 0 ? -Infinity : 20 * Math.log10(amplitude);
}

/**
 * Levels a clip towards `TARGET_RMS_DB`, without letting it clip.
 *
 * Returns the gain applied in dB, which is what the ingest log wants to print — "levelled +6.2 dB"
 * is useful, and a silently rewritten file is not.
 */
export function levelLoudness(audio: DecodedAudio): { audio: DecodedAudio; gainDb: number } {
  const { rmsDb, peakDb } = measureLoudness(audio.samples);
  if (!Number.isFinite(rmsDb)) return { audio, gainDb: 0 };

  // Whichever constraint binds first: reaching the target, or staying under the ceiling.
  const wanted = TARGET_RMS_DB - rmsDb;
  const headroom = PEAK_CEILING_DB - peakDb;
  const gainDb = Math.min(wanted, headroom);
  if (Math.abs(gainDb) < 0.05) return { audio, gainDb: 0 };

  const gain = 10 ** (gainDb / 20);
  const levelled = new Float32Array(audio.samples.length);
  for (let index = 0; index < audio.samples.length; index += 1) {
    levelled[index] = audio.samples[index]! * gain;
  }

  return {
    audio: { sampleRate: audio.sampleRate, channels: audio.channels, samples: levelled },
    gainDb,
  };
}

export function durationSeconds(audio: DecodedAudio): number {
  return audio.samples.length / audio.channels / audio.sampleRate;
}

/** Extensions the audio step recognises. Anything else in the source directory is left alone. */
export const AUDIO_EXTENSIONS = ['.wav', '.ogg', '.mp3', '.m4a'] as const;

export function isAudioFile(file: string): boolean {
  const lower = file.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
