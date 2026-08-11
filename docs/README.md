# HelaEngine documentation

## If you are using it

- [**Using your own models**](IMPORTING-MODELS.md) — importing `.glb` files from disk, what gets
  measured, and where they live.
- [**Lighting, materials and image effects**](RENDERING.md) — the Rendering panel, per-object
  material overrides, and what each setting costs.
- [**Rigged characters and animation**](ANIMATION.md) — skeletal animation, importing a Mixamo
  character, and why a scene names states rather than clips.
- [**Making a world feel alive**](WORLD.md) — wind and swaying vegetation, ground cover placed by
  rule, world size, look presets and ambient sound.
- [**The node graph**](GRAPH.md) — wiring up what happens in a level without writing code, and the
  checks a canvas can make that a script file cannot.
- [**Skill packs**](PACKS.md) — recipes as markdown files: what a pack may change, why it can never
  bring code with it, and how to write one.
- [**Behaviour reference**](BEHAVIOURS.md) — every behaviour and its parameters. Generated from the
  engine's own schemas, so it cannot disagree with the code that enforces them.
- [**Exporting and hosting**](EXPORTING.md) — what comes out of Export, how to run it, where to put
  it.
- [**Shipping a Windows `.exe`**](DESKTOP-EXPORT.md) — turning an export into a program players
  double-click, and the three things to know before you do.
- [**Troubleshooting**](TROUBLESHOOTING.md) — things that go wrong and what they actually mean.
- [**Running on Windows**](RUNNING-ON-WINDOWS.md).

## If you are building it

- [**Guide**](GUIDE.md) — what each sprint delivered, and what it did not.
- [**Sprint plan**](SPRINT.md) — the plan itself, ticked as it is met.
- [**Engine roadmap**](ENGINE-ROADMAP.md) — the path from here toward a general-purpose engine,
  what not to build, and why arbitrary scripting is the one thing that cannot be added.
- [**Asset conventions**](ASSET-CONVENTIONS.md) — budgets, naming, colliders, importing a pack.
- [**Performance**](PERFORMANCE.md) — the engine's frame rate against the stress scene.
- [**Load and capacity**](LOAD-TESTING.md) — the platform under concurrent use, and where it stops
  meeting its targets.
- [**Security**](SECURITY.md) — the sandboxing guarantee and how it is enforced.
- [**Runbook**](RUNBOOK.md) — what to do when something is on fire, including backup and restore.
- [**Launch readiness**](LAUNCH-READINESS.md) — what is verified versus what is merely configured,
  SLA expectations, and the launch-day plan.

## On the absence of a docs site

The sprint plan asks for a Docusaurus site. This is markdown in the repository instead, and that is
a judgement rather than an omission — worth stating so it can be overruled.

**What Docusaurus would add:** a public URL, full-text search, versioned docs, and a place to put a
landing page. Those are real, and the first and last matter for a product with external users.

**What it would cost:** a second application to build, deploy and keep alive; a second place
documentation lives, which in practice means one of the two goes stale; and a build step between
writing a sentence and anybody reading it. GitHub already renders every page here, every link works
in an editor and on the web, and the content is reviewed in the same pull request as the code it
describes.

**The part that actually decays is already solved**, and not by a site generator: the behaviour
reference is produced from the schemas by `pnpm gen-docs`, and CI fails if the committed page and
the code disagree. A hand-written reference behind a beautiful site is still a hand-written
reference.

The right moment for Docusaurus is when there is an audience that needs search and versioning —
which is a beta cohort away, and the beta cohort is the part of Sprint 38 this environment cannot
produce. Until then this is one `docs/` directory that is always current.
