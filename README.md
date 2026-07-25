# HelaEngine

A low-poly game world builder: a browser editor that produces a scene document, a framework-free
runtime that renders it, and an exporter that hands the user a standalone, runnable project.

It is **not** an LLM that writes games. It is a schema-driven engine — the editor writes
`scene.json`, the runtime reads it, the exporter packages it, and the same runtime code runs in
both places, unmodified. Every architectural decision in this repo follows from that.

**Status:** Sprint 2 (Phase 0 — Foundations). The engine, scene schema and asset pipeline are in
place; there is no editor and no backend yet, deliberately.

---

## Quick start

```bash
pnpm install
pnpm ingest-assets   # compress raw-assets/ -> apps/demo/public/assets/
pnpm demo            # -> http://localhost:5173
```

`ingest-assets` has to run before the demo shows models: the compressed GLBs, thumbnails and
`manifest.json` are generated output and are not committed. The demo renders
`apps/demo/public/demo-scene.json` — a village of 15 objects drawn from 10 models.

Other commands:

```bash
pnpm lint             # includes the engine-isolation boundary rule
pnpm typecheck
pnpm test
pnpm build
pnpm generate-assets  # regenerate the stand-in raw .glb sources
```

Requires Node 20+ and pnpm 10+. Thumbnail rendering needs a Chromium that Playwright can find; set
`CHROMIUM_PATH` to point at one, or `SKIP_THUMBNAILS=1` to skip that stage.

---

## Layout

```
packages/schema        The scene + asset schema, in Zod. The contract everything else agrees on.
packages/engine        Vanilla Three.js runtime. No React, no store, no DOM assumptions in the loader.
tools/asset-pipeline   Ingest: raw GLBs in, compressed GLBs + thumbnails + manifest out.
raw-assets/            Hand-authored .glb sources. The artefacts under version control.
apps/demo              Framework-free harness rendering a scene document. Proves the engine stands alone.
apps/editor            Empty until Sprint 3 (React + react-three-fiber).
apps/api               Empty until Sprint 16 (NestJS + Postgres).
docs/                  GUIDE, DEVELOPMENT-PLAN, SPRINT, ASSET-CONVENTIONS — the plan of record.
```

## The two rules that shape the codebase

**1. The engine never imports the editor.** `packages/engine` runs inside exported projects, where
React and Zustand do not exist. An import of either breaks every export, silently and late. This is
enforced by a lint rule, not by discipline — see the `packages/engine` block in `eslint.config.js`.

**2. Every editable property has a field in the schema.** No hidden state in a component, no
gameplay value that only exists at runtime. If the editor can change it, `scene.json` records it, or
it will not survive save/load or export.

## Scene documents

`packages/schema` is the single source of truth: Zod schemas generate the TypeScript types _and_ the
runtime validators, so the editor, engine, exporter and (later) the API all validate identically.

- Rotations are stored in **degrees**; the engine converts to radians exactly once, at instantiation.
- Objects reference an `assetId`, never a file path — that indirection is what lets assets be
  recompressed, re-versioned or relocated without rewriting saved scenes.
- Documents carry a `version`, and `migrateScene()` walks a registered migration chain before
  validating. The registry is empty today; it exists so the first real migration is an addition
  rather than a retrofit across saved user projects.

## Assets

Raw `.glb` files in `raw-assets/` are the source of truth; everything under
`apps/demo/public/assets/` is generated. `pnpm ingest-assets` dedupes and welds geometry, prunes
unused data, applies Draco compression, renders a thumbnail per asset in headless Chromium, and
writes `manifest.json`. It is idempotent — re-run it whenever sources or metadata change.

`docs/ASSET-CONVENTIONS.md` is the authoring contract: metre scale, +Y up, pivot at the base, flat
shading, per-category polygon budgets, and the `category_name_variant.glb` naming rule. The pipeline
enforces what it can (budgets, pivot drift, absurd scale) and warns about the rest. When an asset
looks wrong, fix the source file — never special-case it in engine code, because every exported
project inherits engine code.

The ten starter assets are **stand-ins generated in code** (`pnpm generate-assets`), not modelled
art. They exist so the pipeline has real GLBs to chew on; Sprint 25 replaces them with commissioned
assets, and nothing downstream has to change when it does.

Texture compression (KTX2/Basis) is wired but inert: it needs `toktx` from KHRONOS KTX-Software on
PATH, and the current assets are untextured. Ingest says so rather than skipping silently.

## Where this is going

`docs/SPRINT.md` is the working backlog, sprint by sprint. In short: editor MVP (Sprints 3–8),
behaviors/physics/AI (9–12), the export system (13–15), the cloud platform (16–20), enterprise
hardening (21–24), then content and beta (25–26).

## License

MIT. See `LICENSE`.
