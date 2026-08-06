# Troubleshooting

Things that go wrong, and what they actually mean.

Most entries here are real failures somebody hit — several of them found by this project's own test
suites and load runs. Where the cause was a bug that has since been fixed, that is said, because
"upgrade" is a better answer than a workaround.

---

## The exported game is a blank page

**Almost always: you opened `index.html` directly.**

Browsers refuse to `fetch` from `file://`, and the runtime loads `scene.json` and its models by
fetch. The console will show a CORS error mentioning `file://`.

Serve the folder instead:

```bash
cd your-project && python3 -m http.server 8000
```

If it is already being served and still blank, open the console. `Failed to load resource` with a
404 means the folder was uploaded incompletely — `assets/` and `engine/` must come with it.

---

## Everything in my scene is a grey box

The models did not load, but the scene did — you are seeing placeholders.

- **In an export:** `assets/models/` is missing or was not uploaded. The placeholders are sized and
  coloured from the manifest, which is why the layout looks right and the models do not.
- **In the editor, after `git clone`:** the asset library is generated output and is not committed.
  Run `pnpm ingest-assets`.
- **In a template you just added:** an `assetId` that does not exist renders as a grey box, and the
  scene schema will not catch it — a string naming no asset is a perfectly valid document. The
  templates test checks this; run `pnpm --filter @helaengine/templates test`.

---

## Nothing happens when I press Walk

The physics engine is WebAssembly and loads separately from the rest of the runtime. Until it
finishes, the button reports that rather than silently doing nothing — look at the label.

If it says physics is unavailable, the `.wasm` failed to load. On a self-hosted export, check the
server sends `application/wasm` for `.wasm` files; some older Apache and IIS configurations do not,
and a few browsers refuse to instantiate a wasm module served as `text/plain`.

---

## The first person to open a project sees a viewport that never loads

**This was a bug, fixed in Sprint 36.** The collaboration server registered its message listener
after loading the room, so a client's opening sync message — sent the instant the socket opens —
arrived at a socket with no listener and was dropped. It only ever affected the _first_ person to
open a project, roughly one join in six.

If you are running a build from before that fix, upgrade. If you are on a current build and see it,
that is a new bug and worth reporting with the project id.

---

## My project list says "Nothing saved yet" but I have projects

**Also fixed, in Sprint 37.** The screen could not tell "you have none" from "we have not looked
yet", so a signed-in user saw that sentence for the length of the fetch — and permanently if the
fetch failed.

A current build shows _Loading your projects…_ while it fetches and an error with a retry button if
it cannot. If you still see the empty-state message with projects in your account, the list request
is succeeding and returning nothing, which is a different problem: check you are signed into the
account you think you are.

---

## An export was refused and I do not understand the reason

The release gate loads your scene headlessly and plays it before letting you download anything. A
refusal names what failed. The common ones:

| Message mentions                         | What to do                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| an unknown `assetId`                     | The object references an asset that is not in your library. Delete it or replace the model.                                                  |
| a behaviour parameter out of range       | The gate will usually repair this itself. If it refused, the value is outside what any repair can justify — set it by hand in the inspector. |
| the scene never reached a playable state | Something threw during load. The report names the stage.                                                                                     |
| no spawn point                           | A game-mode export needs somewhere to put the player.                                                                                        |

Run the gate yourself for the full report:

```bash
pnpm smoke path/to/exported-folder --json report.json
```

---

## Uploaded models do not appear in the library

Uploads are processed asynchronously and the row shows its state. **Processing…** means it is still
being handled; **Failed** carries the reason.

The most common refusal is a file that is not a binary glTF. A `.gltf` renamed to `.glb` is not a
`.glb` — the format is different, not just the extension. Export as _glTF Binary_ from Blender, or
convert with `gltf-transform copy in.gltf out.glb`.

Files above the size limit for your plan are refused before upload starts, with the limit named.

---

## The editor is slow with a large scene

Some numbers, so you can tell normal from broken. On a mid-range laptop the stress-test template —
500 props and 20 enemies — runs comfortably. If yours does not:

- **Hundreds of _identical_ props are cheap; hundreds of different ones are not.** Objects sharing
  an asset are drawn as instances automatically, but only when nothing touches them individually —
  a behaviour, a trigger, a dynamic body or a parent/child relationship each opt an object out.
- **Check the object count in the viewport stats.** It goes amber past the budget.
- **Terrain sculpting at a very large radius** rebuilds a lot of geometry per stroke.

See [`PERFORMANCE.md`](PERFORMANCE.md) for the measured figures.

---

## Two people editing the same project see different things

Collaboration is CRDT-based, so edits merge rather than overwrite and the documents converge. If
they have _stopped_ converging:

- Check both browsers show connected. A disconnected editor keeps working locally and merges on
  reconnect, which looks identical to divergence until it reconnects.
- Reload one of them. The room state is authoritative and a reload re-syncs from it.
- If a reload does not fix it, the room's document failed to validate on save — the server logs
  that and refuses to overwrite good history with bad, so the last valid version is still there
  under History.

---

## Where to get the actual error

The editor reports uncaught errors and rejected promises, not just render-time crashes, and every
API response carries a correlation id in the `x-correlation-id` header.

With that id, one command shows every service that touched the request:

```bash
pnpm trace hela_abc123def456
```

That is the fastest route from "it broke" to "here is which stage failed and why" — considerably
faster than reading logs.
