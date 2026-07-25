# GUIDE.md — Building an Enterprise-Grade Low-Poly Game World Builder

### (GameGuru-style: Editor + Runtime Engine + Cloud Platform + Codegen Export)

**Owner:** Lasa
**Doc purpose:** Single source of truth. Follow phase-by-phase, sprint-by-sprint. Each sprint has: goal, tasks, tech decisions, deliverables, acceptance criteria (Definition of Done). Update this file as decisions change — treat it as a living architecture decision record (ADR) + backlog.

---

## 0. Product Vision

A web platform where a user:

1. Picks/loads a **template world** or starts blank.
2. Drags premade assets (trees, buildings, enemies, props, terrain pieces) from a library onto a 3D base/terrain.
3. Transforms them (move/rotate/scale), attaches **behaviors** (patrol, chase, trigger, door, loot) via no-code property panels.
4. Saves the project to the cloud (versioned, shareable, collaborable).
5. Exports a **standalone, runnable codebase** (HTML/CSS/JS + assets + engine runtime) they can host anywhere.

This is NOT "generate a game with an LLM." It's a **structured content editor with a deterministic runtime + real code export** — same category as PlayCanvas Editor, Rogue Engine, Spline, GameGuru. That distinction drives every architecture decision below: you are building a **schema-driven engine**, not a code generator that improvises.

---

## 1. System Architecture (target end-state)

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Editor SPA)                       │
│  React + react-three-fiber + Zustand + TransformControls         │
│  - Asset Library Panel   - Scene Graph Tree   - Inspector Panel  │
│  - Behavior Editor       - Terrain Sculpt Tool - Export Wizard   │
└───────────────┬───────────────────────────────────┬─────────────┘
                │ REST/GraphQL + WebSocket           │ Signed asset URLs
                ▼                                    ▼
┌───────────────────────────────┐      ┌────────────────────────────┐
│        APPLICATION API         │      │     ASSET / CDN STORAGE     │
│  Node.js (NestJS) or Go        │      │  S3/R2 + CloudFront/Cloudflare│
│  - Auth (OIDC/JWT)              │      │  glTF/GLB + Draco/KTX2       │
│  - Project CRUD + versioning    │      │  Thumbnails, manifests       │
│  - Collab (WS/Yjs CRDT server)  │      └────────────────────────────┘
│  - Export job orchestration     │
│  - Billing/licensing (if SaaS)  │
└───────────────┬─────────────────┘
                │
                ▼
┌───────────────────────────────┐      ┌────────────────────────────┐
│        POSTGRES (primary DB)   │      │   EXPORT WORKER (queue)     │
│  users, orgs, projects,        │      │  BullMQ/Sidekiq-style job    │
│  scene_versions (JSONB),       │      │  Bundles runtime+assets+json │
│  assets, licenses, audit_log   │      │  → zip → signed download URL │
└───────────────────────────────┘      └────────────────────────────┘

Runtime (shared code, used BOTH inside editor preview AND in exported project):
  /engine  → framework-agnostic, plain Three.js. No React. This is the actual "engine."
