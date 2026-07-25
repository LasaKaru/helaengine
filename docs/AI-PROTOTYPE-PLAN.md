# AI-PROTOTYPE-PLAN.md — Prompt-to-Prototype AI Layer

### Companion to GUIDE.md / DEVELOPMENT-PLAN.md / SPRINT.md. Covers the future capability: user types a prompt describing what they want, the system picks from available models + your asset library, and auto-assembles a fully editable prototype scene.

**Naming note:** recommend **Worldforge** as the product name going forward (alt: Claybase). Use this doc's examples with that name.

---

## 1. The Core Principle: AI Assembles, It Does Not Replace, the Schema

This is the single most important architectural constraint for this feature, and it's why it fits cleanly on top of everything already built rather than requiring a rewrite:

**The AI's only job is to produce a valid `scene.json` (or a partial patch to one) — the exact same schema your manual editor already writes to.** It never generates raw Three.js code, never generates arbitrary JS, never bypasses the behavior registry. This means:

- Every AI-generated prototype is, from the moment it's created, **100% editable** in your existing editor — because it's just another `SceneVersion`. This directly satisfies your requirement that "the game base must be fully customized" — the AI never locks anything down; it just seeds a starting point using the same building blocks a human would drag-and-drop.
- You inherit all your existing safety guarantees for free (Sprint 9's closed behavior vocabulary, Sprint 22's sandboxing audit) — the AI can only ever say "attach behavior type X with params Y," never "run this code."
- If the AI picks a bad asset or places something oddly, the user fixes it exactly the way they'd fix a manual mistake — drag, nudge, delete. No special "AI-generated object" UI category needed.

