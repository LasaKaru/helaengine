# DEVELOPMENT-PLAN.md — Full Lifecycle Plan: Zero → Launch → Future

### Companion to GUIDE.md (which has the sprint-by-sprint tasks). This doc answers the "why" — architecture stance, tech decisions, and what comes after v1.

---

## 1. The One Decision That Shapes Everything: Monolith vs. Microservices

**Recommendation: Start as a Modular Monolith. Do NOT start with microservices.**

Reasoning, stated plainly because this is the #1 place teams over-engineer and waste 6 months:

- You don't have the traffic, team size, or independently-scaling bottlenecks that justify microservices yet. Microservices solve _organizational_ scaling (many teams shipping independently) and _selective load_ scaling (one component needs 100x the others). At launch you have neither problem.
- A modular monolith gives you 90% of the benefit (clean boundaries, testability, replaceable modules) with 10% of the operational cost (one deploy, one DB transaction boundary, no distributed tracing tax, no network-call-where-a-function-call-would-do).
- The **one exception**: the **export/bundling worker** and the **real-time collab server** should be separate services from day one, because they have genuinely different scaling/runtime profiles (CPU-heavy batch jobs vs. long-lived WebSocket connections vs. request/response API). This isn't "microservices" philosophically — it's just recognizing three different workload shapes need three different deployment units.

**Target topology (v1 launch):**

```
Service 1: Core API (NestJS monolith, modular)
  ├── modules/auth
  ├── modules/projects
  ├── modules/assets
  ├── modules/billing
  ├── modules/orgs
  └── modules/licensing
  → talks to Postgres directly, one deploy unit, one repo

Service 2: Export Worker (separate Node process, BullMQ consumer)
  → CPU/memory heavy, scales independently, can spike to zero when idle

Service 3: Collab Server (Yjs/y-websocket, or Liveblocks managed — recommend managed for v1)
  → long-lived connections, different scaling curve (connection count, not CPU)

Shared: Postgres (single instance w/ read replica later), Redis (queues + cache), S3/R2 (assets)
```

This is sometimes called a **"monolith + workers" or "service-oriented, not microservices"** pattern — it's the honest middle ground and what most successful platforms (Figma, Notion, Linear in their early years) actually ran on.

**When to actually split into microservices (future, not now):** once you have (a) a dedicated team per domain, (b) a component with load 10-100x others (e.g., asset ingestion pipeline under heavy marketplace traffic), or (c) compliance reasons to isolate data (e.g., enterprise customers requiring data residency per-service). Until 2+ of those are true, splitting further just adds latency and ops burden for no benefit.

---

## 2. Full Tech Stack — Final Recommendation Table

