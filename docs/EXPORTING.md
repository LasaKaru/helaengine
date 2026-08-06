# Exporting and hosting a project

What Export gives you, how to run it, and where to put it.

## What comes out

Export produces a **folder, not an application**. There is no server, no build step and no runtime
dependency on HelaEngine — the folder is HTML, JavaScript and assets, and it runs from any static
host or from a USB stick.

```
your-project/
  index.html          the page. Open this.
  main.js             the bundled runtime and your scene, together
  scene.json          your level as data — readable, diffable, editable
  assets/
    manifest.json     what each asset is, and where its file lives
    models/*.glb      the models your scene actually uses, and no others
    audio/*           the sounds it actually plays
  engine/             the runtime, MIT licensed
  CREDITS.md          every asset that shipped, with its licence and author
  LICENSE.md          the runtime's licence, and the third-party ones it bundles
  README.md           these instructions, in the folder itself
```

Two modes:

- **Static** — the level, rendered, with camera controls. No physics, no enemies, no weapons.
  Around 920 KB of runtime. Right for showing somebody a scene.
- **Game** — everything: physics, AI, combat, saves, the menu shell. Around 3.2 MB of runtime.
  Right for something people play.

The mode is chosen in the export wizard and changes what gets bundled, not what your scene contains.
A scene with enemies exported as static still has the enemies in `scene.json`; they just do not move.

## Running it

**It will not work from `file://`.** Opening `index.html` by double-clicking gives you a blank page
and a CORS error in the console, because browsers refuse to `fetch` local files. This is the single
most common thing people hit, and it is not a bug in your export.

Any static server will do:

```bash
# Python, on almost every machine already
python3 -m http.server 8000

# Node
npx serve .

# PHP, if that is what you have
php -S localhost:8000
```

Then open `http://localhost:8000`.

## Hosting it

The folder is entirely static, so anything that serves files works. In rough order of least effort:

| Host                      | How                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **HelaEngine share link** | Press _Share_ instead of _Download_ in the export wizard. Gives you a URL immediately; no account needed for an unlisted link. |
| **Netlify / Vercel**      | Drag the folder onto their drop zone.                                                                                          |
| **GitHub Pages**          | Commit the folder to a repository, enable Pages on that branch.                                                                |
| **Cloudflare Pages**      | Point it at the repository, no build command, output directory is the folder.                                                  |
| **S3 / any bucket**       | Upload, enable static hosting, make it public.                                                                                 |
| **Your own server**       | Copy it into the web root. Nothing else to configure.                                                                          |

### Cache headers, if you control them

Everything in `assets/models/` is content-addressed — the filename contains a hash of the bytes, so
those files can never change. They can safely be cached forever:

```
Cache-Control: public, max-age=31536000, immutable
```

`index.html`, `main.js` and `scene.json` are not content-addressed and should not be cached
aggressively, or a returning player gets last week's level. `max-age=300` or plain revalidation is
right for those.

## What the export does _not_ include

Stated plainly, because finding out later is worse:

- **Nothing that was not used.** Assets your scene does not reference are left out, which is why an
  export is a few megabytes rather than the whole library. Add an object and re-export to include
  its model.
- **No editor.** The export is the game, not a copy of HelaEngine. People cannot edit the level from
  the exported folder — though they can read and modify `scene.json`, which is a feature.
- **No account, no server, no analytics.** An exported project talks to nothing. It works offline
  and it phones no one, including us.
- **No save data.** Progress saved inside an exported game lives in that browser's storage, so it
  does not travel with the folder.

## Before it lets you export

Every export runs through a release gate first: the scene is loaded headlessly, played, and checked.
A build that cannot start does not become a download. Where a fix exists — a missing asset with an
obvious substitute, a behaviour parameter out of range — it is applied and **reported**, and the
repair is written back into your project rather than only into the zip, so you do not hit it again
next time.

Where no fix exists, the export is refused with the reason. That is deliberate: a broken folder that
somebody has already sent to a friend is a much worse outcome than a refusal with a sentence.

What the gate checks lives in `tools/smoke` and is described in [`GUIDE.md`](GUIDE.md) under
Sprint 23. Run it yourself against any exported folder:

```bash
pnpm smoke path/to/your-project
pnpm smoke path/to/your-project --repair   # let it try to fix what it finds
```
