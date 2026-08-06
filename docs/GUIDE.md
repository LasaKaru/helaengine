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

## 5. Sprint Plan (2-week sprints, ~40 sprints ≈ 19 months to enterprise-grade v1)

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

- [x] Asset panel UI: category tabs, search, thumbnail grid (virtualized list — react-window, for hundreds of assets)
- [x] Drag from panel → raycast against terrain on drop → snap to surface → push new object into `sceneStore`
- [x] Ghost/preview mesh while dragging
- **DoD:** User can drag 5 different asset types onto terrain and see them appear correctly oriented to surface normal.

**Sprint 5: Transform gizmos + inspector**

- [x] `TransformControls` (drei) wired to selected object; move/rotate/scale modes with keybinds (G/R/S like Blender, or W/E/R like Unity — pick one, document it)
- [x] Inspector side panel: numeric transform fields, snap-to-grid toggle, duplicate/delete
- [x] Multi-select (marquee + shift-click) and group transform
- **DoD:** Full parity with "basic editor" expectation — place, select, transform, delete, duplicate all work with mouse + keyboard.

**Sprint 6: Undo/redo + scene graph tree**

- [x] Command pattern middleware on Zustand (every mutation = invertible command) — do NOT use naive full-state snapshots at scale; use command diffs
- [x] Hierarchical scene graph panel (tree view), parent/child nesting (e.g., props attached to a building)
- [x] Keyboard shortcuts standardized (Ctrl+Z/Y, Ctrl+D duplicate, Del)
- **DoD:** 50+ consecutive undo/redo operations work without state corruption; scene tree reflects nesting correctly.

**Sprint 7: Terrain tools**

- [x] Heightmap sculpt brush (raise/lower/smooth/flatten) using a canvas-based heightmap texture, GPU displacement shader
- [x] Terrain texture painting (splat map: grass/rock/sand blend)
- [x] Terrain size/resolution config on new-project creation
- **DoD:** User can sculpt a hill and paint texture blends, terrain persists correctly in scene.json.

**Sprint 8: Save/load (local first, no backend yet)**

- [x] Local save/load to IndexedDB (Dexie.js) so early testing doesn't need backend
- [x] Scene schema validation on load (Zod) with migration hook stub
- [x] "New project from template" flow using 2–3 hand-built starter scenes
- **DoD:** Close browser, reopen, project auto-restores from IndexedDB. Template picker loads a real starter scene.

---

### PHASE 2 — Behaviors, Physics, AI (Sprints 9–12)

**Sprint 9: Behavior system architecture**

- [x] Behavior plugin registry in `/packages/engine`: `registerBehavior('patrol', PatrolBehavior)`
- [x] Each behavior = class with `onInit(obj, params)`, `onUpdate(obj, dt)`, `onEvent(obj, evt)`
- [x] Editor: "Add Behavior" dropdown on inspector, dynamic property form generated from a JSON-schema-per-behavior (so new behaviors auto-generate UI, no manual form coding per type)
- **DoD:** Attaching "patrol" to an object in the editor produces correct waypoint movement in the live preview, and the exact same behavior code runs identically outside React.

**Sprint 10: Physics integration (Rapier)**

- [x] Rapier WASM world synced to Three.js scene; collider types (box/capsule/mesh) assignable per asset in manifest defaults
- [x] Gravity, static vs dynamic bodies, simple character controller for "player" template object
- **DoD:** Enemy with patrol behavior collides with terrain and static props correctly; player-controlled capsule can walk around without falling through terrain.

**Sprint 11: Enemy AI (Yuka.js) + triggers**

- [x] Yuka steering behaviors wired into engine tick loop (seek/flee/pursue/wander)
- [x] FSM per enemy type (idle → patrol → chase → attack → dead)
- [x] Trigger volumes (box/sphere) with onEnter/onExit events wired to a small event bus (door open, scene transition, spawn wave)
- **DoD:** Placing an enemy + a trigger volume in editor produces working "enemy chases player when trigger entered" behavior in preview.

**Sprint 12: Behavior QA + performance pass**

- [x] Object pooling for frequently spawned things (projectiles, particles)
- [x] Instanced rendering (`InstancedMesh`) for repeated static assets (trees/rocks) — critical for scenes with hundreds of props
- [x] Frustum culling verified; LOD deliberately deferred until an asset exceeds its triangle budget (see `docs/PERFORMANCE.md`)
- **DoD:** A test scene with 500 trees + 20 enemies with active AI holds 60fps on mid-tier hardware (define target: e.g., GTX 1660 / M1 equivalent).

---