| Layer                   | Choice                                                                                  | Alternative considered              | Why this one                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3D Engine (runtime)** | Vanilla Three.js, ES modules                                                            | Babylon.js                          | Three.js has the larger ecosystem for low-poly/glTF tooling; Babylon is more "batteries included" but heavier and less flexible for a custom exporter                   |
| **Editor framework**    | React + react-three-fiber + drei                                                        | Vue + TresJS                        | r3f ecosystem (drei, leva, zustand-r3f patterns) is far more mature for editor tooling specifically                                                                     |
| **Editor state**        | Zustand + Immer + command-pattern undo middleware                                       | Redux Toolkit                       | Less boilerplate, same devtools support, easier serialization to scene schema                                                                                           |
| **Schema/validation**   | Zod (shared between client + server + engine)                                           | JSON Schema + ajv                   | TypeScript-native, single source of truth generates types AND runtime validation                                                                                        |
| **Collaboration**       | Liveblocks (managed) for v1 → self-hosted Yjs/y-websocket later if cost demands         | Firebase Realtime DB                | Liveblocks is purpose-built for this exact "multiplayer canvas" use case, ships presence/cursors out of the box, saves 4-6 weeks of infra work                          |
| **Physics**             | Rapier (WASM)                                                                           | cannon-es, Ammo.js                  | Rapier is actively maintained, deterministic, fast, and has a clean async/compat wrapper for browser use                                                                |
| **AI/steering**         | Yuka.js                                                                                 | Custom FSM                          | Purpose-built for game AI steering/pathfinding, small footprint                                                                                                         |
| **Backend framework**   | NestJS (Node/TypeScript)                                                                | Go (Gin/Fiber), Django              | Same language across engine/editor/backend = one team can move fluidly across the stack; NestJS's module/DI system maps directly onto the "modular monolith" plan above |
| **Database**            | PostgreSQL 16 + Prisma ORM                                                              | MongoDB                             | Relational integrity matters for orgs/billing/permissions; JSONB columns give you schema-flexibility for scene documents without giving up transactions                 |
| **Cache/queue**         | Redis + BullMQ                                                                          | RabbitMQ + separate cache           | One piece of infra doing both jobs, well-trodden path with NestJS                                                                                                       |
| **Object storage**      | Cloudflare R2 (or S3)                                                                   | —                                   | R2 has no egress fees, meaningful at scale for a product where every export is a bulk asset download                                                                    |
| **CDN**                 | Cloudflare                                                                              | CloudFront                          | Pairs naturally with R2, cheaper, simpler DNS/edge config                                                                                                               |
| **Auth**                | Clerk (v1) → Keycloak self-hosted (enterprise SSO/SAML later)                           | Auth0                               | Clerk is faster to integrate for a small team; migrate to Keycloak only when an enterprise contract specifically requires self-hosted SSO                               |
| **Payments**            | Stripe (Billing + Usage-based metering)                                                 | Paddle                              | Stripe's metered billing API fits "pay per export/seat/storage" model well                                                                                              |
| **Infra**               | Docker containers → Fly.io or Render (v1) → Kubernetes (only once ops team exists)      | Straight to k8s                     | Don't run Kubernetes without a dedicated person to own it — Fly.io/Render get you 90% of the reliability with none of the YAML tax, at launch scale                     |
| **IaC**                 | Terraform (once on AWS/GCP) or just provider-native config (Fly.io toml) early          | —                                   | Add Terraform when you have more than 1 environment worth automating                                                                                                    |
| **CI/CD**               | GitHub Actions                                                                          | GitLab CI                           | Ubiquitous, free tier generous, integrates with everything above                                                                                                        |
| **Observability**       | OpenTelemetry → Grafana Cloud (managed) at launch, self-hosted Grafana/Loki/Tempo later | Datadog                             | Grafana Cloud free/cheap tier is enough until real scale; Datadog gets expensive fast                                                                                   |
| **Error tracking**      | Sentry                                                                                  | —                                   | Best-in-class for both client (React) and server (Node)                                                                                                                 |
| **Analytics**           | PostHog (self-hostable, product analytics + feature flags in one)                       | Amplitude + LaunchDarkly separately | Consolidates two tools into one, cheaper for a small team                                                                                                               |
| **Testing**             | Vitest, Playwright, Chromatic (visual regression for 3D UI)                             | Jest, Cypress                       | Vitest is faster and has better TS/ESM support; visual regression is non-negotiable for a 3D editor                                                                     |
| **Docs site**           | Docusaurus                                                                              | —                                   | Standard, versioned docs, easy to self-host or deploy to Vercel                                                                                                         |

---

## 3. Database Design (detailed)

### Core tables (Postgres, via Prisma)

```
User            id, email, name, authProviderId, createdAt
Organization    id, name, planTier, stripeCustomerId, createdAt
Membership      userId, orgId, role (owner|admin|editor|viewer)
Project         id, orgId, name, thumbnailUrl, currentVersionId, createdAt, updatedAt
SceneVersion    id, projectId, versionNumber, sceneJson (JSONB), authorId, createdAt
                 -- append-only. Never update, only insert. Gives free history/rollback.
Asset           id, orgId (nullable = global/shared asset), name, category, manifestEntry (JSONB),
                 glbUrl, thumbnailUrl, licenseType, createdAt
License         id, assetId, type (royaltyFree|attribution|commercial), termsUrl
ExportJob       id, projectId, sceneVersionId, status (queued|processing|done|failed),
                 downloadUrl, requestedBy, createdAt, completedAt
AuditLog        id, orgId, actorId, action, targetType, targetId, metadata (JSONB), createdAt
Subscription    id, orgId, stripeSubscriptionId, planTier, seats, status
UsageRecord     id, orgId, metric (exports|storageGb|activeSeats), value, periodStart, periodEnd
```

