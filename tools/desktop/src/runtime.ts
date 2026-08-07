import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import extract from 'extract-zip';
import {
  ELECTRON_VERSION,
  electronAssetName,
  electronChecksumUrl,
  electronDownloadUrl,
  type Platform,
} from './plan.js';

/**
 * Getting the Electron distribution for a target platform, once.
 *
 * Cached outside the repository because it is 100–200 MB per platform and a `node_modules` that
 * size is one somebody deletes. Cached at all because packaging five builds should download
 * nothing after the first.
 *
 * **The checksum is not optional.** This binary becomes the executable a player double-clicks; it
 * is the single most valuable thing in the pipeline to tamper with. The digest comes from the same
 * release's `SHASUMS256.txt`, which does not remove the need to trust GitHub but does mean a
 * corrupted download, a truncated transfer or a proxy substituting a file is caught here rather
 * than shipped.
 */

export const CACHE_DIR =
  process.env.HELA_ELECTRON_CACHE ?? join(homedir(), '.cache', 'helaengine', 'electron');

export interface FetchOptions {
  platform: Platform;
  version?: string;
  /** Called with human-readable progress; the CLI prints it, the tests ignore it. */
  onProgress?: (message: string) => void;
  /** Fail instead of downloading. For environments that must not reach the network. */
  offline?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

/** The digest for one asset, from the release's own checksum file. */
export function digestFor(shasums: string, assetName: string): string | null {
  for (const line of shasums.split('\n')) {
    // `<hex>  *<name>` — the star is binary mode, and it is present for every Electron asset.
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === assetName) return match[1] as string;
  }
  return null;
}

async function download(url: string, to: string, onProgress?: (message: string) => void) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`could not download ${url} — HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastReported = 0;

  const source = Readable.fromWeb(response.body as never);
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    const megabytes = Math.floor(seen / (1024 * 1024));
    if (megabytes >= lastReported + 10) {
      lastReported = megabytes;
      onProgress?.(
        total > 0
          ? `  ${megabytes} MB of ${Math.round(total / (1024 * 1024))} MB`
          : `  ${megabytes} MB`,
      );
    }
  });

  // Written to a temporary name and renamed on success, so an interrupted download can never be
  // mistaken for a cached one on the next run.
  const partial = `${to}.partial`;
  await pipeline(source, createWriteStream(partial));
  await rename(partial, to);
}

/**
 * Returns the folder holding an unpacked Electron distribution for `platform`, fetching it first if
 * this machine has not seen it before.
 */
export async function ensureElectron(options: FetchOptions): Promise<string> {
  const version = options.version ?? ELECTRON_VERSION;
  const asset = electronAssetName(options.platform, version);
  const unpacked = join(CACHE_DIR, `v${version}`, options.platform);
  const marker = join(unpacked, '.hela-verified');

  // The marker rather than the folder: an extraction killed halfway leaves a folder that looks
  // complete and is not.
  if (await exists(marker)) return unpacked;

  if (options.offline) {
    throw new Error(
      `Electron ${version} for ${options.platform} is not cached, and --offline was given.\n` +
        `Run once without --offline, or populate ${unpacked} yourself.`,
    );
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const archive = join(CACHE_DIR, asset);

  if (!(await exists(archive))) {
    options.onProgress?.(`Downloading Electron ${version} for ${options.platform}…`);
    await download(electronDownloadUrl(options.platform, version), archive, options.onProgress);
  }

  options.onProgress?.('Verifying checksum…');
  const shasumsResponse = await fetch(electronChecksumUrl(version), { redirect: 'follow' });
  if (!shasumsResponse.ok) {
    throw new Error(`could not fetch SHASUMS256.txt — HTTP ${shasumsResponse.status}`);
  }
  const expected = digestFor(await shasumsResponse.text(), asset);
  if (!expected) throw new Error(`${asset} is not listed in the Electron ${version} checksums`);

  const actual = await sha256(archive);
  if (actual !== expected) {
    // Removed rather than left in place: a bad archive that stays cached fails identically forever
    // and looks like a bug in this tool.
    await rm(archive, { force: true });
    throw new Error(
      `checksum mismatch for ${asset}\n  expected ${expected}\n  got      ${actual}\n` +
        'The download has been deleted. If this repeats, something between you and GitHub is ' +
        'modifying it.',
    );
  }

  options.onProgress?.('Unpacking…');
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  await extract(archive, { dir: unpacked });
  await writeFile(marker, `${version} ${expected}\n`, 'utf8');

  return unpacked;
}
