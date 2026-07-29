# GAMEPLAY-RUNTIME-AND-QA-PLAN.md — Play Mode, Customizable UI, Audio, Checkpoints, and Pre-Delivery Validation

### Companion to GUIDE.md / DEVELOPMENT-PLAN.md / SPRINT.md / AI-PROTOTYPE-PLAN.md.

---

## 0. Where This Fits in the Master Timeline (important)

Your existing SPRINT.md has Phase 3 (Export System, Sprints 13-15) coming right after Phase 2 (Behaviors/Physics/AI, Sprints 9-12). **Everything in this document must be inserted between those two phases**, because right now "export" produces a scene with objects and behaviors but no actual playable game shell (no menu, no HUD, no way to lose/win/pause, no audio). Shipping export as currently scoped means users download something that isn't really "a game" yet.

**Revised master phase order:**

| Phase                                                               | Sprints   | What                                                       |
| ------------------------------------------------------------------- | --------- | ---------------------------------------------------------- |
| 0 — Foundations                                                     | 1-2       | (unchanged)                                                |
| 1 — Editor MVP                                                      | 3-8       | (unchanged)                                                |
| 2 — Behaviors/Physics/AI                                            | 9-12      | (unchanged)                                                |
| **2B — Gameplay Runtime & UI (NEW, this doc)**                      | **13-20** | Play modes, menus, HUD, weapons/health, checkpoints, audio |
| 3 — Export System                                                   | 21-23     | (renumbered from 13-15, same scope)                        |
| **3B — Pre-Delivery Validation & Shareable Deploy (NEW, this doc)** | **24-27** | Sandbox test, AI auto-fix loop, hosted play links          |
| 4 — Backend Platform                                                | 28-32     | (renumbered from 16-20)                                    |
| 5 — Enterprise Hardening                                            | 33-36     | (renumbered from 21-24)                                    |
| 6 — Content & Beta Launch                                           | 37-38     | (renumbered from 25-26)                                    |
| 7 — GA Launch                                                       | 39-40     | (renumbered from 27-28)                                    |
| 8 — AI Prototype Generation                                         | 41-44     | (renumbered from 29-32, per AI-PROTOTYPE-PLAN.md)          |

Net effect: this adds ~4 months to the timeline (12 new sprints), bringing total to roughly **19-20 months to GA**. This is a real, substantial scope increase — worth being clear-eyed about, but it's the difference between shipping a "world viewer" and shipping an actual enterprise-grade game engine, which is what you're building.

---

## 1. Schema Extensions Required

Before any sprint work starts, extend the shared Zod schema (`/packages/schema`) with new top-level sections. This is the same discipline as before — UI is data-driven, not hand-coded per project.