**Key design decisions:**

- **`SceneVersion` is append-only.** This single decision gives you version history, undo-across-sessions, audit trail, and collaboration conflict resolution basis, all for free — don't overwrite scene state, insert a new row every meaningful save (debounced, e.g., every 30s or on explicit save).
- **JSONB for `sceneJson` and `manifestEntry`.** Scene schema will evolve; you don't want a migration every time you add a new behavior type. Validate with Zod at the application layer, not the DB layer.
- **`AuditLog` from day one**, not bolted on later — enterprise customers will ask for this in the first sales call, and retrofitting audit logging onto an existing system that didn't plan for it is painful.
- **Read replica** only once you have real read load (dashboard queries, asset browsing at scale) competing with write load (autosave). Not needed at launch.

---

## 4. Backend Structure (inside the NestJS modular monolith)

```
apps/api/src/
  modules/
    auth/            — JWT/session validation, Clerk webhook handlers
    orgs/            — org + membership CRUD, RBAC guards
    projects/        — project CRUD, SceneVersion append logic, autosave endpoint
    assets/          — asset manifest CRUD, signed upload URL issuance, ingest job trigger
    exports/         — export job creation, status polling, BullMQ producer
    billing/         — Stripe webhook handlers, plan gating middleware, usage metering
    collab/          — Liveblocks room provisioning/auth token issuance (actual realtime handled by Liveblocks, not this service)
    audit/           — write-only audit log service, injected into other modules via interceptor
  common/
    guards/          — RoleGuard, PlanTierGuard (feature gating by subscription)
    interceptors/     — AuditLogInterceptor, RateLimitInterceptor
    pipes/           — ZodValidationPipe (shared schema package)
  main.ts
```

**Module boundary rule:** modules only talk to each other through exported services, never reach into another module's Prisma repository directly. This is what makes "modular monolith → future microservice extraction" actually possible later without a rewrite — if `exports` module ever needs to become its own deployed service, its boundary is already clean.

---

## 5. Deployment Topology (v1 launch)

```
                     ┌─────────────┐
                     │  Cloudflare  │  (CDN + DNS + WAF)
                     └──────┬──────┘
                            │
              ┌─────────────┼─────────────────┐
              ▼             ▼                 ▼
      ┌──────────────┐ ┌──────────┐   ┌──────────────┐
      │ Editor SPA    │ │ Core API │   │  R2 (assets)  │
      │ (static, Vercel│ │ (Fly.io) │   │               │
      │  or Cloudflare │ └────┬─────┘   └──────────────┘
      │  Pages)        │      │
      └──────────────┘       │
                              ▼
                  ┌────────────────────┐
                  │  Postgres (Fly.io/  │
                  │  Neon/Supabase)     │
                  └────────────────────┘
                              │
                  ┌────────────────────┐
                  │  Redis (Upstash)    │
                  └──────────┬─────────┘
                              ▼
                  ┌────────────────────┐
                  │  Export Worker       │
                  │  (Fly.io machine,    │
                  │  scale-to-zero)      │
                  └────────────────────┘

Collab: Liveblocks (fully managed, external)
Auth: Clerk (fully managed, external)
Payments: Stripe (fully managed, external)
```

**Why Fly.io/Neon/Upstash over raw AWS at launch:** every one of these is managed, has a generous free/cheap tier, and removes an entire category of ops work (patching, backups, failover config) that isn't worth your time until you have paying enterprise customers demanding specific SLAs or data residency. Migrate pieces to AWS/GCP individually, only when a specific need (compliance, cost at scale, specific enterprise contract requirement) demands it — don't do a "just in case" migration.

---

## 6. Timeline Overview (zero → GA)

