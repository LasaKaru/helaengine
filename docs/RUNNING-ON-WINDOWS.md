# Running HelaEngine on Windows

## Just want to use it? Don't clone anything.

`HelaEngine-Windows.zip` (16 MB) is a complete copy of the editor: no clone, no git, no pnpm, no
`npm install`, no build step, and no internet connection needed once it is running. Its one
prerequisite is a Node.js runtime, and step 1 gives you two ways to satisfy it.

### Step by step

1. **Get a Node runtime**, either way round — you only need one.

   - **The normal way:** <https://nodejs.org> → the **LTS** installer → run it → accept every
     default. Takes about a minute.
   - **Without installing anything:** download the single file
     <https://nodejs.org/dist/v22.11.0/win-x64/node.exe> (80 MB, straight from nodejs.org) and, after
     step 2, drop it into a folder called `runtime` next to `START.bat` — so the path is
     `hela-portable\runtime\node.exe`. The launcher looks there first and uses it in preference to
     anything installed. Nothing goes into Program Files, nothing touches your `PATH`, and deleting
     the folder removes every trace.

   The second is worth knowing about if the machine is locked down or you would rather not install
   things. It is also the version this bundle was tested against.

2. **Save the zip** somewhere plain — `C:\HelaEngine` or your Desktop. Avoid a folder inside
   OneDrive; OneDrive syncing a thousand files while you work is slow and occasionally locks one.

3. **Unzip it properly.** Right-click → **Extract All…** → choose the folder → **Extract**.

   > This is the step that actually goes wrong. Double-clicking a zip in Explorer shows the contents
   > in a window that _looks_ like a folder, and `START.bat` run from there fails with confusing
   > errors, because Windows has extracted the one file you clicked and nothing else. If the address
   > bar still shows `…\HelaEngine-Windows.zip`, you have not extracted it yet.

4. **Open the extracted `hela-portable` folder** and double-click **START.bat**.

5. **Windows will probably warn you.** "Windows protected your PC" — that is SmartScreen, which says
   the same about every file downloaded from the internet that is not signed with a paid-for
   certificate. Click **More info** → **Run anyway**. If you would rather check first, right-click
   `START.bat` → **Edit**: it is a few dozen lines of plain text and you can read all of it.

6. A black window opens saying `HelaEngine is running`, and your browser opens
   **<http://localhost:5174>** by itself. If it does not, type that address in yourself.

7. **Leave the black window open** while you work. Closing it stops the editor. To stop deliberately:
   close it, or press `Ctrl+C` in it.

Nothing is written outside the folder you extracted, nothing runs at startup, and deleting the folder
removes it completely.

### First five minutes

Pick **Forest clearing** from the templates → drag a tree from the left rail onto the ground → click
it and drag the arrows to move it (`W` / `E` / `R` switch between move, rotate and scale) → press
**P** to play, `WASD` to walk, **Escape** to stop. Press **?** at any time for every shortcut.

### Where your work lives

Projects save automatically into the browser's own storage, on your machine — nothing is uploaded.

Because that storage belongs to the browser rather than to you, **press `Ctrl+Shift+S` for anything
you care about.** That writes a `.hela` file: one file holding the scene, its thumbnail and every
custom model it uses. Put it in OneDrive or Google Drive and it is backed up; drop it back on the
projects screen to open it again. Clearing your browser data deletes the browser-stored copies and
does not touch the `.hela` files.

### Publishing a game you have made

**Export** produces a zip: `index.html`, the runtime and your assets. Every export is play-tested
headlessly before you are allowed to download it, so a broken one tells you what is wrong instead of
handing you a game that does not run.

To put it online, upload the unzipped contents to any static host — Netlify Drop, GitHub Pages,
Cloudflare Pages, or any web hosting you already pay for. There is no server component; it is files.
`docs/EXPORTING.md` covers each host.

To play it locally without a host, reuse the bundle's own server — it serves whatever folder you
point it at:

```powershell
cd C:\path\to\your-unzipped-export
node C:\HelaEngine\hela-portable\serve.js . 5175
```

Then open <http://localhost:5175>. Port `5175` rather than `5174` so it can run alongside the
editor.

Opening `index.html` directly by double-clicking it will **not** work. Browsers refuse to fetch
models over `file://`, so the page loads and the screen stays black. That is a browser security
rule, not a broken export — the same files work the moment they are served over `http://`.

### What this bundle does not include

Accounts, cloud saving, version history, model uploads and real-time collaboration need a database
and three background services, so they are not in the portable copy. Everything else — the editor,
terrain, behaviours, physics, enemies, combat, audio, play preview, `.hela` files and export — works
here with no internet connection at all. For the rest, see Level 2 below.

### Why a folder rather than one `.exe`

