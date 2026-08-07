# Shipping a game as a Windows `.exe`

An export is a web page. This turns one into a program a player double-clicks — no browser, no
server, no address bar, no "which folder do I serve".

```powershell
pnpm package-desktop .\my-game --name "My Game" --icon .\icon.ico
```

Out comes `desktop-builds\My-Game-win32-x64\`, containing `My Game.exe`. Zip it and send it; the
player extracts and double-clicks.

---

## What it actually does

It wraps the export in [Electron](https://electronjs.org) — the same Chromium the game already
targets, packaged as an application.

**The export goes in unchanged.** Not rewritten, not re-bundled, no paths fixed up: `index.html`,
`main.js`, `engine/runtime.js` and `assets/` are copied byte for byte into `resources/app/game/`.
That is the design, and it is what makes the desktop build the same game as the web build rather
than a near-relative. An export that passed the release gate has already been tested where it
counts, and there is no second renderer to keep in step.

The only code this tool adds is the shell: two files, about 150 lines, in
`tools/desktop/src/shell/`. They are copied into the build in plain text and can be read in the
shipped game.

### Why a custom protocol rather than a local server

A game cannot be opened from `file://` — browsers refuse to load ES modules or `fetch` over it, so
double-clicking an exported `index.html` gives a black screen. Something has to serve the files.

The obvious answer is an HTTP server inside the app, and it works. It also costs a listening socket:
a Windows Firewall prompt on first launch, a port that may be taken, and a game briefly reachable
from the local network. So the shell registers a `hela://` scheme instead. Nothing listens; requests
are answered from disk. No prompt, no port, nothing on the network.

### The page has no Node privileges

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and a permission handler that
grants pointer lock and full screen and refuses everything else.

This matters more than it looks. A game ships assets, and an author who pastes a snippet into their
export or uses a model pack with an embedded script is running code they did not write. The browser
export gives that code no filesystem access; a careless desktop wrapper silently takes the guarantee
away. There is a test asserting `require`, `process` and `module` are all undefined in the page.

The one place with real filesystem access is the protocol handler, and every request goes through a
containment check first — `tools/desktop/src/shell/resolve-within.cjs`, which has its own file and
its own tests because it is the only function here whose failure is a security failure, not a broken
game.

---

## Options

| Flag               | What it does                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `--name "My Game"` | Product name. Becomes `My Game.exe` and the title bar. Defaults to the scene's name.         |
| `--icon icon.ico`  | Windows icon. Must be a real `.ico` — a renamed `.png` is refused, with a message saying so. |
| `--version 1.2.3`  | Stamped into the executable's version resource.                                              |
| `--platform`       | `win32-x64` (default), `win32-arm64`, `linux-x64`.                                           |
| `--fullscreen`     | Start full-screen. Off by default; a game that seizes the display on first run is alarming.  |
| `--out folder`     | Where to write the build. Defaults to `./desktop-builds`.                                    |
| `--offline`        | Fail rather than download Electron.                                                          |

The executable carries the game's name, description and version, so Task Manager, the taskbar and
the Properties dialog say the game rather than "Electron". That is done in pure TypeScript with
`resedit`, not with the usual `rcedit.exe`, so a Windows build can be packaged **from Linux** — which
is the normal case for a CI pipeline.

---

## Three things to know before you ship one

### 1. It is big

|                                     |        |
| ----------------------------------- | ------ |
| The export itself (Forest Clearing) | 4.4 MB |
| The packaged Windows build          | 273 MB |
| Zipped for download                 | 111 MB |

Almost all of that is Chromium, and it is the same 270 MB whether the game is a forest clearing or a
forty-hour campaign — so the _proportional_ cost falls fast as a game grows. Still: for a small game
the web export is 4 MB and plays instantly from a link, and the desktop build is 111 MB somebody has
to download first. Ship the web export when a link will do. Ship the `.exe` when the game needs to
feel like a program: an itch.io release, a client who wants a file, a machine with no internet.

**A leaner runtime is possible and is not built yet.** Tauri uses the operating system's own WebView2
instead of bundling Chromium, which is roughly a 10 MB build rather than 270. The cost is that the
game then runs on whatever Edge version the player has, so "works on my machine" comes back — and
that is exactly the class of bug the release gate exists to eliminate. Worth revisiting when there
are enough desktop builds for the download size to be a real complaint.

### 2. Windows will warn about it, and that is not fixable for free

SmartScreen shows "Windows protected your PC" for any executable downloaded from the internet that
is not signed with a code-signing certificate. The player clicks **More info** → **Run anyway**; the
generated `README.txt` in every build tells them so, in those words.