### PHASE 2B — Gameplay Runtime & UI (Sprints 13–20)

The play-mode layer: camera rigs and an input abstraction, a schema-driven menu/HUD renderer,
weapons and health, unlockables, checkpoints, audio and a co-op multiplayer slice. Detailed in
`GAMEPLAY-RUNTIME-AND-QA-PLAN.md` and broken into sprints in `SPRINT.md`; inserted here because
exporting a world with no way to start, lose or hear it is not yet shipping a game.

### PHASE 3 — Export System (Sprints 21–23)

**Sprint 21: Static export (no behaviors)**

- [x] Export wizard UI: choose options (compress assets further? include source scene.json? minify?)
- [x] Bundler: copies `/packages/engine` (built, versioned) + user's scene.json + referenced assets only (tree-shake unused manifest entries) into a folder structure
- [x] Client-side zip via JSZip, or server-side job for large projects (queue if > threshold size) — client-side; there is no server yet, and the size budget warns instead
- **DoD:** Exported zip, when unzipped and opened via `index.html` (or `npx serve`), renders the identical static scene the editor showed.

**Sprint 22: Full behavior export + readability layer**

- [x] Ensure exported `/engine` includes all behavior/physics/AI code needed — **not** tree-shaken per scene: measured at roughly 30 KB of a 3 MB bundle, so per-scene builds would trade reproducibility for one percent
- [x] Optional "readable code" mode: template pass that emits human-readable `main.js` calling engine APIs explicitly per object, instead of pure JSON-driven load — good for users who want to hand-edit after export
- [x] Licensing/attribution file auto-generated (asset credits, engine license, user's own license choice)
- **DoD:** Exported project with enemies/physics/triggers runs identically to in-editor preview, standalone, offline, no build step required (plain `<script type="module">`).

**Sprint 23: Export hardening + cross-browser QA**

- [x] Playwright test: automated "create scene → export → serve export → visually diff against editor preview" pipeline
- [x] Test exported bundle in Chrome/Firefox/Safari/Edge, and on a throttled connection (asset loading spinners, error states) — Chromium, Firefox and WebKit; Edge is wired behind `PW_EDGE=1` and not run, being Chromium's engine with a different badge and needing Microsoft's own build installed
- [x] Size budgets + warnings (e.g., "your export is 180MB, consider more compression")
- **DoD:** Automated visual regression suite passes on 5 template scenes' exports across 4 browsers. **Met on three engines** — 11/11 in each of Chromium, Firefox and WebKit, all five templates green.

---

### PHASE 3B — Pre-Delivery Validation & Shareable Deploy (Sprints 24–27)

Every build is smoke-tested in a sandbox before anyone can download it; failures get a bounded,
schema-validated auto-repair loop, and whatever was changed is disclosed. Detailed in
`GAMEPLAY-RUNTIME-AND-QA-PLAN.md` §4.

### PHASE 4 — Backend Platform (Sprints 28–32)

**Sprint 28: Auth + multi-tenancy**

- [ ] NestJS API scaffold, Postgres + Prisma schema: `User, Organization, Membership, Project, SceneVersion, Asset, License`
- [ ] Auth via Auth0/Clerk (OIDC), org-based RBAC (owner/editor/viewer roles per project)
- [ ] SSO/SAML stub for future enterprise customers (even if not fully wired, design DB/role model for it now)
- **DoD:** Users can sign up, create an org, invite a teammate with a role, and role gates API access correctly (tested with integration tests).

**Sprint 29: Project CRUD + cloud save**

- [ ] `POST/GET/PUT /projects`, scene stored as JSONB `SceneVersion` rows (append-only — every save = new version row, not overwrite) → gives you free version history
- [ ] Autosave (debounced) from editor to backend; conflict detection (optimistic concurrency via version number)
- [ ] Project listing/dashboard UI (replacing local-only IndexedDB flow from Sprint 8 — migrate local-first data to cloud once backend exists)
- **DoD:** User can save from browser A, load same project on browser B, see identical state. Version history list shows last 20 saves with timestamps and restore option.

**Sprint 30: Asset storage + CDN pipeline**

- [x] `/orgs/{orgId}/assets/...` structure and signed upload URLs — **local files behind an `AssetStorage` interface, not S3/R2**, which is a deployment decision rather than missing code
- [ ] Backend-triggered ingest job: **not done.** There is no queue and no worker; uploads are validated and stored as sent. The `pending -> ready | failed` column is the seam one plugs into
- [x] Custom asset upload flow ("My Assets"). **Not tiered** — no billing exists until Sprint 32
- [x] Content-hash paths with `max-age=31536000, immutable`. **No CDN**; the route is the origin one would sit in front of
- **DoD: partially met.** A browser drops a `.glb`, watches it go Processing → Ready, and places it — with the engine drawing the customer's own GLB rather than a placeholder. Nothing is compressed or thumbnailed, which is the middle of the DoD sentence. See `docs/SPRINT.md`.

**Sprint 31: Real-time collaboration**

- [x] Yjs document mirroring the scene schema, and a y-websocket-protocol server that checks project membership during the upgrade. **Self-hosted, not Liveblocks** — a paid service with no account here
- [x] Presence over the awareness API: selection highlights in each collaborator's own colour, initials in the top bar, a soft lock while somebody is mid-gesture. **Camera position deliberately not broadcast** — sixty updates a second per person to move a dot
- [x] Conflict-free merge of simultaneous transforms, keyed per object per field. Terrain is the honest exception: one base64 blob, so concurrent sculpts are last-write-wins
- **DoD: met, with two qualifications.** Two browser contexts see each other's selections and edits live, and simultaneous transforms of different objects both survive. The two seats are **one account** — an invite token is unreachable from a browser — and latency is asserted under 3s rather than 200ms, because this container measures ~86ms quiet and ~840ms contended. See `docs/SPRINT.md`.

**Sprint 32: Export job orchestration at scale**

- [x] Export bundling moved to a **real BullMQ worker on real Redis** — the same `packages/export` bundler the editor runs, so both produce the same files
- [x] Polling for job status (not a websocket: six stage changes over tens of seconds does not earn a second long-lived connection), a real progress bar, and a download link that **expires after 24 hours**
- [x] Quota per plan tier, enforced with a per-organisation advisory lock. **No billing** — the tier is a column set by hand; the limit is not a stub
- **DoD: met, size qualified.** Browser → API → Redis → worker → download → unzipped and inspected, end to end. **Nothing 300 MB was built** — manufacturing a project that size would be testing the fixture; what is proven is that the work is off the tab, progress is real, and eight concurrent requests queue rather than compounding. The link is time-limited and membership-checked rather than cryptographically signed, which needs object storage. See `docs/SPRINT.md`.

---

### PHASE 5 — Enterprise Hardening (Sprints 33–36)

**Sprint 33: Observability + SRE basics**

- [x] OpenTelemetry across the API and the worker, **hand-instrumented rather than auto** — spans named after the product (`export.build`) rather than after the runtime (`pg.query`). Dashboard JSON and alert rules in `ops/`, **never loaded into a running Grafana** — there is no account and no container runtime here
- [x] A React error boundary per panel plus the two crashes React never sees (`onerror`, `unhandledrejection`), reporting to a **hand-written Sentry-compatible endpoint**. Silent unless `VITE_SENTRY_DSN` is set; **no Sentry account** was involved
- [x] Structured JSON logs and correlation ids the whole way: browser header → API → **BullMQ payload** (a queue has no headers) → worker → storage → the job row
- **DoD: met locally, not in Grafana.** `pnpm trace <correlation-id>` prints the whole path with a duration on every stage, and an end-to-end test drives a real browser and asserts it. The words "in one dashboard" are the part not met: the panels are reviewed configuration, unrendered. See `docs/SPRINT.md`.

**Sprint 34: Security & compliance pass**

- [x] Dependabot plus a Security workflow: `pnpm audit --prod` blocking, dev advisories reported, Semgrep with four published rulesets and four rules specific to this codebase. Both runtime advisories closed at the source — Express left the co-op server entirely
- [x] Every lifetime audited, and two were claims rather than facts: expired credentials and expired build artifacts were both kept for ever. Swept hourly now. **No bucket policies to audit** — storage is local disk behind an interface, per Sprint 30. CORS reviewed and narrowable with `ALLOWED_ORIGINS`; a wildcard is safe here because auth is a bearer token and `Allow-Credentials` is never sent
- [x] Sandboxing reconfirmed **and made permanent**: lint rules, a Semgrep rule, and a clean sweep. The one hit was in a test, and fixing it made the test better
- [x] Audit log on membership, project access, deletion and exports, with a closed vocabulary and correlation ids; `docs/SECURITY.md` covers retention, vendors and SOC 2 readiness with the gaps named
- **DoD: met, review qualified.** Every finding fixed rather than filed — no rate limiting, a sign-out that revoked nothing, a containment check a sibling directory satisfied, two retention leaks. Cross-org isolation is tested across all eighteen tenant-scoped routes, and the suite was verified by removing a guard on purpose. **Not met: "against staging"** — there is no staging deployment and no ZAP run, and the review was done by the author of the code. See `docs/SECURITY.md`.

**Sprint 35: Billing & plan tiers**

- [x] Four tiers with seats, storage, exports, custom uploads, collaborators and SSO in **one table in the schema**, shared by the API that enforces them and the editor that draws the meters. Writing it exposed a contradiction in its own first draft: Free allowed two people in a room and one member
- [x] Billing behind a port, like authentication. **`StripeBilling` has never spoken to Stripe** — there is no account here — while `LocalBilling` implements the same port with the network removed, so checkout → signed webhook → entitlement runs and is tested end to end
- [x] Usage **derived, never counted**: exports from `export_jobs`, storage from `assets`, seats from `memberships`. A counter drifts, and being refused an export the meter said you had looks like theft
- [x] Downgrade decided rather than left undefined: **nothing is taken away, only growth is refused.** No lockout, no grace period — assets and members stay, the next upload and next invitation do not
- **DoD: met.** An end-to-end test in a real browser: free account refused a Pro-only upload with a structured prompt, upgrade through the provider's checkout page, signed webhook, back in the editor on Pro, same upload succeeds — no manual step. A second test spends a real server-side export and watches the meter move. **No Stripe account was involved**; see `docs/SPRINT.md`.

**Sprint 36: Performance & load testing**

- [x] Load tests against the API with explicit targets — `tools/load`, **not k6**, which is a Go binary this npm-only environment cannot install; the trade is recorded rather than glossed. One process meets all four targets at **50 concurrent** and misses autosave at 100, where throughput goes flat at ~130/s — the signature of a saturated process, so the next step is more processes, not a faster query
- [x] Memory leaks on long sessions, asked deterministically instead of watched in a profiler. Counting disposals across add/delete cycles **found the pitfall the plan names**: deleting an object left its geometries and materials alive until the project closed. Fixed as an ownership split, because freeing everything would have blanked every other object sharing a cached material
- [x] Editor bundle budget, enforced in CI. **559 KiB → 311 KiB** of initial JavaScript: signing in to read a project list was downloading a 3D engine before anything rendered. The projects screen no longer *waits* on the engine; it still fetches it after first paint, because the e2e suite's handle on the app needs the asset library there — a first-render win, not a never-downloads-it win
- [x] Collaboration server connection scaling, which is a different question from the API's — long-lived sockets, one document per open project. **Found a dropped sync message on the first join to a cold room**, hanging roughly one join in six, invisible to the Sprint 31 suite because its in-memory store was too fast to lose a message in
- [~] CDN cache hit-rate tuning. Headers are now verified against a **running origin**, which found HEAD on the CDN-facing asset path answering 401. There is no CDN here, so the hit-ratio half is not done
- **DoD: partly met, and the gap is the environment.** The targets are documented, the suite runs, and every service meets its bar at 50 concurrent — but the plan says "against staging" and there is no staging: this is loopback on one container. The collaboration server's ceiling is also unmeasured, because the load generator saturates before the server does — the tool detects that and refuses to report it as a server failure. Numbers, method and every gap in `docs/LOAD-TESTING.md`.

---

### PHASE 6 — Content, Polish, Launch (Sprints 37–38+)

**Sprint 37: Template & asset library expansion**

- [ ] Commission/produce 50–100 production-quality low-poly assets across categories (trees, rocks, buildings, enemies, props, terrain sets)
- [ ] 5–10 polished starter templates (village, dungeon, island, forest, arena) showcasing full feature set
- [ ] Asset marketplace groundwork if you want third-party creators later (license model, revenue share schema in DB already — Sprint 28's `License` table)
- **DoD:** New user can go from signup → pick template → make meaningful edits → export in under 10 minutes (usability test with 5 real users, not just internal team).

**Sprint 38: Docs, onboarding, beta launch**

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
4. **Underestimating export edge cases.** Circular parent/child references, missing assets, very large heightmaps — build the Playwright export-diff suite (Sprint 23) early, not at the end.
5. **Real-time collab complexity.** Yjs/CRDT is not trivial — budget real time for it (Sprint 31 alone may run long); a simpler "locking" model (one editor at a time per project) is an acceptable v1 fallback if timeline is tight. **Borne out.** The CRDT itself was the easy part; the hard part was the client's _push_ direction, which in its first form diffed local state against the shared document and so reverted every concurrent edit — correct-looking on one screen, wrong only under concurrency.

---

## 8. Immediate Next Action

Start **Sprint 1** today: scaffold the monorepo, define the Zod scene schema, and get a hardcoded scene.json rendering via plain Three.js with zero React involved. Everything else builds on that foundation being clean.
