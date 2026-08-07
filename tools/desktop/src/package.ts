import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appPackageJson,
  buildFolderName,
  desktopConfigJson,
  desktopReadme,
  executableName,
  type DesktopOptions,
} from './plan.js';
import { ensureElectron } from './runtime.js';
import { stampWindowsExecutable } from './stamp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Copied verbatim into `resources/app`. The whole of the desktop target's own code. */
const SHELL_FILES = ['main.cjs', 'resolve-within.cjs'];

/**
 * Files an export must contain before it is worth wrapping.
 *
 * Checked rather than assumed because the failure otherwise arrives at the very end: a 200 MB
 * build that took four minutes to assemble, opens, and shows a black window. Every one of these is
 * something `buildExport` always writes, so a folder missing one is not an export.
 */
const REQUIRED = ['index.html', 'main.js', 'scene.json', 'engine/runtime.js'];

export interface PackageResult {
  /** The folder a player receives. */
  buildDir: string;
  /** The file a player double-clicks, absolute. */
  executable: string;
  /** Uncompressed size of the whole build. */
  totalBytes: number;
  /** Things the author should know but which did not stop the build. */
  warnings: string[];
}

export interface PackageInput extends DesktopOptions {
  /** An export folder as produced by the editor's Export button. Read, never modified. */
  exportDir: string;
  /** Where the build folder is created. */
  outDir: string;
  /** A Windows `.ico`. Without one the build carries Electron's default icon. */
  iconPath?: string;
  offline?: boolean;
  onProgress?: (message: string) => void;
}

async function directorySize(path: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export async function assertIsExport(exportDir: string): Promise<void> {
  for (const file of REQUIRED) {
    try {
      await stat(join(exportDir, file));
    } catch {
      throw new Error(
        `${exportDir} does not look like a HelaEngine export — no ${file}.\n` +
          'Point this at the folder you unzipped from Export, the one containing index.html.',
      );
    }
  }
}

/**
 * Wraps an export folder in an Electron shell.
 *
 * The export is copied in **unchanged**. Nothing is rewritten, nothing is injected, no path is
 * fixed up — which is what makes the desktop build the same game as the web build rather than a
 * near-relative of it, and what means an export that passed the release gate has already been
 * tested where it counts.
 */
export async function packageDesktop(input: PackageInput): Promise<PackageResult> {
  const warnings: string[] = [];
  const exportDir = resolve(input.exportDir);
  await assertIsExport(exportDir);

  const electronDir = await ensureElectron({
    platform: input.platform,
    offline: input.offline,
    onProgress: input.onProgress,
  });

  const buildDir = join(resolve(input.outDir), buildFolderName(input));
  input.onProgress?.('Copying the Electron runtime…');
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(dirname(buildDir), { recursive: true });
  await cp(electronDir, buildDir, { recursive: true });

  // Electron's own placeholder app — the "no app loaded" window with the documentation links. It
  // is never reached once `resources/app` exists, but leaving 1 MB of unreachable UI in a shipped
  // game is untidy in a way that eventually confuses somebody reading the folder.
  await rm(join(buildDir, 'resources', 'default_app.asar'), { force: true });

  const appDir = join(buildDir, 'resources', 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, 'package.json'), appPackageJson(input), 'utf8');
  await writeFile(join(appDir, 'hela-desktop.json'), desktopConfigJson(input), 'utf8');
  for (const file of SHELL_FILES) await cp(join(HERE, 'shell', file), join(appDir, file));

  input.onProgress?.('Copying the game…');
  await cp(exportDir, join(appDir, 'game'), { recursive: true });

  // The binary is `electron` / `electron.exe` in every distribution. Renaming it is what makes the
  // taskbar, the Task Manager and the Alt-Tab list say the game's name instead of "Electron".
  const shipped = executableName(input);
  const original = join(buildDir, input.platform.startsWith('win32') ? 'electron.exe' : 'electron');
  const executable = join(buildDir, shipped);
  await rename(original, executable);

  if (input.platform.startsWith('win32')) {
    input.onProgress?.('Stamping version information…');
    const stamped = await stampWindowsExecutable({
      path: executable,
      productName: input.productName,
      version: input.version,
      iconPath: input.iconPath,
    });
    warnings.push(...stamped.warnings);
  } else if (input.iconPath) {
    warnings.push(
      `--icon was given but ${input.platform} builds take their icon from the desktop entry, not ` +
        'the binary. The file was ignored.',
    );
  }

  await writeFile(join(buildDir, 'README.txt'), desktopReadme(input), 'utf8');

  return {
    buildDir,
    executable,
    totalBytes: await directorySize(buildDir),
    warnings,
  };
}

/** Reads the exported scene's name, so `--name` can default to what the author already chose. */
export async function readSceneName(exportDir: string): Promise<string | null> {
  try {
    const scene = JSON.parse(await readFile(join(exportDir, 'scene.json'), 'utf8')) as {
      name?: unknown;
    };
    return typeof scene.name === 'string' && scene.name.trim() ? scene.name.trim() : null;
  } catch {
    return null;
  }
}