```json
{
  "gameConfig": {
    "cameraMode": "fps | tps | topdown",
    "allowModeSwitch": true,
    "multiplayer": { "enabled": false, "maxPlayers": 4, "mode": "coop | deathmatch | none" }
  },
  "playerConfig": {
    "startHealth": 100,
    "startAmmo": { "pistol": 30 },
    "moveSpeed": 5,
    "jumpHeight": 1.5
  },
  "inventory": {
    "weapons": [
      {
        "id": "pistol_01",
        "assetId": "wpn_pistol_01",
        "damage": 15,
        "fireRate": 2,
        "maxAmmo": 12,
        "reloadTime": 1.2
      }
    ],
    "items": [
      { "id": "medkit", "assetId": "item_medkit_01", "effect": "restoreHealth", "value": 25 }
    ]
  },
  "checkpoints": [
    { "id": "cp_01", "position": [0, 0, 10], "isStart": true },
    { "id": "cp_02", "position": [40, 0, 60], "saveOnReach": true }
  ],
  "uiConfig": {
    "homeScreen": {
      "backgroundImageAssetId": "img_home_01",
      "introVideoAssetId": "vid_intro_01",
      "title": "My Game",
      "playButtonText": "Play"
    },
    "mainMenu": {
      "buttons": [
        { "label": "Play", "action": "startGame" },
        { "label": "Settings", "action": "openSettings" },
        { "label": "Quit", "action": "quit" }
      ],
      "theme": "themeId"
    },
    "hud": {
      "showHealthBar": true,
      "showAmmoCounter": true,
      "showMinimap": false,
      "customElements": []
    },
    "pauseMenu": {
      "buttons": [
        { "label": "Resume", "action": "resume" },
        { "label": "Restart Checkpoint", "action": "restartCheckpoint" },
        { "label": "Main Menu", "action": "mainMenu" }
      ]
    },
    "theme": { "font": "themeFontId", "primaryColor": "#...", "panelStyle": "..." }
  },
  "unlockables": [
    {
      "id": "secret_room",
      "unlockMethod": { "type": "inputSequence", "sequence": ["Up", "Up", "Down", "Down"] },
      "action": { "type": "teleportPlayer", "target": [100, 0, 100] }
    },
    {
      "id": "hidden_weapon",
      "unlockMethod": { "type": "triggerVolume", "triggerId": "trg_0005" },
      "action": { "type": "unlockInventoryItem", "itemId": "rifle_01" }
    }
  ],
  "audioConfig": {
    "music": {
      "menuTrackAssetId": "music_menu_01",
      "gameplayTracks": ["music_explore_01", "music_combat_01"],
      "crossfadeOnStateChange": true
    },
    "sfx": {
      "onDamage": "sfx_hurt_01",
      "onPickup": "sfx_pickup_01",
      "onCheckpoint": "sfx_checkpoint_01"
    },
    "masterVolume": 1.0,
    "musicVolume": 0.8,
    "sfxVolume": 1.0
  }
}
```

**Design rule carried forward from earlier docs:** `unlockMethod` and `action` types are a **closed, registered vocabulary** (same pattern as behaviors in Sprint 9) — never free-form code. "Secret unlock methods" are just another plugin type (`inputSequence`, `triggerVolume`, `itemCollectionCount`, etc.), which keeps this exportable and safe the same way behaviors are.

---

## 2. Sub-System Breakdown (what you're actually building)

### A. Camera & Player Controller System

- First-person and third-person camera rigs, toggle-able per `gameConfig.cameraMode` (and optionally at runtime if `allowModeSwitch` is true)
- Extends the Sprint 10 character controller (Rapier kinematic controller) with: sprint/crouch, jump, look-input (mouse/touch/gamepad), head-bob (FPS) or camera-follow-spring (TPS)
- Input abstraction layer supporting keyboard/mouse, touch (virtual joystick + buttons for mobile export), and gamepad — this needs to be designed once, generically, not bolted on per-platform later

### B. Multiplayer Runtime

- This is the single most complex addition here — treat it as its own vertical slice, not a checkbox
- Recommend **Colyseus** (Node-based authoritative multiplayer framework, room-based, integrates cleanly with your existing NestJS/Node backend) over building raw WebRTC/WebSocket sync yourself
- Authoritative server model: server holds true game state (positions, health, ammo), clients send inputs, server simulates and broadcasts state — prevents cheating and keeps physics consistent across players
- Scope decision to make explicitly: v1 multiplayer should support co-op/shared-world only (players see each other move, no complex lag-compensated combat) — full competitive-shooter netcode (client prediction, lag compensation, rollback) is a significant specialization; don't silently scope-creep into it without deciding to

### C. Menu / UI System (fully customizable)

