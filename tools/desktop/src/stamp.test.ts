import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureElectron } from './runtime.js';
import { stampWindowsExecutable } from './stamp.js';

/**
 * Rewrites the resources of a real Windows `electron.exe` and reads them back.
 *
 * Against the real binary rather than a fixture, because the thing that can go wrong is specific to
 * it: a PE file has to be regenerated with its section table, checksums and offsets consistent, and
 * a version resource has to replace the one Electron already shipped rather than sit beside it. A
 * synthetic executable would exercise none of that.
 *
 * The assertions read UTF-16 strings out of the file. Crude, and deliberately so: it is the same
 * thing Windows Explorer does, and it cannot be satisfied by a stamp that wrote the strings into a
 * structure nothing reads.
 */

let work: string;
let exePath: string;
let ready = false;

/** See the note in `shell.test.ts`: opt-in, because it needs the Electron distribution. */
const RUN_E2E = process.env.HELA_DESKTOP_E2E === '1';

/**
 * Rewriting a 188 MB executable takes several seconds, and the default 5 s is not enough.
 *
 * Worth stating because of how it failed: the timeout killed the test *during* the write, leaving a
 * truncated `.exe` that made the next test fail with an offset error in a PE parser — which reads
 * exactly like a corruption bug in the stamping code, and is not one.
 */
const SLOW = 120_000;

/** A recognisable pixel value, so the icon can be found in the executable afterwards. */
const MARKER = Buffer.from([0x11, 0x22, 0x33, 0xff, 0x11, 0x22, 0x33, 0xff]);

/**
 * A 2x2 32-bit icon, built by hand.
 *
 * An ICONDIR header, one ICONDIRENTRY, then a BITMAPINFOHEADER whose height is doubled because an
 * icon bitmap carries a colour image and an AND mask stacked in one buffer — the detail that makes
 * a hand-written `.ico` either work or be silently rejected.
 */
function minimalIco(pixels: Buffer): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(2, 4); // width
  header.writeInt32LE(4, 8); // height: image plus mask
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel

  const mask = Buffer.alloc(8);
  const image = Buffer.concat([header, pixels, pixels, mask]);

  // ICONDIR is 6 bytes, then one 16-byte ICONDIRENTRY. The field offsets are easy to get wrong by
  // two — `colorCount` and `reserved` are single bytes before `planes` — and getting them wrong
  // produces a file that passes a header check and then fails deep inside an icon parser.
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(1, 4); // one image
  directory.writeUInt8(2, 6); // width
  directory.writeUInt8(2, 7); // height
  directory.writeUInt8(0, 8); // colour count: 0 for true colour
  directory.writeUInt8(0, 9); // reserved
  directory.writeUInt16LE(1, 10); // planes
  directory.writeUInt16LE(32, 12); // bits per pixel
  directory.writeUInt32LE(image.length, 14);
  directory.writeUInt32LE(22, 18); // offset of the image

  return Buffer.concat([directory, image]);
}

function utf16Count(bytes: Buffer, text: string): number {
  return bytes.toString('binary').split(Buffer.from(text, 'utf16le').toString('binary')).length - 1;
}

beforeAll(async () => {
  if (!RUN_E2E) return;
  const dist = await ensureElectron({ platform: 'win32-x64' });
  work = await mkdtemp(join(tmpdir(), 'hela-stamp-'));
  exePath = join(work, 'Test Game.exe');
  await copyFile(join(dist, 'electron.exe'), exePath);
  ready = true;
}, 600_000);

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

describe.runIf(RUN_E2E)('stampWindowsExecutable', () => {
  it(
    'writes the game name where Windows looks for it',
    async () => {
      expect(ready).toBe(true);

      const before = await readFile(exePath);
      expect(utf16Count(before, 'Fabulous Adventure')).toBe(0);

      const { warnings } = await stampWindowsExecutable({
        path: exePath,
        productName: 'Fabulous Adventure',
        version: '2.3.4',
      });
      expect(warnings).toEqual([]);

      const after = await readFile(exePath);
      // Product name, file description, internal name and original filename — the four fields the
      // Properties dialog and Task Manager read. Without this the game is credited to Electron.
      expect(utf16Count(after, 'Fabulous Adventure')).toBeGreaterThanOrEqual(4);
      // Still a PE executable afterwards: `MZ`, then the PE signature at the offset in the DOS stub.
      expect(after.subarray(0, 2).toString('latin1')).toBe('MZ');
      expect(
        after.subarray(after.readUInt32LE(0x3c), after.readUInt32LE(0x3c) + 4).toString('latin1'),
      ).toBe('PE\0\0');
    },
    SLOW,
  );

  it(
    'replaces the icon when given a real one',
    async () => {
      expect(ready).toBe(true);

      const iconPath = join(work, 'real.ico');
      await writeFile(iconPath, minimalIco(MARKER));

      const { warnings } = await stampWindowsExecutable({
        path: exePath,
        productName: 'Fabulous Adventure',
        version: '2.3.4',
        iconPath,
      });

      expect(warnings).toEqual([]);
      // The pixel payload is searched for by its own byte pattern. Asserting "no warnings" would
      // pass for a stamp that quietly wrote nothing, which is exactly the failure the negative test
      // below turned out to be hiding.
      expect((await readFile(exePath)).includes(MARKER)).toBe(true);
    },
    SLOW,
  );

  it(
    'keeps the build when the icon is unusable, and says why',
    async () => {
      expect(ready).toBe(true);

      const notAnIcon = join(work, 'icon.ico');
      // The commonest mistake by a distance: a PNG renamed. It is not an icon file, and losing a
      // whole build over it would be the wrong trade — the game runs fine with the default icon.
      await writeFile(notAnIcon, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));

      const { warnings } = await stampWindowsExecutable({
        path: exePath,
        productName: 'Fabulous Adventure',
        version: '2.3.4',
        iconPath: notAnIcon,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('renaming a .png does not make one');
      expect((await readFile(exePath)).subarray(0, 2).toString('latin1')).toBe('MZ');
    },
    SLOW,
  );
});