This reframes the feature from "AI game generator" (hard, unpredictable, hard to sandbox) to **"AI-assisted scene composer that writes into a schema you already fully control and validate"** (tractable, safe, and consistent with everything you've built).

---

## 2. Pipeline Architecture

```
User prompt: "a small ancient village with a guard tower,
              two patrolling enemies, and a market area"
                          │
                          ▼
        ┌─────────────────────────────────┐
        │   1. INTENT PARSER (LLM call)     │
        │   Structured extraction, not      │
        │   free text — forced JSON schema  │
        └───────────────┬───────────────────┘
                          ▼
        StructuredIntent {
          theme: "ancient village",
          biome: "grassland",
          structures: [{type:"tower",count:1}, {type:"market_stall",count:3}],
          enemies: [{archetype:"guard", count:2, behavior:"patrol"}],
          size: "small",
          mood: "peaceful-but-guarded"
        }
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  2. ASSET RETRIEVAL (semantic     │
        │  search over YOUR manifest only)  │
        │  Embeddings + metadata filter     │
        └───────────────┬───────────────────┘
                          ▼
        Resolved concrete assetIds:
        tower → "tower_stone_02", market → "stall_wood_01" (x3),
        guard → "enemy_soldier_01" (x2)
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  3. LAYOUT ENGINE (procedural,   │
        │  NOT LLM — deterministic rules)   │
        │  Terrain gen + placement solver  │
        └───────────────┬───────────────────┘
                          ▼
        Concrete positions/rotations for every object,
        collision-checked, terrain-conforming
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  4. BEHAVIOR ASSIGNMENT           │
        │  Maps intent → behavior registry  │
        │  entries + generated waypoints    │
        └───────────────┬───────────────────┘
                          ▼
        Valid, Zod-validated scene.json
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  5. VALIDATION + REPAIR LOOP      │
        │  Zod validate → if fail, re-      │
        │  prompt LLM with the error, or    │
        │  fall back to safe defaults        │
        └───────────────┬───────────────────┘
                          ▼
              Loads into editor exactly like
              any manually-built scene — fully
              editable from this point forward
```

**Critical design point:** only step 1 (intent parsing) and optionally step 2's disambiguation actually need an LLM call. Steps 3 and 4 (layout, behavior assignment) should be **deterministic procedural code you write**, not LLM output — this is what makes results reliable, fast, cheap, and debuggable. LLMs are unreliable at precise spatial reasoning (exact coordinates, collision avoidance) but excellent at "what does the user mean" classification. Use each tool for what it's actually good at.

---

## 3. Step-by-Step Detail

### Step 1 — Intent Parser

- Use **structured output / forced JSON mode** (every major model provider supports this — function calling / JSON schema constrained generation) so the LLM's response is guaranteed parseable, not free text you have to regex out.
- Define a `PrototypeIntentSchema` in Zod (separate from, but referencing, your existing asset categories/behavior types) — the LLM is prompted with your actual available categories and behaviors as part of its context, so it never invents an asset type you don't have.
- This step should be **model-agnostic by design** (see Section 4 — model routing) since your "user will pick from available models" note implies you want flexibility here, not a hard dependency on one vendor.

### Step 2 — Asset Retrieval (semantic search, not the LLM guessing filenames)

- Precompute embeddings for every asset in your manifest (from its name, category, tags, and a short description) using any embedding model, store in a vector column (pgvector extension on your existing Postgres, or a lightweight dedicated vector store if scale demands it later)
- For each requested item in the structured intent (e.g., "guard tower"), do a similarity search against your asset embeddings, filtered by hard category constraints (e.g., must be tagged `structure`), and pick the top match — with a fallback to a curated "safe default" if nothing scores above a confidence threshold
- This step is why "game base must be fully customized" and "pick from available models" both work correctly: the AI is choosing among assets **you own and have already vetted/licensed/optimized**, never inventing or fetching arbitrary content

### Step 3 — Layout Engine (deterministic, your code, no LLM)

- Terrain: pick/generate a base terrain (flat, or a simple procedural heightmap using noise functions — e.g., Perlin/Simplex via a library like `simplex-noise`) sized appropriately to the requested scene "size"
- Placement solver: a rule-based algorithm — e.g., place structures first using a simple grid/Poisson-disc sampling to avoid overlap, then scatter decorative props (trees/rocks) around them with jitter, then place enemies near but not on top of structures, respecting a minimum spacing constraint
- This is genuinely just procedural-generation logic (a well-understood, controllable domain), not a black box — you can unit test it deterministically given a seed
- Collision-check every placement against existing colliders (reuse Rapier from the engine, or simpler AABB overlap checks for placement-time only, since Rapier's a runtime concern) before finalizing a position

### Step 4 — Behavior Assignment

- Map intent-level concepts ("guard," "patrol") to your existing behavior registry entries (`PatrolBehavior`, `ChaseOnSightBehavior` from Sprint 9/11) with sensible default params
- For patrol waypoints specifically: auto-generate a small patrol loop around the enemy's placed position (e.g., a 3-5 point loop within a radius), since asking an LLM to output precise waypoint coordinates is exactly the kind of spatial-precision task it's weak at — do this procedurally instead

### Step 5 — Validation + Repair

- Run the assembled scene through the same Zod `SceneSchema` validator used everywhere else in the product (this is the payoff of having a single shared schema package from Sprint 1)
- If validation fails (should be rare, given steps 2-4 are your own deterministic code, but the intent-parsing step 1 is the one LLM-dependent piece that could produce something slightly malformed) — either auto-repair with defaults, or re-prompt the LLM once with the specific validation error asking it to correct just the malformed field
- On success: create a new `Project` + initial `SceneVersion` exactly as if a human had built it, open directly into the editor

---

## 4. "Pick From Available Models" — Model Routing Layer

Since you specifically mentioned the system should pick from available models, build a small **model router** rather than hardcoding one provider:

```
ModelRouter {
  intentParsing: [claude-sonnet, gemini-pro, gpt-4o]   // structured JSON extraction task
  assetDescriptionEmbedding: [text-embedding-3, gemini-embedding]
  // optional future: image generation for custom textures/thumbnails
  conceptArt: [imagen, dall-e, stable-diffusion]
}
```

- Route by task type, not by "one model for everything" — intent parsing, embeddings, and (later) any generative image/texture work are different jobs with different ideal models.
- Add a fallback chain per task (if primary model errors or times out, fall through to secondary) — this is standard practice and cheap insurance given you're already committed to a Gemini-based hackathon build, which is a good proof of concept for exactly this kind of multi-model orchestration.
- Keep provider API calls behind a single internal abstraction (e.g., an `IntentParserProvider` interface) so swapping/adding models later is a config change, not a rewrite — this also lets you let _users_ eventually pick their preferred model if you want that as a product feature (e.g., "use Gemini" vs "use Claude" toggle), since the interface is already provider-agnostic.

---

## 5. Where This Fits in the Existing Roadmap

This is a **post-GA, Phase 8+ feature** — it depends on:

- A mature, stable scene schema (Phase 0-2) — the AI is only as good as the schema it's writing into
- A rich, well-tagged asset library (Phase 6, Sprint 25) — retrieval quality is directly bounded by how well your assets are categorized/tagged; garbage tags in, garbage retrieval out
- The behavior registry being feature-complete enough to cover common prompt intents (Phase 2)

Recommended placement: **Phase 8, Sprints 29-32**, run _after_ GA launch (Phase 7) once you have real usage data on what users actually ask for — that data should directly shape which prompt intents you prioritize supporting first, rather than guessing upfront.

### Sprint 29 — Asset Tagging + Embedding Infrastructure

- Retroactively enrich every existing asset manifest entry with richer tags/descriptions suitable for semantic search (this is real editorial work, budget real time for it)
- Set up pgvector on Postgres, generate and store embeddings for the full asset library
- Build and test the retrieval function in isolation (given a text query, return ranked asset matches) before any LLM integration
- **DoD:** Querying "guard tower" against the asset embedding index reliably returns the correct structure asset in the top result, tested across 30+ sample queries covering all asset categories.

### Sprint 30 — Intent Parser + Model Router

- Build `PrototypeIntentSchema` (Zod), write the structured-output prompt template, integrate the first model (whichever you're most familiar with from the hackathon work)
- Build the `ModelRouter` abstraction with at least 2 providers wired (primary + fallback)
- **DoD:** Given 20 varied test prompts, the parser correctly extracts structured intent (theme, structures, enemies, size) matching manual expectations for at least 90% of them; fallback provider activates correctly when primary is forced to fail in a test.

### Sprint 31 — Layout Engine + Behavior Assignment

- Build the procedural terrain + placement solver (Poisson-disc/grid-based spacing, collision-checked)
- Build the intent→behavior mapping layer with auto-generated patrol waypoints
- **DoD:** Given a fixed structured intent, the layout engine deterministically (given a seed) produces a valid, non-overlapping, collision-checked scene; re-running with the same seed produces the same layout (important for debugging and for letting users "reroll" with a new seed if they don't like a result).

### Sprint 32 — End-to-End Integration + Validation Loop

- Wire all steps together behind a single `POST /prototypes/generate` endpoint (prompt in, project+sceneVersion out)
- Build the validation/repair loop (Zod validate → auto-repair or single re-prompt on failure)
- Build the user-facing UI: a prompt input box (likely on the "New Project" flow, alongside the existing blank/template options from Sprint 8), a brief generation-progress state, and — critically — land the user directly in the normal editor with the generated scene, no special "AI mode," reinforcing that it's just a starting point like any template
- **DoD:** A user can type a prompt like the example at the top of this doc, get a coherent, playable prototype scene within a reasonable time budget (define a target, e.g., under 15 seconds), and immediately edit it with zero friction using every existing editor tool (place/transform/behaviors/terrain sculpt/export) — verified by a usability test explicitly checking that editing an AI-generated scene feels identical to editing a manually-built one.

---

## 6. Guardrails to Build In From Day One

- **Cost control:** cap prompt-to-prototype generations per plan tier (ties into your existing Sprint 23 billing/quota system) — LLM calls cost real money per request, unlike static asset serving.
- **Content safety:** even though assets are pre-vetted, validate the _combination_ the LLM assembles isn't nonsensical/broken (e.g., enemy count of 500 in a "small" scene) — add sane min/max clamps in the Zod schema itself, not just in the prompt instructions, since prompt instructions can be ignored by the model but schema constraints cannot.
- **Determinism/reroll:** always generate with a stored seed so "regenerate" is a meaningful, reproducible-if-wanted action, not a pure gamble each time.
- **Transparency:** show the user the structured intent you extracted ("Here's what I understood: small village, 1 tower, 2 patrolling guards...") before or alongside the generated scene — this builds trust and gives users an easy way to spot-correct misunderstood intent by re-prompting, rather than only being able to fix it by hand after the fact.
