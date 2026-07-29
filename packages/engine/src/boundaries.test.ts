import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(engineRoot, '../../..');

/**
 * Packages the runtime must never reach for.
 *
 * This is the golden rule from GUIDE.md section 1, stated as a check rather than as a convention:
 * `/packages/engine` is plain Three.js, and it runs unmodified inside an exported project where
 * none of these exist. ESLint already forbids them, but a lint config is a thing that can be
 * disabled per-line and a rule nobody has tested is a rule nobody is enforcing. This is the
 * Phase 2 wrap check the sprint plan asks for, in a form that runs every time.
 */
const FORBIDDEN = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@react-three/fiber',
  '@react-three/drei',
  'zustand',
  'immer',
  'dexie',
  '@helaengine/editor',
];

/** Test files may import test tooling; the shipped runtime may not. */
const TEST_ONLY = new Set(['vitest', 'node:fs', 'node:path', 'node:url']);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

/**
 * Strips comments, so prose cannot be mistaken for code.
 *
 * Learned the hard way: this file's own first draft flagged the phrase "separate from 'have the
 * bytes arrived'" in a doc comment as an import of a package by that name.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every module specifier a file imports, including `import type` and dynamic `import()`. */
function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const specifiers: string[] = [];

  const patterns = [
    // import … from 'x' / export … from 'x'
    /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    // import 'x' — a side-effect import with no bindings
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    // await import('x')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

const files = sourceFiles(join(engineRoot));
const runtimeFiles = files.filter((file) => !file.endsWith('.test.ts'));

describe('engine boundaries', () => {
  it('has runtime sources to check', () => {
    // A check that silently passes because it found nothing is worse than no check.
    expect(runtimeFiles.length).toBeGreaterThan(15);
  });

  it('imports nothing from React, the state layer, or the editor', () => {
    const offenders: string[] = [];

    for (const file of runtimeFiles) {
      for (const specifier of importsOf(file)) {
        const bare = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (FORBIDDEN.includes(specifier) || FORBIDDEN.includes(bare)) {
          offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never reaches outside its own package', () => {
    const offenders: string[] = [];

    for (const file of runtimeFiles) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(engineRoot)) {
          offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps its dependencies to the ones its package.json declares', () => {
    const manifest = JSON.parse(readFileSync(join(engineRoot, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const allowed = new Set(Object.keys(manifest.dependencies ?? {}));

    const offenders: string[] = [];
    for (const file of runtimeFiles) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const bare = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (!allowed.has(bare) && !TEST_ONLY.has(bare)) {
          offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }

    // A runtime dependency the manifest does not declare is a package that works in the monorepo
    // and breaks the moment the engine is published or copied into an export.
    expect(offenders).toEqual([]);
  });

  it('runs no code a document could choose', () => {
    // The closed-vocabulary promise, checked rather than asserted: nothing in the runtime turns a
    // string into executable code. Sprint 22 re-runs this against the exporter's output too.
    const offenders: string[] = [];
    const dangerous = /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]/;

    for (const file of runtimeFiles) {
      if (dangerous.test(readFileSync(file, 'utf8'))) offenders.push(relative(repoRoot, file));
    }

    expect(offenders).toEqual([]);
  });
});