Making it stop needs a certificate:

- **OV (organisation validated)** — a few hundred dollars a year, needs a registered company, and
  the warning persists until the signed binary has built enough download reputation.
- **EV (extended validation)** — more expensive, usually on a hardware token, and gets SmartScreen
  reputation immediately.

There is no free path and no trick. Anything claiming otherwise is either wrong or is telling
players to disable a security feature. Signing is a business decision, so this tool does not pretend
to make it: it stamps identity into the executable, says plainly that the build is unsigned, and
stops there.

If you do get a certificate, signing is one command (`signtool sign /fd sha256 …`) run on the
produced `.exe` — no change to this pipeline.

### 3. There is no macOS target

Deliberately. A macOS build is not a folder but an `.app` bundle, and since Catalina an unsigned,
un-notarised bundle downloaded from the internet is not merely warned about — Gatekeeper refuses to
open it, offering only "Move to Bin". Producing one would be producing something that does not run.
It needs an Apple Developer account and a notarisation step, and that is a separate piece of work
rather than another entry in a list. The CLI says this rather than failing obscurely.

---

## What has been verified

Not "should work" — run, and the result observed.

|                                      |                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A real game plays in the shell**   | Forest Clearing packaged and launched: menu → Play → walked 13.99 m on held `W`, 100 HP, physics started, **0 assets failed**, terrain and trees rendering with shadows in the screenshot.                                                                                                      |
| **The four things `file://` breaks** | ES module import, `fetch` of `scene.json`, `fetch` of a binary asset byte-for-byte, and a WebGL context — each asserted separately in a packaged build.                                                                                                                                         |
| **The page has no Node access**      | `require`, `process` and `module` all `undefined` in the renderer.                                                                                                                                                                                                                              |
| **Path containment**                 | A percent-encoded escape is answered `403`. Asserted as `403` specifically, not "403 or 404": with the check deleted the request is _still_ answered 404 by Electron for reasons of its own, so accepting 404 would pass with no containment check at all. Deleting the check fails four tests. |
| **A missing asset is a 404**         | Not a rejected request. A rejected request reads as a network problem, and an exported game has no network.                                                                                                                                                                                     |
| **The version resource**             | A real `electron.exe` rewritten and the UTF-16 strings read back out, then re-checked as a valid PE file.                                                                                                                                                                                       |
| **The icon**                         | A real icon replaced and its pixels found in the executable afterwards. A renamed `.png` produces a warning and a working build — found because the icon parser accepts one silently and would have stripped the icon with nothing said.                                                        |
| **Checksum on the runtime**          | The Electron archive is verified against the release's own `SHASUMS256.txt` before it is unpacked. This binary becomes the file a player double-clicks.                                                                                                                                         |

`.github/workflows/desktop.yml` runs all of it. It packages for **linux-x64** rather than Windows,
which is the right test rather than a compromise: the packaging is one code path and the shell is
one file, so what differs between targets is only which archive was unpacked. The genuinely
Windows-only parts — the version resource and the icon — are tested against a real `electron.exe`.

---

## Where the Electron download lives

`~/.cache/helaengine/electron`, keyed by version and platform, verified once and marked. Override
with `HELA_ELECTRON_CACHE`.

It is not committed and the build never fetches it silently on your behalf beyond the first run per
platform: 100 MB in git is a repository nobody wants to clone, and `--offline` fails loudly rather
than reaching out.

The Electron version is **pinned to an exact version**, not a range. It decides the Chromium version,
which decides what WebGL, WebAssembly and pointer lock do — a game packaged today and one packaged
next month should not differ in their renderer because a dependency moved underneath them. Bumping
it is a deliberate act with a test run attached.

---

## What this does not do yet

Honest list, in the order they would matter:

- **No installer.** The output is a folder to unzip. An MSI or an NSIS installer with Start-menu
  entries and an uninstaller is the next step for anything sold rather than shared.
- **No auto-update.** Electron supports it; it needs a server to update from.
- **No Steam.** Steamworks needs an app ID, a partner account and the SDK. The packaged folder is
  the right shape for a Steam depot, so this is groundwork rather than a rewrite.
- **No save files on disk.** The game saves where the web build saves — browser storage, which
  Electron keeps in the user's app-data folder. It survives restarts and is per-machine. A real
  save-game file is an engine feature rather than a packaging one.
- **No console output window.** A crash before the first frame is currently silent. `--enable-logging`
  works, but a player would not know to use it.