A single `.exe` was the obvious thing to ship and is the worse one, so here is the reasoning rather
than a silent substitution.

Node can produce a single-file executable, but the assets — 499 models and their thumbnails, about
30 MB — cannot usefully live inside it; it would unpack them to a temporary folder on every launch.
So a "single file" is really this same folder with a slower and less visible first run. Worse, an
unsigned `.exe` is treated far more harshly than an unsigned `.bat`: SmartScreen blocks it more
firmly, and corporate antivirus routinely quarantines unsigned executables outright, with no message
to the person who ran it. Signing it needs a code-signing certificate — a few hundred dollars a year
and a registered company.

The folder costs one extra step (extract), carries no quarantine risk, and every file in it can be
read. If a signed installer becomes worth it — it would be, for public distribution — the thing to
build is an MSI or an Electron app with a real certificate, not an unsigned `.exe`.

### Why the runtime is a separate download rather than inside the zip

The build can bundle `node.exe` (see below), and a bundle that needs _nothing_ is genuinely nicer.
It is not what is shipped here for a dull reason: it makes the zip 47 MB, over the 30 MB limit on the
channel this was delivered through.

There is a second reason not to mind. An 80 MB executable that arrives from me is one you have to
take on trust; the same file fetched from `nodejs.org` is one you do not. Given the choice was forced
anyway, pointing at the official download is the better of the two.

### Rebuilding this bundle yourself

```powershell
pnpm ingest-assets                # generates models, thumbnails and the manifest
pnpm --filter @helaengine/editor build
pnpm portable                     # writes portable\hela-portable
```

To bundle the Windows runtime so the result needs nothing installed, fetch `node.exe` once and point
the build at it:

```powershell
curl.exe -o node.exe https://nodejs.org/dist/v22.11.0/win-x64/node.exe
$env:PORTABLE_NODE_EXE = "$PWD\node.exe"; pnpm portable
```

The binary is deliberately not committed — 80 MB in git is a repository nobody wants to clone — and
the build never downloads it for you, so packaging still works offline. Without the runtime the zip
is 16 MB and asks the recipient for Node; with it, 47 MB and it asks for nothing. The read-me inside
the bundle is written at packaging time to describe whichever one you built, so it cannot tell
somebody to install Node they already have, or fail to mention Node they need.

## A note on npm

**`npm install` does not work on this repository**, and cannot be made to without changing every
package. The workspace dependencies use the `workspace:*` protocol, which pnpm and yarn understand
and npm rejects outright with `EUNSUPPORTEDPROTOCOL`.

You do not need to install pnpm separately, though — it comes with Node:

```powershell
corepack enable
```

That is one command, once, and then `pnpm` works everywhere.

---

## Setting up to develop

Everything below is for changing the engine itself, not for using it. If you only want to build
games, the portable bundle above is the whole story.

Every command is written for **PowerShell**, which is what Windows 11 opens by default. Where
`cmd.exe` differs, it is called out — the difference is almost always how an environment variable is
set, and getting that wrong is the single most common way this goes sideways on Windows.

There are three levels here. **Level 1 is the whole editor** and needs nothing but Node. Levels 2
and 3 add accounts, collaboration and sharing, and those need a database. Start at Level 1 — it is
not a cut-down version, it is the product.

---

## Level 1 — the editor, in about ten minutes

### 1. Install Node.js 22

Download the **LTS installer** from <https://nodejs.org> and run it. Accept the defaults.

Then **close and reopen PowerShell** — the installer changes your `PATH` and an already-open window
will not see it. Check:

```powershell
node -v      # v22.x.x  (anything >= 20 works)
```

### 2. Turn on pnpm

This project uses pnpm, and pins the exact version it expects. Node ships with Corepack, which
reads that pin and fetches the right pnpm for you:

```powershell
corepack enable
```

If `corepack enable` complains about permissions, run PowerShell as Administrator once for that
command only.

> **If Corepack is unavailable** (it was removed from some Node 25+ builds), install pnpm directly
> instead: `npm install -g pnpm@10`.

### 3. Install Git and clone the repository

Get Git from <https://git-scm.com/download/win> and accept the defaults.

```powershell
cd $HOME
git clone https://github.com/LasaKaru/helaengine.git
cd helaengine
git checkout claude/helaengine-game-dev-jbn5mv
```

> **Keep the path short and plain.** Windows still has a 260-character path limit in places, and
> `pnpm` creates deeply nested links. `C:\Users\you\helaengine` is fine; a folder inside
> `OneDrive\Documents\My Game Projects\...` invites trouble. If you hit "filename too long", run
> `git config --global core.longpaths true` and re-clone.

### 4. Install dependencies

```powershell
pnpm install
```

This takes a few minutes the first time. It downloads a lot — including a Chromium build that the
asset pipeline uses to render thumbnails.

