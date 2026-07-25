# HelaEngine

A low-poly game world builder: a browser editor that produces a scene document, a framework-free
runtime that renders it, and an exporter that hands the user a standalone, runnable project.

It is **not** an LLM that writes games. It is a schema-driven engine — the editor writes
`scene.json`, the runtime reads it, the exporter packages it, and the same runtime code runs in
both places, unmodified. Every architectural decision in this repo follows from that.

**Status:** Sprint 1 (Phase 0 — Foundations). Engine skeleton and scene schema are in place; there
is no editor and no backend yet, deliberately.

---

## Quick start

```bash
pnpm install
pnpm demo        # → http://localhost:5173
```

The demo page renders `apps/demo/public/demo-scene.json` — a hut, four trees, two boulders and a
goblin, as placeholder boxes sized from the asset manifest. Real GLB models replace the boxes in
Sprint 2; nothing else about the pipeline changes when they do.

Other commands:

```bash
pnpm lint        # includes the engine-isolation boundary rule
pnpm typecheck
pnpm test
pnpm build
```

Requires Node 20+ and pnpm 10+.

---

## Layout

```
packages/schema   The scene + asset schema, in Zod. The contract everything else agrees on.
packages/engine   Vanilla Three.js runtime. No React, no store, no DOM assumptions in the loader.
apps/demo         Framework-free harness that renders a scene document. Proves the engine stands alone.
apps/editor       Empty until Sprint 3 (React + react-three-fiber).
apps/api          Empty until Sprint 16 (NestJS + Postgres).
docs/             GUIDE, DEVELOPMENT-PLAN, SPRINT, AI-PROTOTYPE-PLAN — the living plan of record.
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

## Where this is going

`docs/SPRINT.md` is the working backlog, sprint by sprint. In short: editor MVP (Sprints 3–8),
behaviors/physics/AI (9–12), the export system (13–15), the cloud platform (16–20), enterprise
hardening (21–24), then content and beta (25–26).

## License

MIT. See `LICENSE`.
