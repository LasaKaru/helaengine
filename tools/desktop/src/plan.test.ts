import { describe, expect, it } from 'vitest';
import {
  appPackageJson,
  buildFolderName,
  desktopConfigJson,
  electronAssetName,
  executableName,
  isPlatform,
  safeFileName,
  DEFAULT_DESKTOP_OPTIONS,
  type DesktopOptions,
} from './plan.js';
import { digestFor } from './runtime.js';
import { versionQuad } from './stamp.js';

const options = (overrides: Partial<DesktopOptions> = {}): DesktopOptions => ({
  ...DEFAULT_DESKTOP_OPTIONS,
  productName: 'My Game',
  ...overrides,
});

describe('safeFileName', () => {
  it('strips the characters Windows refuses in a filename', () => {
    expect(safeFileName('Doom: The <Reckoning>?')).toBe('Doom The Reckoning');
  });

  it('renames the reserved device names rather than producing a file that cannot exist', () => {
    // `CON.exe` cannot be created on Windows; the error blames the file being in use, which sends
    // whoever hits it looking in entirely the wrong place.
    expect(safeFileName('con')).toBe('con Game');
    expect(safeFileName('LPT1')).toBe('LPT1 Game');
  });

  it('refuses to end a name with a dot or a space', () => {
    expect(safeFileName('Trailing dot.')).toBe('Trailing dot');
    expect(safeFileName('Trailing space   ')).toBe('Trailing space');
  });

  it('falls back rather than producing an empty filename', () => {
    expect(safeFileName('///')).toBe('Game');
    expect(safeFileName('   ')).toBe('Game');
  });

  it('keeps a name a player would recognise intact', () => {
    expect(safeFileName('Forest Clearing')).toBe('Forest Clearing');
  });
});

describe('executableName', () => {
  it('is an .exe on Windows and bare elsewhere', () => {
    expect(executableName(options({ platform: 'win32-x64' }))).toBe('My Game.exe');
    expect(executableName(options({ platform: 'linux-x64' }))).toBe('My Game');
  });
});

describe('buildFolderName', () => {
  it('names the folder after the game and the target, without spaces', () => {
    expect(buildFolderName(options({ platform: 'win32-arm64' }))).toBe('My-Game-win32-arm64');
  });
});

describe('isPlatform', () => {
  it('accepts what is supported and rejects macOS', () => {
    expect(isPlatform('win32-x64')).toBe(true);
    expect(isPlatform('linux-x64')).toBe(true);
    // Not a typo in the list — an unsigned .app will not open at all, so producing one would be
    // producing something broken. The CLI says so rather than failing later.
    expect(isPlatform('darwin-arm64')).toBe(false);
  });
});

describe('appPackageJson', () => {
  it('points Electron at the shell and carries a name npm would accept', () => {
    const parsed = JSON.parse(appPackageJson(options({ productName: 'My Game!' }))) as {
      name: string;
      main: string;
      productName: string;
    };
    expect(parsed.main).toBe('main.cjs');
    expect(parsed.name).toBe('my-game');
    expect(parsed.productName).toBe('My Game!');
  });
});

describe('desktopConfigJson', () => {
  it('carries exactly what the shell reads', () => {
    const parsed = JSON.parse(
      desktopConfigJson(options({ fullscreen: true, backgroundColor: '#123456' })),
    ) as Record<string, unknown>;
    expect(parsed).toEqual({
      productName: 'My Game',
      appId: DEFAULT_DESKTOP_OPTIONS.appId,
      backgroundColor: '#123456',
      fullscreen: true,
    });
  });
});

describe('digestFor', () => {
  // The real file uses two spaces and a `*` for binary mode. A parser that only handled one
  // whitespace layout would silently find no digest, and the download would go unverified.
  const shasums = [
    'aaaa0000000000000000000000000000000000000000000000000000000000aa *electron-v33.2.1-linux-x64.zip',
    'bbbb0000000000000000000000000000000000000000000000000000000000bb *electron-v33.2.1-win32-x64.zip',
  ].join('\n');

  it('finds the digest for the asset being downloaded', () => {
    expect(digestFor(shasums, 'electron-v33.2.1-win32-x64.zip')).toBe(
      'bbbb0000000000000000000000000000000000000000000000000000000000bb',
    );
  });

  it('does not match a different asset whose name is a prefix', () => {
    expect(digestFor(shasums, 'electron-v33.2.1-win32')).toBeNull();
  });

  it('returns null when the asset is absent rather than guessing', () => {
    expect(digestFor(shasums, 'electron-v33.2.1-darwin-arm64.zip')).toBeNull();
  });
});

describe('versionQuad', () => {
  it('pads a semver to the four parts Windows wants', () => {
    expect(versionQuad('1.2.3')).toEqual([1, 2, 3, 0]);
  });

  it('drops a prerelease suffix rather than mining it for a build number', () => {
    // Taking the 4 out of `beta.4` would make the beta sort *above* the release it precedes.
    expect(versionQuad('2.0.0-beta.4')).toEqual([2, 0, 0, 0]);
  });

  it('clamps out-of-range parts, which a version resource cannot hold', () => {
    expect(versionQuad('99999.1.1')).toEqual([65535, 1, 1, 0]);
  });

  it('survives something that is not a version at all', () => {
    expect(versionQuad('nightly')).toEqual([0, 0, 0, 0]);
  });
});

describe('electronAssetName', () => {
  it('matches the name in the release, which is what the checksum is keyed on', () => {
    expect(electronAssetName('win32-x64', '33.2.1')).toBe('electron-v33.2.1-win32-x64.zip');
  });
});