- Build this as its **own schema-driven sub-renderer**, structurally identical in spirit to the 3D `SceneLoader` — a `UIRenderer` that takes `uiConfig` and renders DOM/Canvas UI (recommend actual DOM+CSS overlay on top of the WebGL canvas, not in-3D UI meshes, for text quality/accessibility/easier customization)
- Home screen: background image + optional intro video (HTML5 `<video>` overlay, skippable, autoplay-muted-then-unmute-on-interaction to respect browser autoplay policies), title text, Play button — all editable via a WYSIWYG panel in your editor
- Main menu / pause menu: button lists driven by `uiConfig.mainMenu.buttons[]` / `pauseMenu.buttons[]` — each button maps to a registered **UI action** (`startGame`, `openSettings`, `quit`, `restartCheckpoint`, `mainMenu`, and later custom ones) — same closed-vocabulary pattern as behaviors
- HUD: health bar, ammo counter, minimap, and a `customElements[]` array letting users add their own text/image overlays with position/binding (e.g., bind a text element to a scene variable like score or timer)
- Theming: font, color palette, panel style presets (a small theme system, similar in spirit to the `theme-factory` pattern) so the whole UI can be reskinned without per-element manual styling every time

### D. Weapons, Health, Ammo, Combat

- Extend the behavior/item system: weapons are inventory entries with damage/fireRate/ammo/reload stats (schema above), bound to input (fire button) via the input abstraction from (A)
- Health system: player + enemy health pools, damage events flowing through the existing engine event bus (Sprint 11), death state triggers respawn-at-checkpoint or game-over UI
- Ammo pickups/item pickups as a specialization of the existing "object + trigger" pattern (an item object with an `onPickup` behavior that adds to inventory and despawns itself)
- All of this should be editable via Inspector property forms exactly like Sprint 9's behavior forms — no new UI paradigm needed, just new registered types

### E. Checkpoints & Save System

- Checkpoint objects (placeable like any other object) that, on player trigger-enter, update a `currentCheckpointId` in game state and optionally persist via `localStorage`/`IndexedDB` in the exported game (or via your backend if the exported game is played through a hosted link with an account — see Section 3)
- On player death: respawn at `currentCheckpointId`'s position, reset health/ammo per checkpoint's configured reset rules (decide: full reset vs. partial — expose as a per-checkpoint config option)

### F. Audio System

- Background music: state-driven track switching (menu track vs. gameplay track vs. combat track) with crossfade, using Web Audio API (via Three.js's built-in `AudioListener`/`PositionalAudio`, or a dedicated lib like Howler.js for easier mixing/crossfade control — recommend Howler for the UI/music layer, Three's positional audio for in-world 3D sound sources)
- SFX: event-bound (damage, pickup, checkpoint, footsteps, weapon fire) — map engine events to sound asset IDs via `audioConfig.sfx`
- Volume mixer exposed in both the editor (author-time defaults) and the exported game's Settings menu (player-adjustable master/music/SFX sliders) — this needs to be in the UI system from day one, not patched in later
- Asset pipeline extension: audio files need their own ingest step (format normalization to a web-friendly codec like Opus/MP3, loudness normalization) — extend the Sprint 2/18 ingest pipeline rather than building a separate one

---

## 3. Shareable Play (the "no download needed" path)

Beyond the zip-download export, add a **hosted play link** option — this is what makes the product feel enterprise/professional rather than "download a zip and hope":