| Phase                           | Duration                   | Outcome                                                      |
| ------------------------------- | -------------------------- | ------------------------------------------------------------ |
| Phase 0 — Foundations           | Sprints 1-2 (1 month)      | Engine skeleton + asset pipeline working locally             |
| Phase 1 — Editor MVP            | Sprints 3-8 (3 months)     | Full local-only editor: place, transform, terrain, save/load |
| Phase 2 — Behaviors/Physics/AI  | Sprints 9-12 (2 months)    | Enemies, physics, triggers working in preview                |
| Phase 3 — Export System         | Sprints 13-15 (1.5 months) | Standalone playable exports, cross-browser verified          |
| Phase 4 — Backend Platform      | Sprints 16-20 (2.5 months) | Auth, cloud save, collab, cloud export jobs                  |
| Phase 5 — Enterprise Hardening  | Sprints 21-24 (2 months)   | Observability, security, billing, load testing               |
| Phase 6 — Content & Beta Launch | Sprints 25-26 (1 month)    | Asset library, templates, closed beta                        |
| **Total to public beta**        | **~13 months**             |                                                              |
| Phase 7 — GA Launch             | +2 months post-beta        | Public launch, pricing live, support processes running       |

_(Solo/small-team estimate assuming focused execution; compress by 30-40% with a 3-4 person team split across the lanes in GUIDE.md section 4.)_

---

## 7. Post-Launch Roadmap (the "future" part)

### Near-term (0-6 months post-GA)

- **Mobile/touch editor support** — the drag/transform gizmo UX needs a distinct touch-input mode; don't retrofit, design it as a parallel input adapter in the editor from the start if this is a priority.
- **Asset marketplace** — let third-party creators sell asset packs; `License` table and revenue-share fields already scaffolded in Sprint 16, this phase builds the storefront UI + payout logic (Stripe Connect).
- **Multiplayer runtime export** — currently exports are single-player; adding a networked multiplayer runtime option (via Colyseus or a WebRTC mesh for small-scale) is a major engine-layer feature, not a UI feature.
- **In-editor scripting escape hatch** — a sandboxed (e.g., via `iframe` + `postMessage`, or a restricted JS subset like a Lua-in-WASM interpreter) visual scripting or code node system for power users who outgrow the fixed behavior vocabulary — this is the single most-requested feature in every tool like this eventually, plan for it architecturally (keep behaviors as a plugin interface so a "custom script" behavior type is just another plugin).

### Mid-term (6-18 months)

- **VR/WebXR preview and export mode** — Three.js has solid WebXR support; low-poly assets are performance-friendly for VR, this is a natural fit for the aesthetic you're already building.
- **AI-assisted content generation** — procedural terrain generation, AI-assisted NPC dialogue/behavior tuning (NOT full "generate my game" — stay disciplined about the schema-driven architecture; AI features should produce scene.json edits, not bypass the schema).
- **Self-hosted/on-prem enterprise deployment option** — some enterprise customers will want the whole stack behind their firewall; this is where Kubernetes + Terraform + Helm charts actually earn their complexity, packaged as a distinct "enterprise self-host" SKU.
- **Regional data residency** (EU/US split Postgres + storage) for compliance-driven enterprise deals.

### Long-term (18+ months)

- **Plugin/extension SDK** — public API for third parties to build editor plugins (custom terrain tools, custom behavior packs), following the same internal plugin boundary you built for behaviors in Sprint 9.
- **Engine open-sourcing consideration** — some competitors (e.g., PlayCanvas) open-source the runtime engine while keeping the editor/platform proprietary — this can drive adoption and community-contributed assets/behaviors if you want a growth lever.
- **Console/native export targets** — via Tauri/Electron wrapping for desktop distribution, or WebView wrapping for mobile app stores, if user demand shows up for it.

---

## 8. Cost Discipline Note

At every phase, prefer **managed services with usage-based pricing** over self-hosted infra until a specific, measured cost or compliance trigger justifies the switch. The order of operations for any "should we self-host X" question should always be: (1) is it costing us real money at current scale, or (2) does a paying customer require it contractually. Absent one of those two triggers, stay managed — engineering time spent on infrastructure you don't need yet is the most common way ambitious solo/small-team projects like this stall out before reaching users.