### 5. Build the asset library

**This step is not optional and the editor will not start without it.** The compressed models,
their thumbnails and `manifest.json` are _generated_ output and are deliberately not committed, so
they have to be built once on your machine:

```powershell
pnpm ingest-assets
```

If that fails because Playwright's browser is missing, either install it:

```powershell
pnpm --filter @helaengine/editor exec playwright install chromium
```

…or skip the thumbnails, which only affects the little pictures on the asset cards:

```powershell
# PowerShell
$env:SKIP_THUMBNAILS = "1"; pnpm ingest-assets

# cmd.exe
set SKIP_THUMBNAILS=1 && pnpm ingest-assets
```

### 6. Start the editor

```powershell
pnpm editor
```

Open <http://localhost:5174>.

Pick a template — **Forest clearing** is a good first one — and you are in. Drag an asset from the
left rail onto the ground, press **P** to play it, **Escape** to stop. Press **?** for every
shortcut.

Your projects are saved in the browser's own storage. Nothing leaves your machine.

### 7. Save a project to your PC

Press **Ctrl+Shift+S**, or use **Save to file…** in the top bar. You get a `.hela` file: one file
holding the scene, its thumbnail and any custom models or images it uses.

Chrome and Edge remember where you put it, so the next Ctrl+Shift+S writes the same file — put it in
a OneDrive or Google Drive folder and it is backed up automatically, or in a git repository and
`git add MyLevel.hela` just works.

To open one, drop it on the projects screen or use **Choose a file…**.

---

## Level 2 — accounts, cloud projects and asset uploads

Only needed if you want sign-in, version history, or uploading your own `.glb` models. Everything in
Level 1 keeps working without it.

### 1. Install PostgreSQL

Download the installer from <https://www.postgresql.org/download/windows/>. During setup:

- Set a password for the `postgres` user and **write it down** — you need it in a moment.
- Leave the port at **5432**.
- Stack Builder at the end is not needed; skip it.

### 2. Create the database

Open **SQL Shell (psql)** from the Start menu. Press Enter through the prompts to accept the
defaults, then type the password you chose. At the `postgres=#` prompt:

```sql
CREATE DATABASE helaengine;
\q
```

### 3. Point the API at it and start it

In a **new** PowerShell window, in the repository folder:

```powershell
$env:DATABASE_URL = "postgres://postgres:YOUR_PASSWORD@localhost:5432/helaengine"
pnpm api
```

In `cmd.exe` that first line is `set DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/helaengine`.

It applies its own migrations on startup and prints `[api] listening on http://localhost:3000`.

> The variable only lives in that window. Close it and you set it again — which is fine, because
> this is the window the API runs in.

### 4. Tell the editor the API exists

Create `apps\editor\.env.local` (copy `apps\editor\.env.example` and uncomment):

```
VITE_API_ORIGIN=http://127.0.0.1:3000
```

Restart `pnpm editor`. The projects screen now has a sign-in box. Create an account — it is your own
database, so use anything. Projects you make while signed in are saved to Postgres with a version
for every save, visible under **History**, and the asset rail grows a **My Assets** section for
uploading your own models.

---

## Level 3 — collaboration and sharing

### Real-time collaboration

Needs Level 2 running. In a third window:

```powershell
$env:DATABASE_URL = "postgres://postgres:YOUR_PASSWORD@localhost:5432/helaengine"
pnpm --filter @helaengine/collab-server start
```

Add to `apps\editor\.env.local` and restart the editor:

```
VITE_COLLAB_ORIGIN=ws://127.0.0.1:3200
```

Now open the same **cloud** project in two browser windows. Edits appear in both, each person's
selection is outlined in their own colour, and their initials show in the top bar. A project stored
only in your browser has no room to join — collaboration is a cloud-project feature.

### Sharing an export as a link

```powershell
pnpm --filter @helaengine/share start
```

```
VITE_SHARE_ORIGIN=http://127.0.0.1:4000
```

Only reachable from your own machine — this is a local server, not a public host.

### Building exports on a server

