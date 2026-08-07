import { readFile, writeFile } from 'node:fs/promises';
import * as ResEdit from 'resedit';

/**
 * Writes the game's identity into the Windows executable itself.
 *
 * Without this the file is a renamed `electron.exe`: Task Manager lists it as "Electron", the
 * Properties dialog credits the Electron project, and the icon is Electron's. None of that stops
 * the game running, and all of it tells a player they have been handed somebody else's program.
 *
 * It is done here, in pure TypeScript, rather than with the usual `rcedit.exe` — which is a Windows
 * binary and would mean this step only worked on Windows or under Wine. Packaging a Windows game
 * from Linux is the normal case for a CI pipeline, so the tool that only runs on Windows is the
 * wrong tool.
 *
 * This is **not** code signing. It changes what the file says about itself, not whether Windows
 * trusts it; SmartScreen will still warn on first run. Signing needs a certificate, and there is
 * no way to fake it — see `docs/DESKTOP-EXPORT.md`.
 */

export interface StampInput {
  path: string;
  productName: string;
  version: string;
  iconPath?: string;
}

export interface StampResult {
  warnings: string[];
}

/**
 * `1.2.3` → `[1, 2, 3, 0]`, which is the shape a Windows version resource wants.
 *
 * A prerelease suffix is dropped rather than mined for a number: `2.0.0-beta.4` is version 2.0.0,
 * and putting the `4` in the build field would make it sort above `2.0.0` itself. Each field is
 * 16 bits, so anything larger is clamped instead of wrapping to something unrelated.
 */
export function versionQuad(version: string): [number, number, number, number] {
  const release = version.split(/[-+]/)[0] ?? '';
  const parts = release.split('.').map((part) => Number.parseInt(part, 10));
  const quad = [0, 1, 2, 3].map((index) => {
    const value = parts[index];
    return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.min(value, 65535) : 0;
  });
  return quad as [number, number, number, number];
}

/**
 * An ICONDIR header: two reserved zero bytes, type 1, then a non-zero image count.
 *
 * Cheap, and it catches the mistake that actually happens — a `.png` or `.jpg` renamed to `.ico`,
 * which every image viewer on Windows will happily show and which is not an icon file.
 */
function assertLooksLikeIco(bytes: Buffer, path: string): void {
  const looksRight =
    bytes.length >= 6 &&
    bytes.readUInt16LE(0) === 0 &&
    bytes.readUInt16LE(2) === 1 &&
    bytes.readUInt16LE(4) > 0;
  if (!looksRight) throw new Error(`${path} is not a Windows icon file`);
}

export async function stampWindowsExecutable(input: StampInput): Promise<StampResult> {
  const warnings: string[] = [];
  const executable = ResEdit.NtExecutable.from(await readFile(input.path));
  const resources = ResEdit.NtExecutableResource.from(executable);

  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  if (info) {
    const quad = versionQuad(input.version);
    info.setFileVersion(...quad);
    info.setProductVersion(...quad);
    // 1033 is US English and 1200 is UTF-16 — the pair Electron's own resource already uses, so
    // this replaces those strings rather than adding a second language nothing reads.
    info.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        ProductName: input.productName,
        FileDescription: input.productName,
        InternalName: input.productName,
        OriginalFilename: `${input.productName}.exe`,
        CompanyName: '',
        LegalCopyright: '',
      },
    );
    info.outputToResourceEntries(resources.entries);
  } else {
    warnings.push('the Electron binary had no version resource to update — this is unexpected');
  }

  if (input.iconPath) {
    try {
      const bytes = await readFile(input.iconPath);
      // Checked before parsing, because `IconFile.from` does not object to a file that is not an
      // icon: handed a renamed `.png` it returns a document with no images, and replacing the
      // resource with an empty list *removes* the icon. The build then ships with no icon at all
      // and nothing said so — which is worse than the default icon and much harder to diagnose.
      assertLooksLikeIco(bytes, input.iconPath);
      const icon = ResEdit.Data.IconFile.from(bytes);
      if (icon.icons.length === 0) throw new Error('it contains no images');

      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        resources.entries,
        // Group 1, US English: the icon group Windows Explorer shows for the file. Electron ships
        // exactly one, so replacing this one replaces the icon a player sees.
        1,
        1033,
        icon.icons.map((item) => item.data),
      );
    } catch (error) {
      // A bad icon should cost the author their icon, not their build — they have a working game
      // either way, and the message says exactly what to fix.
      warnings.push(
        `could not use ${input.iconPath} as the icon (${(error as Error).message}). ` +
          'It must be a real .ico file — renaming a .png does not make one. ' +
          'The build carries the default icon instead.',
      );
    }
  }

  resources.outputResource(executable);
  await writeFile(input.path, Buffer.from(executable.generate()));
  return { warnings };
}
