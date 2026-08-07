/**
 * What a desktop build is made of, as data.
 *
 * Separated from the packaging so the decisions are testable without a 110 MB download: which files
 * are written, what the executable is called, which Electron distribution is wanted. The part that
 * needs a network and a filesystem is `package.ts`, and it is deliberately thin.
 */

/**
 * Targets a build can be produced for.
 *
 * Windows is why this exists. Linux comes free — the layout is the same folder with a different
 * binary, and it is what lets this be tested in CI, which runs on Linux.
 *
 * **macOS is deliberately absent.** The layout is not a folder but an `.app` bundle with its own
 * `Info.plist`, and since Catalina an unsigned, un-notarised bundle downloaded from the internet is
 * not merely warned about — Gatekeeper refuses to open it, with a dialog offering only "Move to
 * Bin". Producing one would be producing something that does not run. It needs an Apple Developer
 * account and a notarisation step, and that is a separate piece of work rather than another entry
 * in this list.
 */
export const PLATFORMS = ['win32-x64', 'win32-arm64', 'linux-x64'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Pinned rather than floating, and pinned to a version rather than a range.
 *
 * The Electron version decides the Chromium version, which decides what WebGL, WebAssembly and
 * pointer lock do. A game packaged today and a game packaged next month should not differ in their
 * renderer because a dependency moved underneath them — that is a bug report nobody can reproduce.
 * Bumping this is a deliberate act with a test run attached.
 */
export const ELECTRON_VERSION = '33.2.1';

export interface DesktopOptions {
  /** Shown in the title bar and used for the executable's name. */
  productName: string;
  /** Reverse-DNS identity. Windows uses it for taskbar grouping; macOS requires it. */
  appId: string;
  version: string;
  /** Painted before the first frame, so the window does not flash white. */
  backgroundColor: string;
  /** Start full-screen. Off by default: a game that seizes the display on first run is alarming. */
  fullscreen: boolean;
  platform: Platform;
}

export const DEFAULT_DESKTOP_OPTIONS: Omit<DesktopOptions, 'productName'> = {
  appId: 'com.helaengine.game',
  version: '1.0.0',
  backgroundColor: '#000000',
  fullscreen: false,
  platform: 'win32-x64',
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/**
 * A filename that survives every filesystem it will meet.
 *
 * Windows refuses `<>:"/\|?*`, refuses a trailing dot or space, and reserves a list of device names
 * that predate it — a game called `CON` produces an executable that cannot be created, with an
 * error message about the file being in use.
 */
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export function safeFileName(name: string): string {
  const cleaned = name
    // The control-character range is the point of this rule, not an accident of one: Windows
    // refuses 0x00–0x1F in a filename, and a name pasted from another program can carry them.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 64)
    .trim();
  if (!cleaned) return 'Game';
  return RESERVED.has(cleaned.toUpperCase()) ? `${cleaned} Game` : cleaned;
}

/** The executable a player double-clicks. Extension is the platform's, the name is the author's. */
export function executableName(options: Pick<DesktopOptions, 'productName' | 'platform'>): string {
  const base = safeFileName(options.productName);
  return options.platform.startsWith('win32') ? `${base}.exe` : base;
}

/** The folder the build is written into, and the name of the zip around it. */
export function buildFolderName(options: Pick<DesktopOptions, 'productName' | 'platform'>): string {
  return `${safeFileName(options.productName).replace(/ /g, '-')}-${options.platform}`;
}

/**
 * The `package.json` Electron reads to find the app.
 *
 * Minimal on purpose. Anything else in here is a field somebody has to keep true, and Electron only
 * needs three of them.
 */
export function appPackageJson(options: DesktopOptions): string {
  return `${JSON.stringify(
    {
      // npm's name rules are stricter than a filename's, and a leading or trailing hyphen is one
      // of the things it rejects — which a product name ending in punctuation produces.
      name:
        safeFileName(options.productName)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'game',
      productName: options.productName,
      version: options.version,
      main: 'main.cjs',
    },
    null,
    2,
  )}\n`;
}

/** The shell's own settings, read by `main.cjs` at startup. */
export function desktopConfigJson(options: DesktopOptions): string {
  return `${JSON.stringify(
    {
      productName: options.productName,
      appId: options.appId,
      backgroundColor: options.backgroundColor,
      fullscreen: options.fullscreen,
    },
    null,
    2,
  )}\n`;
}

/** The Electron release asset for a target, and the name it has in `SHASUMS256.txt`. */
export function electronAssetName(platform: Platform, version = ELECTRON_VERSION): string {
  return `electron-v${version}-${platform}.zip`;
}

export function electronDownloadUrl(platform: Platform, version = ELECTRON_VERSION): string {
  return `https://github.com/electron/electron/releases/download/v${version}/${electronAssetName(platform, version)}`;
}

export function electronChecksumUrl(version = ELECTRON_VERSION): string {
  return `https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`;
}

/**
 * The player-facing read-me.
 *
 * Answers the three questions a Windows player actually has, in the order they hit them: why
 * SmartScreen shouted, what to press, and where a save file went.
 */
export function desktopReadme(options: DesktopOptions): string {
  const exe = executableName(options);
  const windows = options.platform.startsWith('win32');

  return `# ${options.productName}

Double-click **${exe}** to play.

${
  windows
    ? `## Windows may warn you the first time

"Windows protected your PC" is SmartScreen. It says that about any program downloaded from the
internet that has not been signed with a paid-for certificate, which is most independent games.
Click **More info** then **Run anyway**.

`
    : ''
}## Controls

WASD moves, the mouse looks, Shift sprints, C crouches, Space jumps, click fires, R reloads,
Q swaps weapon, V changes camera, Escape pauses. **F11** toggles full screen.

## What is in this folder

Everything beside the executable belongs to the runtime and the game — the whole folder is the
game. Move it wherever you like, but move all of it; ${exe} on its own will not start.

Your game files are under \`resources/app/game/\`, exactly as they were exported. \`scene.json\` is
the level, and it is readable.

## Uninstalling

Delete the folder. Nothing was installed, nothing was written to the registry, and nothing runs at
startup.

---

Made with [HelaEngine](https://github.com/LasaKaru/helaengine). Asset credits are in
\`resources/app/game/CREDITS.md\`.
`;
}