```

**Golden rule:** The editor (React/r3f) is a _tool that produces scene.json_. The **engine** (`/engine`) is a _plain vanilla Three.js library_ that consumes scene.json — inside the editor's preview iframe AND inside every exported project, unmodified. Never let gameplay logic live only in React. If you do, you can't export it.

---

## 2. Core Tech Stack (final decisions)

| Layer              | Choice                                                                            | Why                                                                                        |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Engine runtime     | Vanilla Three.js (ES modules, no framework)                                       | Must run standalone in exported projects with zero build step                              |
| Editor UI          | React + react-three-fiber + drei                                                  | Fast iteration, huge ecosystem, TransformControls/gizmos built-in                          |
| Editor state       | Zustand + Immer                                                                   | Simple, serializable, easy undo/redo middleware                                            |
| Collaboration CRDT | Yjs + y-websocket (or Liveblocks if you don't want to run infra)                  | Real-time multi-user scene editing, enterprise ask #1                                      |
| Physics            | Rapier (via `@dimforge/rapier3d-compat`, WASM)                                    | Fast, deterministic, works in browser + export, better than cannon-es for enterprise scale |
| AI/steering        | Yuka.js                                                                           | Lightweight FSM + steering behaviors for enemies, no full engine needed                    |
| Asset format       | glTF 2.0 / GLB, Draco geometry + KTX2/Basis textures                              | Industry standard, Three.js-native, compressed                                             |
| Asset processing   | gltf-transform (Node CLI) pipeline                                                | Automates compression/optimization on ingest                                               |
| Backend API        | NestJS (TypeScript)                                                               | Enterprise-familiar (DI, modules, guards), same language as engine/editor                  |
| Database           | PostgreSQL (JSONB for scene documents) + Prisma ORM                               | Relational integrity for orgs/users/billing, JSONB for flexible scene schema               |
| Object storage     | Cloudflare R2 or AWS S3 + CDN                                                     | Asset + export artifact storage                                                            |
| Auth               | Auth0 / Clerk / self-hosted Keycloak (OIDC)                                       | SSO/SAML for enterprise customers, MFA                                                     |
| Queue/jobs         | BullMQ (Redis)                                                                    | Export bundling, thumbnail generation, asset transcoding                                   |
| Infra              | Docker + Kubernetes (or ECS if you want less ops)                                 | Standard enterprise deployment target                                                      |
| IaC                | Terraform                                                                         | Reproducible environments (dev/staging/prod)                                               |
| CI/CD              | GitHub Actions                                                                    | Build, test, lint, deploy pipelines                                                        |
| Observability      | OpenTelemetry + Grafana/Loki/Tempo (or Datadog if budget allows)                  | Enterprise SLA requires tracing/metrics/logs                                               |
| Error tracking     | Sentry                                                                            | Client + server                                                                            |
| Testing            | Vitest (unit), Playwright (e2e editor flows), visual regression (Percy/Chromatic) | 3D UI needs visual regression, not just logic tests                                        |
| Feature flags      | Unleash or LaunchDarkly                                                           | Enterprise rollout control                                                                 |
| API contract       | OpenAPI (REST) or GraphQL schema                                                  | Versioned public API for future integrations                                               |

---

## 3. Scene Schema (design this before writing any code)

This JSON schema is the spine of the entire product — the editor writes it, the runtime reads it, the exporter packages it, the DB stores it, the collab layer syncs it.

```json
{
  "sceneId": "uuid",
  "version": "1.0.0",
  "engineVersion": "1.4.2",
  "terrain": {
    "type": "heightmap | flat | tiled",
    "size": [256, 256],
    "heightmapUrl": "assets/terrain/height_01.png",
    "material": { "textureSet": "grass_rock_01" }
  },
  "environment": {
    "skybox": "sunset_01",
    "fog": { "color": "#a0c8ff", "near": 20, "far": 400 },
    "lighting": { "sun": { "intensity": 1.2, "angle": 45 }, "ambient": 0.4 }
  },
  "objects": [
    {
      "id": "obj_0001",
      "assetId": "tree_pine_02",
      "transform": { "position": [10,0,-4], "rotation": [0,45,0], "scale": [1,1,1] },
      "behaviors": [],
      "colliderType": "capsule",
      "metadata": { "layer": "foliage" }
    },
    {
      "id": "obj_0002",
      "assetId": "enemy_goblin_01",
      "transform": { "position": [0,0,5], "rotation": [0,0,0], "scale": [1,1,1] },
      "behaviors": [
        { "type": "patrol", "params": { "waypoints": [[0,0,5],[5,0,5],[5,0,10]], "speed": 2 } },
        { "type": "chaseOnSight", "params": { "range": 8, "damage": 10 } }
      ]
    }
  ],
  "triggers": [
    { "id": "trg_0001", "shape": "box", "transform": {...}, "onEnter": { "type": "loadScene", "params": { "target": "level_02.json" } } }
  ]
}
```

**Rules to enforce from day one:**

- Every editable property in the UI must have a 1:1 field in this schema — no hidden state.
- `assetId` references the **asset manifest**, never a raw file path (indirection lets you re-version/optimize assets later).
- `behaviors` is a fixed, closed vocabulary (a plugin registry), not free-form script — this is what keeps export deterministic and safe (no arbitrary user code execution problem).
- Schema is versioned (`version` field) with a migration function registry (`migrateV1toV2(scene)`), because enterprise customers will have old projects you must not break.

---

## 4. Team & Roles (assume you're scaling from solo → small team)

Even if starting solo, structure work as if these lanes exist — makes future hiring/parallelization trivial:

- **Engine/runtime** (vanilla Three.js, physics, AI, exporter)
- **Editor/UI** (React, r3f, UX)
- **Platform/backend** (API, auth, DB, billing, collab server)
- **DevOps/infra** (CI/CD, k8s, observability)
- **Content/asset pipeline** (modeling, compression, manifest tooling)
- **QA/automation**

---

## 5. Sprint Plan (2-week sprints, ~26 sprints ≈ 12 months to enterprise-grade v1)

### PHASE 0 — Foundations (Sprints 1–2)

**Sprint 1: Repo, schema, and engine skeleton**

- [x] Monorepo setup (Turborepo or Nx): `/apps/editor`, `/packages/engine`, `/apps/api`, `/packages/schema`
- [x] Define scene.json schema formally using **Zod** (single source of truth — generates both TS types and runtime validators)
- [x] `/packages/engine`: bare Three.js loader that takes scene.json and renders terrain + static objects (no editor yet)
- [x] CI: lint + typecheck + unit test pipeline on PR (GitHub Actions)
- **DoD:** `npm run demo` renders a hardcoded scene.json with 3 trees and a terrain plane, in a plain HTML page, zero React.

**Sprint 2: Asset pipeline v0**

- [x] Blender → GLB export convention/checklist doc (naming, scale, pivot at origin, LOD tiers)
- [x] `gltf-transform` ingest script: Draco compress geometry, KTX2 compress textures, output manifest entry
- [x] Asset manifest schema (Zod) + local JSON manifest file with 10 starter assets (trees, rocks, 1 building, 1 enemy)
- [x] Thumbnail generation script (headless Three.js render → PNG)
- **DoD:** Running `pnpm ingest-assets` on a folder of GLBs produces compressed GLBs + manifest.json + thumbnails automatically.

---

### PHASE 1 — Core Editor MVP (Sprints 3–8)

**Sprint 3: Editor shell + viewport**

- [x] React app scaffold, r3f Canvas, OrbitControls, grid helper, basic lighting rig
- [x] Zustand store: `sceneStore` mirroring the scene.json schema exactly
- [x] Render loop reads `sceneStore.objects` and instantiates via `/packages/engine` loader (proves editor and runtime share code)
- **DoD:** Empty scene renders in browser; store can be mutated from Redux devtools and viewport updates live.

**Sprint 4: Asset library panel + drag-drop placement**

- [ ] Asset panel UI: category tabs, search, thumbnail grid (virtualized list — react-window, for hundreds of assets)
- [ ] Drag from panel → raycast against terrain on drop → snap to surface → push new object into `sceneStore`
- [ ] Ghost/preview mesh while dragging
- **DoD:** User can drag 5 different asset types onto terrain and see them appear correctly oriented to surface normal.

**Sprint 5: Transform gizmos + inspector**

- [ ] `TransformControls` (drei) wired to selected object; move/rotate/scale modes with keybinds (G/R/S like Blender, or W/E/R like Unity — pick one, document it)
- [ ] Inspector side panel: numeric transform fields, snap-to-grid toggle, duplicate/delete
- [ ] Multi-select (marquee + shift-click) and group transform
- **DoD:** Full parity with "basic editor" expectation — place, select, transform, delete, duplicate all work with mouse + keyboard.

**Sprint 6: Undo/redo + scene graph tree**

- [ ] Command pattern middleware on Zustand (every mutation = invertible command) — do NOT use naive full-state snapshots at scale; use command diffs
- [ ] Hierarchical scene graph panel (tree view), parent/child nesting (e.g., props attached to a building)
- [ ] Keyboard shortcuts standardized (Ctrl+Z/Y, Ctrl+D duplicate, Del)
- **DoD:** 50+ consecutive undo/redo operations work without state corruption; scene tree reflects nesting correctly.

**Sprint 7: Terrain tools**

- [ ] Heightmap sculpt brush (raise/lower/smooth/flatten) using a canvas-based heightmap texture, GPU displacement shader
- [ ] Terrain texture painting (splat map: grass/rock/sand blend)
- [ ] Terrain size/resolution config on new-project creation
- **DoD:** User can sculpt a hill and paint texture blends, terrain persists correctly in scene.json.

**Sprint 8: Save/load (local first, no backend yet)**

- [ ] Local save/load to IndexedDB (Dexie.js) so early testing doesn't need backend
- [ ] Scene schema validation on load (Zod) with migration hook stub
- [ ] "New project from template" flow using 2–3 hand-built starter scenes
- **DoD:** Close browser, reopen, project auto-restores from IndexedDB. Template picker loads a real starter scene.

---

### PHASE 2 — Behaviors, Physics, AI (Sprints 9–12)

**Sprint 9: Behavior system architecture**

- [ ] Behavior plugin registry in `/packages/engine`: `registerBehavior('patrol', PatrolBehavior)`
- [ ] Each behavior = class with `onInit(obj, params)`, `onUpdate(obj, dt)`, `onEvent(obj, evt)`
- [ ] Editor: "Add Behavior" dropdown on inspector, dynamic property form generated from a JSON-schema-per-behavior (so new behaviors auto-generate UI, no manual form coding per type)
- **DoD:** Attaching "patrol" to an object in the editor produces correct waypoint movement in the live preview, and the exact same behavior code runs identically outside React.

**Sprint 10: Physics integration (Rapier)**

- [ ] Rapier WASM world synced to Three.js scene; collider types (box/capsule/mesh) assignable per asset in manifest defaults
- [ ] Gravity, static vs dynamic bodies, simple character controller for "player" template object
- **DoD:** Enemy with patrol behavior collides with terrain and static props correctly; player-controlled capsule can walk around without falling through terrain.

**Sprint 11: Enemy AI (Yuka.js) + triggers**

- [ ] Yuka steering behaviors wired into engine tick loop (seek/flee/pursue/wander)
- [ ] FSM per enemy type (idle → patrol → chase → attack → dead)
- [ ] Trigger volumes (box/sphere) with onEnter/onExit events wired to a small event bus (door open, scene transition, spawn wave)
- **DoD:** Placing an enemy + a trigger volume in editor produces working "enemy chases player when trigger entered" behavior in preview.

**Sprint 12: Behavior QA + performance pass**

- [ ] Object pooling for frequently spawned things (projectiles, particles)
- [ ] Instanced rendering (`InstancedMesh`) for repeated static assets (trees/rocks) — critical for scenes with hundreds of props
- [ ] Frustum culling + basic LOD swapping by distance
- **DoD:** A test scene with 500 trees + 20 enemies with active AI holds 60fps on mid-tier hardware (define target: e.g., GTX 1660 / M1 equivalent).

---

### PHASE 3 — Export System (Sprints 13–15)

**Sprint 13: Static export (no behaviors)**

- [ ] Export wizard UI: choose options (compress assets further? include source scene.json? minify?)
- [ ] Bundler: copies `/packages/engine` (built, versioned) + user's scene.json + referenced assets only (tree-shake unused manifest entries) into a folder structure
- [ ] Client-side zip via JSZip, or server-side job for large projects (queue if > threshold size)
- **DoD:** Exported zip, when unzipped and opened via `index.html` (or `npx serve`), renders the identical static scene the editor showed.

**Sprint 14: Full behavior export + readability layer**

- [ ] Ensure exported `/engine` includes all behavior/physics/AI code needed (tree-shaken to only behaviors actually used in this scene)
- [ ] Optional "readable code" mode: template pass (EJS) that emits human-readable `main.js` calling engine APIs explicitly per object, instead of pure JSON-driven load — good for users who want to hand-edit after export
- [ ] Licensing/attribution file auto-generated (asset credits, engine license, user's own license choice)
- **DoD:** Exported project with enemies/physics/triggers runs identically to in-editor preview, standalone, offline, no build step required (plain `<script type="module">`).

**Sprint 15: Export hardening + cross-browser QA**

- [ ] Playwright test: automated "create scene → export → serve export → visually diff against editor preview" pipeline
- [ ] Test exported bundle in Chrome/Firefox/Safari/Edge, and on a throttled connection (asset loading spinners, error states)
- [ ] Size budgets + warnings (e.g., "your export is 180MB, consider more compression")
- **DoD:** Automated visual regression suite passes on 5 template scenes' exports across 4 browsers.

---

### PHASE 4 — Backend Platform (Sprints 16–20)

**Sprint 16: Auth + multi-tenancy**

- [ ] NestJS API scaffold, Postgres + Prisma schema: `User, Organization, Membership, Project, SceneVersion, Asset, License`
- [ ] Auth via Auth0/Clerk (OIDC), org-based RBAC (owner/editor/viewer roles per project)
- [ ] SSO/SAML stub for future enterprise customers (even if not fully wired, design DB/role model for it now)
- **DoD:** Users can sign up, create an org, invite a teammate with a role, and role gates API access correctly (tested with integration tests).

**Sprint 17: Project CRUD + cloud save**

- [ ] `POST/GET/PUT /projects`, scene stored as JSONB `SceneVersion` rows (append-only — every save = new version row, not overwrite) → gives you free version history
- [ ] Autosave (debounced) from editor to backend; conflict detection (optimistic concurrency via version number)
- [ ] Project listing/dashboard UI (replacing local-only IndexedDB flow from Sprint 8 — migrate local-first data to cloud once backend exists)
- **DoD:** User can save from browser A, load same project on browser B, see identical state. Version history list shows last 20 saves with timestamps and restore option.

**Sprint 18: Asset storage + CDN pipeline**

- [ ] S3/R2 bucket structure: `/orgs/{orgId}/assets/{assetId}/...`, signed upload URLs, backend-triggered ingest job (Sprint 2's script now runs as a queued worker, not local CLI)
- [ ] Custom asset upload flow for premium/enterprise tier (bring-your-own-GLB)
- [ ] CDN in front of asset bucket, cache headers, versioned asset URLs (immutable caching)
- **DoD:** User uploads a custom GLB, it's auto-compressed/thumbnailed within seconds via background job, and appears in their private asset library.

**Sprint 19: Real-time collaboration**

- [ ] Yjs document mirroring the scene schema; y-websocket server (or Liveblocks managed service to save infra time)
- [ ] Presence (cursors/selection highlight per collaborator), awareness API
- [ ] Conflict-free merge of simultaneous transform edits (this is why CRDT over naive last-write-wins)
- **DoD:** Two browser tabs (different users) editing the same project see each other's cursor, selection, and object edits live within <200ms, with no data loss on simultaneous edits.

**Sprint 20: Export job orchestration at scale**

- [ ] Move export bundling to BullMQ worker (Sprint 13–14 logic, now server-side for large/enterprise projects)
- [ ] Progress websocket/polling for export job status, signed download URL on completion, auto-expiry
- [ ] Rate limiting + quota enforcement per plan tier
- **DoD:** A 300MB project export completes as a background job with progress bar, doesn't block the editor UI, and produces a time-limited signed download link.

---

### PHASE 5 — Enterprise Hardening (Sprints 21–24)

**Sprint 21: Observability + SRE basics**

- [ ] OpenTelemetry instrumentation across API + workers; Grafana dashboards (latency, error rate, queue depth)
- [ ] Sentry on both editor client and API
- [ ] Structured logging + correlation IDs across request → job → export lifecycle
- **DoD:** You can trace a single export request from HTTP call → queue → worker → S3 upload → user notification, end to end, in one dashboard.

**Sprint 22: Security & compliance pass**

- [ ] Dependency scanning (Dependabot/Snyk), SAST in CI
- [ ] Signed URL expiry audit, S3 bucket policy audit, CORS lockdown
- [ ] Behavior sandboxing review — reconfirm no user input ever reaches `eval`/`Function()` (your closed behavior vocabulary from Sprint 9 should make this a non-issue; verify it)
- [ ] Basic SOC2-readiness checklist (audit logging on project access/changes, data retention policy doc)
- **DoD:** Pen-test checklist (OWASP Top 10 relevant items) run against staging with no critical findings.

**Sprint 23: Billing & plan tiers**

- [ ] Stripe integration: Free / Pro / Enterprise tiers (asset upload limits, export size limits, seat counts, collab session limits)
- [ ] Usage metering (exports/month, storage used, active seats) feeding into Postgres for billing reconciliation
- **DoD:** Upgrading/downgrading a plan correctly gates features (test: free-tier user blocked from custom asset upload, sees upgrade prompt).

**Sprint 24: Performance & load testing**

- [ ] k6 or Artillery load tests against API (target concurrent editors, export throughput)
- [ ] Editor performance budget audit (bundle size, Three.js draw calls, memory leaks on long sessions — use Chrome perf/memory profiler on a 2-hour editing session)
- [ ] CDN cache hit-rate tuning for asset delivery
- **DoD:** API sustains target concurrent load (define number, e.g., 500 concurrent editing sessions) with p95 latency under agreed SLA (e.g., 300ms for CRUD ops).

---

### PHASE 6 — Content, Polish, Launch (Sprints 25–26+)

**Sprint 25: Template & asset library expansion**

- [ ] Commission/produce 50–100 production-quality low-poly assets across categories (trees, rocks, buildings, enemies, props, terrain sets)
- [ ] 5–10 polished starter templates (village, dungeon, island, forest, arena) showcasing full feature set
- [ ] Asset marketplace groundwork if you want third-party creators later (license model, revenue share schema in DB already — Sprint 16's `License` table)
- **DoD:** New user can go from signup → pick template → make meaningful edits → export in under 10 minutes (usability test with 5 real users, not just internal team).

**Sprint 26: Docs, onboarding, beta launch**

- [ ] Public docs site (engine API reference, behavior reference, export guide) — Docusaurus or similar
- [ ] In-app onboarding tour, sample video walkthroughs
- [ ] Closed beta → gather usage analytics (PostHog/Amplitude) → triage top friction points
- **DoD:** Beta cohort of 20–50 users completes onboarding without support tickets on the top 3 flows (create, edit, export).

---

## 6. Ongoing (every sprint, not a phase)

- [ ] Write/maintain automated tests alongside features, not after (unit for engine/behaviors, integration for API, e2e for critical editor flows)
- [ ] Update this GUIDE.md when architecture decisions change — it is the ADR log
- [ ] Weekly perf smoke test on a "stress scene" (500+ objects) to catch regressions early
- [ ] Keep `/packages/engine` versioned independently (semver) — exported projects should pin an engine version so old exports never silently break

---

## 7. Key Risks to Watch

1. **React leaking into gameplay logic.** If any behavior/physics/AI code imports React or Zustand directly, your export breaks. Enforce via lint rule/ESLint boundary (e.g., `eslint-plugin-boundaries`) preventing `/packages/engine` from importing anything from `/apps/editor`.
2. **Scene schema churn without migrations.** Once real users have saved projects, every schema change needs a migration function — never a breaking change without one.
3. **Asset licensing.** If you use any third-party low-poly asset packs for speed, verify redistribution rights before letting users export them in their own downloadable projects — enterprise customers will ask about this.
4. **Underestimating export edge cases.** Circular parent/child references, missing assets, very large heightmaps — build the Playwright export-diff suite (Sprint 15) early, not at the end.
5. **Real-time collab complexity.** Yjs/CRDT is not trivial — budget real time for it (Sprint 19 alone may run long); a simpler "locking" model (one editor at a time per project) is an acceptable v1 fallback if timeline is tight.

---

## 8. Immediate Next Action

Start **Sprint 1** today: scaffold the monorepo, define the Zod scene schema, and get a hardcoded scene.json rendering via plain Three.js with zero React involved. Everything else builds on that foundation being clean.
