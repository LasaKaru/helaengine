import { resolve } from 'node:path';
import {
  DEFAULT_DESKTOP_OPTIONS,
  ELECTRON_VERSION,
  PLATFORMS,
  isPlatform,
  type Platform,
} from './plan.js';
import { packageDesktop, readSceneName } from './package.js';

/**
 * `pnpm package-desktop <export-folder>` — turns an exported game into one somebody double-clicks.
 *
 * Takes a folder rather than a project, and that is the whole design: the thing it wraps has
 * already been through the release gate, so this step cannot introduce a broken game. It can only
 * fail to produce a build, loudly.
 */

const USAGE = `
Usage
  pnpm package-desktop <export-folder> [options]

  <export-folder>   A folder produced by Export — the one containing index.html.

Options
  --platform <id>   ${PLATFORMS.join(' | ')}   (default win32-x64)
  --name <text>     Product name. Defaults to the scene's name.
  --version <x.y.z> Version stamped into the build. (default 1.0.0)
  --icon <file.ico> Windows icon. Without one the build uses Electron's.
  --out <folder>    Where to write the build. (default ./desktop-builds)
  --app-id <id>     Reverse-DNS id. (default ${DEFAULT_DESKTOP_OPTIONS.appId})
  --fullscreen      Start full-screen.
  --offline         Fail rather than download Electron ${ELECTRON_VERSION}.

Example
  pnpm package-desktop ./my-game --name "My Game" --icon ./icon.ico
`;

/** Flags that take a value, so a positional argument is never mistaken for one. */
const VALUED = new Set(['platform', 'name', 'version', 'icon', 'out', 'app-id']);

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
  switches: Set<string>;
}

export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const switches = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!VALUED.has(name)) {
      switches.add(name);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    flags.set(name, value);
    index += 1;
  }

  return { positional, flags, switches };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log(USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const { positional, flags, switches } = parseArgs(args);
  const exportDir = positional[0];
  if (!exportDir) {
    console.error(`No export folder given.\n${USAGE}`);
    process.exit(1);
  }

  const platformArg = flags.get('platform') ?? DEFAULT_DESKTOP_OPTIONS.platform;
  if (!isPlatform(platformArg)) {
    console.error(
      `Unknown platform "${platformArg}". Supported: ${PLATFORMS.join(', ')}.\n` +
        'macOS is not supported — see docs/DESKTOP-EXPORT.md for why.',
    );
    process.exit(1);
  }
  const platform: Platform = platformArg;

  const productName = flags.get('name') ?? (await readSceneName(exportDir)) ?? 'My Game';

  const result = await packageDesktop({
    exportDir,
    outDir: flags.get('out') ?? resolve('desktop-builds'),
    platform,
    productName,
    appId: flags.get('app-id') ?? DEFAULT_DESKTOP_OPTIONS.appId,
    version: flags.get('version') ?? DEFAULT_DESKTOP_OPTIONS.version,
    backgroundColor: DEFAULT_DESKTOP_OPTIONS.backgroundColor,
    fullscreen: switches.has('fullscreen'),
    iconPath: flags.get('icon'),
    offline: switches.has('offline'),
    onProgress: (message) => console.log(message),
  });

  console.log(`\n${result.buildDir}`);
  console.log(
    `  ${formatBytes(result.totalBytes)}, double-click ${result.executable.split(/[/\\]/).pop()}`,
  );

  for (const warning of result.warnings) console.log(`  warning: ${warning}`);

  if (platform.startsWith('win32')) {
    console.log(
      '\n  Not code-signed, so Windows SmartScreen will warn on first run.\n' +
        '  README.txt in the build tells the player what to click.',
    );
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
