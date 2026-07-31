import { defineConfig } from 'tsup';

/**
 * Two builds, for two different consumers.
 *
 * `index` is the library the editor and the co-op server import, with `three` left external so
 * there is exactly one copy of it in any app that also uses Three directly — two copies means two
 * `Vector3` classes and `instanceof` checks that quietly stop working.
 *
 * `runtime` is the opposite bargain, and it exists for exports. An exported project is a folder
 * somebody unzips and opens; it has no package manager, no bundler and no import map, so every
 * dependency has to already be inside the file. That makes it larger, and it makes it the only
 * form of the engine that can be handed to a person rather than to a build step.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['three'],
  },
  {
    entry: { runtime: 'src/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    // Named rather than `/.*/`, which is the difference between a bundle and a mistake: a
    // catch-all also matches Rapier, and `noExternal` wins over `external`.
    noExternal: ['three', 'zod', 'yuka', 'howler', '@helaengine/schema'],
    minify: true,
    platform: 'browser',
    // Left out: a static export renders the world and never presses Play, so two megabytes of
    // physics WASM would be dead weight in every one of them. The dynamic `import()` that reaches
    // Rapier simply never fires.
    external: ['@dimforge/rapier3d-compat'],
  },
  {
    // The same engine with Rapier inlined, for exports that actually run the game. Two files rather
    // than one file plus a chunk, because a chunk gets a content-hashed name that the exporter
    // would then have to *discover* — and the exporter runs in a browser tab, which cannot list a
    // directory. An explicit second entry is a string both sides already know.
    entry: { 'runtime-full': 'src/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    noExternal: [
      'three',
      'zod',
      'yuka',
      'howler',
      '@helaengine/schema',
      '@dimforge/rapier3d-compat',
    ],
    // Off, so the dynamically-imported physics module lands in this file instead of beside it.
    splitting: false,
    minify: true,
    platform: 'browser',
  },
]);
