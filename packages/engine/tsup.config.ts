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
    // Named rather than `/.*/`: a catch-all also matches Rapier, and `noExternal` wins over
    // `external`, so the physics engine ended up bundled anyway — two megabytes of WASM in a
    // static export that never presses Play.
    noExternal: ['three', 'zod', 'yuka', 'howler', '@helaengine/schema'],
    minify: true,
    platform: 'browser',
    // Rapier is a dynamic `import()` of a WASM package, and bundling it would pull a megabyte of
    // physics into every static export that never presses Play. Sprint 22, which exports
    // behaviours, is where that becomes worth paying for.
    external: ['@dimforge/rapier3d-compat'],
  },
]);