- Deploy the exported bundle to a per-project subdomain or path (e.g., `play.worldforge.app/p/{projectId}` or a vanity slug) automatically as part of the export job (Sprint 20's export worker gains a "deploy to hosted play" mode alongside "download zip")
- This reuses 100% of the same bundling logic — it's the identical static output, just uploaded to a public-serving bucket/CDN path instead of zipped for download
- Add basic access controls (public link, unlisted link, or org-only) and a simple analytics stub (play count) since this is a natural place to show product value to non-technical stakeholders (e.g., a manager who wants to preview a build without needing to unzip and run a local server)

---

## 4. Pre-Delivery Validation Pipeline (the "AI checks it works before they get it" system)

This is the safety net you described: before a user can download or get a shareable play link, the system automatically test-runs the export in a sandbox, and if something's broken, attempts an automated fix — only granting access once it passes.

### Architecture

```
Export/Deploy requested
        │
        ▼
┌─────────────────────────────┐
│ 1. SANDBOXED BUILD            │
│ Same export worker (Sprint 20)│
│ but output goes to a private, │
│ non-public staging location    │
└──────────────┬────────────────┘
                ▼
┌─────────────────────────────┐
│ 2. HEADLESS SMOKE TEST         │
│ Playwright launches a headless │
│ browser, loads the staged      │
│ build, runs a scripted probe   │
└──────────────┬────────────────┘
                ▼
      Pass? ──Yes──► 4. RELEASE (unlock download/play link)
        │No
        ▼
┌─────────────────────────────┐
│ 3. AI DIAGNOSIS + AUTO-REPAIR  │
│ Feed captured errors + scene   │
│ context to an LLM, get a       │
│ proposed scene.json patch,     │
│ Zod-validate the patch,        │
│ re-run step 1-2                │
└──────────────┬────────────────┘
                ▼
      Retry loop (bounded, e.g., max 3 attempts)
        │
        ▼
  Still failing? ──► Block release, show user a clear,
                     specific error report + manual fix
                     suggestion (never silently fail)
```

### Step 2 detail — what the automated smoke test actually checks

Define a concrete, scripted checklist (this is NOT "AI plays the game and judges it" — that's unreliable; make it deterministic checks):

- [ ] Page loads with zero uncaught JS console errors
- [ ] All asset network requests resolve (no 404s on GLB/texture/audio files) — catches broken asset references from schema issues
- [ ] Engine reports "scene loaded" event within a timeout (catches infinite-load/hang states)
- [ ] Automated input simulation: send synthetic WASD + mouse-look input for N seconds, verify the player object's position actually changes (catches "player spawns stuck/falls through world" bugs — the most common export-breaking issue)
- [ ] Player health doesn't unexpectedly hit zero within the first few seconds of idle simulation (catches misconfigured damage triggers at spawn)
- [ ] Verify WASM (Rapier) actually initializes (catches the MIME-type/hosting issue flagged in SPRINT.md Sprint 14)
- [ ] Memory doesn't spike unboundedly over a short simulated play window (cheap leak catch, not a full profiling pass)

### Step 3 detail — the AI auto-repair loop

- On smoke-test failure, capture: console error text/stack, the specific check that failed, and the relevant slice of `scene.json` (not the whole thing — e.g., if "player falls through terrain," feed just player spawn position + terrain collider config, not the entire object list, to keep the prompt focused and cheap)
- Prompt an LLM (reuse the `ModelRouter` abstraction from AI-PROTOTYPE-PLAN.md Section 4 — this is another consumer of the same routing layer) to propose a **targeted patch**, not a full scene rewrite — e.g., "move `checkpoints[0].position.y` up by 1 unit" or "add a collider to object X"
- Zod-validate the proposed patch before applying it (never trust LLM output structurally, same discipline as the prototype-generation pipeline)
- Apply patch → re-run the full pipeline from Step 1 → bounded retry count (e.g., 3 attempts) to avoid infinite loops or runaway cost
- **Log every auto-repair action taken** (this becomes part of the project's audit trail, and — importantly — surface it to the user afterward: "We detected and fixed 1 issue automatically: adjusted spawn point to prevent falling through terrain" — transparency matters here, don't silently rewrite their scene without telling them)
- If still failing after max retries: block release, show the user the specific, human-readable failure (not a raw stack trace) and, where possible, a suggested manual fix ("Your checkpoint at position [x,y,z] appears to be inside solid geometry — try moving it up")

**Why this is safe and not just "let an AI edit the game blindly":** every proposed change is (a) schema-validated, (b) scoped to a narrow, specific patch rather than a full rewrite, (c) re-verified by the same deterministic smoke test before being trusted, and (d) logged and disclosed to the user. This is the same "AI proposes into a controlled schema, never executes arbitrary code" discipline used throughout the rest of the product.

---

## 5. Sprint-by-Sprint Plan

### PHASE 2B — GAMEPLAY RUNTIME & UI (Sprints 13-20, ~4 months)

**Sprint 13 — Camera & Player Controller System**

- [ ] Build FPS camera rig (head-height offset, mouse-look with pointer-lock, head-bob toggle) on top of Sprint 10's Rapier kinematic controller
- [ ] Build TPS camera rig (spring-arm follow camera, collision-avoidance so the camera doesn't clip through walls)
- [ ] Build unified input abstraction: `InputManager` supporting keyboard/mouse, touch virtual joystick+buttons, and gamepad (Gamepad API), all mapping to the same abstract action set (`moveForward`, `look`, `jump`, `fire`, `interact`)
- [ ] Wire `gameConfig.cameraMode` to select rig at scene load; implement runtime toggle if `allowModeSwitch`
- **DoD:** A test scene is playable end-to-end in both FPS and TPS mode with keyboard/mouse, and separately verified functional with touch input on a mobile browser and a connected gamepad.

**Sprint 14 — Menu/UI Renderer Foundation**

- [ ] Build `UIRenderer`: DOM+CSS overlay layer driven entirely by `uiConfig`, mounted alongside the WebGL canvas
- [ ] Implement Home Screen: background image, intro video (with skip button, proper autoplay-policy handling), title, Play button
- [ ] Implement Main Menu and Pause Menu as button-list renderers bound to a registered UI-action vocabulary
- [ ] Build the theme system (font/color/panel-style presets) applied globally to all UI surfaces
- **DoD:** A full home→main menu→play→pause→resume loop works in the exported/preview build, and swapping the theme preset visibly restyles every menu without touching individual button configs.

**Sprint 15 — Editor-Side UI Customization Tools**

- [ ] Build the in-editor "Game UI" panel: WYSIWYG-ish editing of home screen image/video/title, menu button list (add/remove/reorder/relabel/reassign action), HUD toggle options
- [ ] Build custom text/image HUD element support (`hud.customElements[]`) with simple position/anchor controls and variable-binding (e.g., bind to a "score" or "timer" game variable)
- [ ] Asset upload flow extension: allow image/video uploads specifically for UI assets (home background, intro video), reusing the Sprint 18 upload pipeline
- **DoD:** A non-technical tester can, without help, change the home screen image, edit the intro video, rename/reorder menu buttons, and add a custom HUD text element, and see it reflected correctly in Play Preview.

**Sprint 16 — Weapons, Health, Ammo, Combat**

- [ ] Implement inventory schema + runtime inventory state (current weapon, ammo counts, held items)
- [ ] Wire weapon firing to the input abstraction (fire action → raycast/projectile hit-check → damage event → target health reduction)
- [ ] Build health/damage event flow through the existing engine event bus; death state triggers respawn logic (stub — full checkpoint integration in Sprint 18)
- [ ] Build pickup item behavior (`onPickup` — adds to inventory/health, despawns object, fires SFX event)
- [ ] Editor Inspector support for configuring weapon stats (damage/fireRate/ammo/reload) and assigning starting inventory in `playerConfig`
- **DoD:** A test scene with a weapon pickup, an enemy, and ammo/health pickups is fully playable: player can pick up a weapon, shoot an enemy, take damage, and pick up a medkit to heal, all reflected correctly in HUD.

**Sprint 17 — Unlockables / Secret Methods**

- [ ] Build the `unlockables` registry (closed vocabulary, per Section 1's schema) starting with `inputSequence` (Konami-code-style) and `triggerVolume`-based unlocks
- [ ] Build the corresponding unlock actions registry (`teleportPlayer`, `unlockInventoryItem`, `revealArea`, etc.)
- [ ] Editor UI: a dedicated "Secrets/Unlockables" panel to configure these without needing to touch raw JSON
- **DoD:** A test scene with both an input-sequence secret and a hidden-trigger secret both function correctly in Play Preview, and are configurable entirely through the editor UI.

**Sprint 18 — Checkpoints & Save System**

- [ ] Implement checkpoint objects (placeable, triggerable) updating `currentCheckpointId` game state
- [ ] Implement respawn-at-checkpoint on death, with per-checkpoint configurable reset rules (full vs. partial health/ammo reset)
- [ ] Implement persistence: exported standalone games save checkpoint progress to `localStorage`; hosted-play games (Section 3) optionally save server-side if the player is logged in
- [ ] Editor UI: checkpoint placement + per-checkpoint config panel
- **DoD:** Player reaches a checkpoint, dies, respawns at that checkpoint with correctly-reset stats; closing and reopening an exported standalone build resumes from the last reached checkpoint via localStorage.

**Sprint 19 — Audio System**

- [ ] Integrate Howler.js for music (state-driven crossfade between menu/gameplay/combat tracks) and Three.js positional audio for in-world 3D sound sources
- [ ] Wire SFX events (damage, pickup, checkpoint, footsteps, weapon fire) to the engine event bus
- [ ] Build the audio ingest pipeline extension (format normalization, loudness leveling) into the Sprint 2/18 asset pipeline
- [ ] Build the in-game Settings menu volume mixer (master/music/SFX sliders), and the corresponding editor-side default-volume configuration
- **DoD:** A test scene has distinct menu vs. gameplay music with a clean crossfade transition, correctly-triggered SFX for damage/pickup/checkpoint events, and a functioning in-game volume mixer that a player can adjust and have it persist for their session.

**Sprint 20 — Multiplayer Runtime (Co-op Slice)**

- [ ] Stand up Colyseus server (separate deployable service, per the "different workload shape" principle from DEVELOPMENT-PLAN.md's monolith-vs-microservices reasoning)
- [ ] Implement authoritative room state: player positions, health, simple shared world state; client sends inputs only, server simulates and broadcasts
- [ ] Wire the editor's `gameConfig.multiplayer` settings (enabled, maxPlayers, mode) to actually gate/configure the exported game's networking behavior
- [ ] Scope explicitly to co-op/shared-world (players see each other, interact with shared objects/triggers) — document combat netcode (lag compensation, client-side prediction for shooting) as an explicit future item, not silently included here
- **DoD:** Two separate browser clients connect to the same hosted-play session (Section 3) and see each other move in real time, with server-authoritative position sync and no obvious desync/rubber-banding under normal network conditions.

**Phase 2B wrap check:** At this point, an exported/deployed game is a genuinely complete playable product — menus, HUD, combat, checkpoints, audio, optional co-op. This is the real product milestone worth demoing widely, more so than the earlier "static scene" export.

---

### PHASE 3B — PRE-DELIVERY VALIDATION & SHAREABLE DEPLOY (Sprints 24-27, ~2 months)

_(Runs after renumbered Phase 3 Export System, Sprints 21-23)_

**Sprint 24 — Headless Smoke Test Harness**

- [ ] Build the Playwright-based sandboxed test runner: loads a staged (non-public) export build, captures console errors/network failures
- [ ] Implement the scripted checklist from Section 4 Step 2 (asset load verification, scene-loaded event timeout, synthetic input simulation checking player movement, early-death check, WASM init check, short memory-spike check)
- [ ] Wire this as a required step in the export/deploy pipeline (extends Sprint 20's export worker — build now writes to a private staging path first, not directly to public download/deploy)
- **DoD:** Running the smoke test harness against 5 known-good template scenes passes cleanly, and against 3 deliberately-broken test scenes (e.g., player spawn inside terrain, missing asset reference, broken WASM path) correctly fails with specific, identifiable error output per case.

**Sprint 25 — AI Diagnosis + Auto-Repair Loop**

- [ ] Build the error-context extraction step: given a smoke-test failure, isolate the relevant slice of `scene.json` (not the whole document) and format it with the captured error for LLM input
- [ ] Integrate with the `ModelRouter` (shared with AI-PROTOTYPE-PLAN.md) to request a targeted patch proposal in structured/JSON form
- [ ] Zod-validate proposed patches before applying; implement the bounded retry loop (max 3 attempts) re-invoking Sprint 24's smoke test after each patch
- [ ] Build the auto-repair audit log (what was changed, why, on which attempt) surfaced later to the user
- **DoD:** Feeding the 3 deliberately-broken test scenes from Sprint 24 through the full pipeline results in all 3 being automatically detected and correctly repaired (spawn point adjusted, missing collider added, WASM path fixed) within the retry budget, verified by the smoke test passing afterward.

**Sprint 26 — Release Gating + User-Facing Reporting**

- [ ] Wire pipeline outcome to actually gate access: download button / hosted-play link only becomes available after a passing smoke test (post-repair or first-try)
- [ ] Build the user-facing report UI: "We checked your build — here's what we found" — auto-fixes applied (transparent disclosure per Section 4), or, on unrecoverable failure, a specific human-readable error with a suggested manual fix
- [ ] Handle the unrecoverable-failure UX explicitly: never leave the user stuck with a spinning "processing" state — always resolve to either release or a clear, actionable failure message
- **DoD:** A user exporting a known-good scene sees a brief "validating..." state then gets their download/play-link with no repair notice; a user exporting a deliberately-broken scene either sees a transparent auto-fix notice with working output, or a clear specific failure message — never a silent hang or an unexplained rejection.

**Sprint 27 — Shareable Hosted Play**

- [ ] Extend the export worker with a "deploy to hosted play" mode: same validated bundle, uploaded to a public-serving CDN path/subdomain per project instead of zipped for download
- [ ] Implement link access controls: public, unlisted (link-only), org-only
- [ ] Implement basic play analytics stub (play count, last-played timestamp) surfaced in the project dashboard
- [ ] Verify multiplayer sessions (Sprint 20) work correctly through the hosted-play path specifically (this is likely the primary way co-op is actually used, more than local zip exports)
- **DoD:** A user can generate a shareable play link for a validated build, send it to someone else, and that person can play it directly in-browser (including joining a co-op session if multiplayer is enabled) with no download or local server setup required.

---

## 6. Updated Full Roadmap Reference (with this doc's sprints inserted)

| Phase                                     | Sprints   | Duration       | Outcome                                                        |
| ----------------------------------------- | --------- | -------------- | -------------------------------------------------------------- |
| 0 — Foundations                           | 1-2       | 1 month        | Engine skeleton + asset pipeline                               |
| 1 — Editor MVP                            | 3-8       | 3 months       | Local editor: place/transform/terrain/save                     |
| 2 — Behaviors/Physics/AI                  | 9-12      | 2 months       | Enemies, physics, triggers                                     |
| **2B — Gameplay Runtime & UI**            | **13-20** | **4 months**   | **Play modes, menus, HUD, weapons, checkpoints, audio, co-op** |
| 3 — Export System                         | 21-23     | 1.5 months     | Standalone playable exports                                    |
| **3B — Pre-Delivery Validation & Deploy** | **24-27** | **2 months**   | **Sandbox test + AI auto-fix, hosted play links**              |
| 4 — Backend Platform                      | 28-32     | 2.5 months     | Auth, cloud save, collab, cloud export jobs                    |
| 5 — Enterprise Hardening                  | 33-36     | 2 months       | Observability, security, billing, load testing                 |
| 6 — Content & Beta Launch                 | 37-38     | 1 month        | Asset library, templates, closed beta                          |
| **Subtotal to public beta**               | **1-38**  | **~19 months** |                                                                |
| 7 — GA Launch                             | 39-40     | ~2 months      | Public launch                                                  |
| 8 — AI Prototype Generation               | 41-44     | ~2 months      | Prompt-to-prototype AI layer                                   |
| **Total to full vision**                  | **1-44**  | **~23 months** |                                                                |