For large projects: the build runs outside the browser, so it cannot exhaust the tab's memory and it
survives closing it. Needs Level 2, plus **Redis** — install
[Memurai](https://www.memurai.com/get-memurai) (a Redis-compatible Windows service) or run Redis
inside WSL2.

```powershell
$env:DATABASE_URL = "postgres://postgres:YOUR_PASSWORD@localhost:5432/helaengine"
pnpm --filter @helaengine/export-worker start
```

The worker needs the generated asset library and the built engine, so run `pnpm ingest-assets` and
`pnpm --filter @helaengine/engine build` first — it says so plainly if either is missing.

With it running, the Export dialog grows a **Build on the server** section showing how many exports
are left this period. Without Redis the editor works exactly as before: the in-browser export is
still there, and is still the better choice for a small level.

### Co-op multiplayer in exported games

```powershell
pnpm --filter @helaengine/realtime start
```

Runs on port 2567. Needed only by exported games whose scene enables co-op.

### Seeing what the servers are doing

Nothing is recorded unless you ask for it. To follow a request across the API and the worker on
your own machine, start both with a trace file — the same one, or they cannot be joined:

```powershell
$env:HELA_TRACE_FILE = "$PWD\.hela-traces\spans.ndjson"
pnpm api
# in another window, with the same variable set
pnpm --filter @helaengine/export-worker start
```

Then export something and follow it:

```powershell
pnpm trace                        # the last twenty requests
pnpm trace hela_9f3c1a2b4d5e6f70  # one of them, in full
```

The id is on every response as the `x-correlation-id` header, on the editor's crash screen, and
under a failed export. `http://localhost:3000/metrics` is the same numbers in Prometheus format.
`docs/RUNBOOK.md` explains what to do with any of it.

---

## Ports, in one place

| What                       | Port | Needs a database |
| -------------------------- | ---- | ---------------- |
| Editor                     | 5174 | no               |
| Runtime demo (`pnpm demo`) | 5173 | no               |
| Platform API               | 3000 | yes              |
| Collaboration server       | 3200 | yes              |
| Export worker (health)     | 3300 | yes, plus Redis  |
| Share service              | 4000 | no               |
| Co-op server               | 2567 | no               |

---

## Windows-specific problems, and what they actually mean

**`pnpm : File ... cannot be loaded because running scripts is disabled`**
PowerShell's execution policy. Run once:
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

**`'VITE_API_ORIGIN' is not recognized as an internal or external command`**
You used Unix syntax (`VAR=value command`). On Windows set the variable on its own line first — or
better, use `apps\editor\.env.local`, which works identically on every platform.

**`Could not load the asset manifest (404)`**
`pnpm ingest-assets` has not been run, or was run in a different folder. See Level 1 step 5.

**`EADDRINUSE: address already in use :::5174`**
Something is already on that port — most often a previous `pnpm editor` you closed the window on
rather than stopping. Find and end it:
`Get-NetTCPConnection -LocalPort 5174 | Select-Object OwningProcess` then
`Stop-Process -Id <that number>`

**The viewport is black, or WebGL fails**
Update your graphics driver, and make sure hardware acceleration is on in the browser
(`chrome://settings/system`). The editor needs a working WebGL 2 context.

**`ECONNREFUSED 127.0.0.1:5432`**
Postgres is not running. Open **Services**, find `postgresql-x64-*`, and start it.

**`password authentication failed for user "postgres"`**
The password in `DATABASE_URL` does not match the one set during installation. Special characters in
it must be percent-encoded — `@` becomes `%40`, `#` becomes `%23`.

**Antivirus makes `pnpm install` crawl**
Windows Defender scanning `node_modules` is a known cause. Adding the repository folder to Defender's
exclusions helps a great deal, though that is your call to make.

---

## Running the tests

```powershell
pnpm test          # ~790 unit tests, no database needed except the API's
pnpm lint
pnpm typecheck
```

The API's own tests need a database. Create it once (`CREATE DATABASE helaengine_test;`) then:

```powershell
$env:TEST_DATABASE_URL = "postgres://postgres:YOUR_PASSWORD@localhost:5432/helaengine_test"
pnpm --filter @helaengine/api test
```

The end-to-end suite drives a real browser and needs Playwright's Chromium plus a database, since it
starts the API and collaboration server itself:

```powershell
pnpm --filter @helaengine/editor exec playwright install chromium
$env:TEST_DATABASE_URL = "postgres://postgres:YOUR_PASSWORD@localhost:5432/helaengine_e2e"
pnpm e2e
```

> **`pnpm --filter @helaengine/editor e2e:export` does not work on Windows.** It wraps Playwright in
> `xvfb-run`, which is a Linux virtual display and neither exists nor is needed here. Run the same
> suite directly instead:
> `pnpm --filter @helaengine/editor exec playwright test export-qa`

---

## Using WSL2 instead

If you would rather have the Linux environment this project is developed and tested in, install WSL2
(`wsl --install` in an Administrator PowerShell), then follow the ordinary Linux instructions inside
Ubuntu. Two things to know:

- **Keep the repository inside the Linux filesystem** (`~/helaengine`), not under `/mnt/c/`. Node
  file watching across the Windows/Linux boundary is slow enough to be painful.
- Servers started in WSL2 are reachable from Windows browsers at `localhost` as normal.

This is the better path if you plan to run the export QA suite or work on the project itself. For
using the editor, native Windows is perfectly fine.
