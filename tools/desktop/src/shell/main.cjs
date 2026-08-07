/**
 * The desktop shell around an exported game.
 *
 * This file is copied verbatim into every packaged build and is the *only* code the desktop target
 * adds. The game inside it is the ordinary web export, byte for byte — same `index.html`, same
 * `main.js`, same `engine/runtime.js`. That is deliberate: a desktop build that ran different code
 * from the web build would need testing twice and would diverge on the third change.
 *
 * Two things earn their place here.
 *
 * **A custom protocol instead of `file://`.** An export is ES modules that `fetch` their scene and
 * assets, and browsers refuse both over `file://` — which is why double-clicking an exported
 * `index.html` shows a black screen. The usual fix is to start an HTTP server inside the app, and
 * it works, but it costs a listening socket: a Windows Firewall prompt on first launch, a port that
 * might be taken, and a game that is briefly reachable from the local network. A registered scheme
 * has none of those. Nothing listens; requests are answered from disk.
 *
 * **Renderer privileges off.** The game is web content and is treated as such: no Node integration,
 * context isolation on, sandbox on. It cannot read the filesystem, spawn a process or require a
 * module even if something inside it tried — which matters because a game may ship assets its
 * author did not write. This mirrors the guarantee the browser export already gives, rather than
 * quietly dropping it on the way to the desktop.
 */
const { app, BrowserWindow, Menu, protocol, net, shell, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveWithin } = require('./resolve-within.cjs');

/** Written next to this file by the packager. */
const config = require('./hela-desktop.json');

const APP_ROOT = path.join(__dirname, 'game');
const SCHEME = 'hela';
const ORIGIN = `${SCHEME}://game`;

// Must happen before `app.whenReady`, and the privileges are not optional. `standard` makes
// `hela://game/assets/x.glb` resolve relative URLs the way `http` does; `supportFetchAPI` is what
// lets the runtime fetch `scene.json`; `secure` puts the origin in the trusted bucket so ES modules
// and WebAssembly are allowed. Miss any one and the failure is a black screen with a console error
// nobody sees, because a packaged game has no console open.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const window = new BrowserWindow({
    // Capped at the work area so a 1600x900 default does not open off-screen on a laptop, which is
    // the commonest first-run complaint about desktop builds.
    width: Math.min(1600, width),
    height: Math.min(900, height),
    minWidth: 640,
    minHeight: 480,
    backgroundColor: config.backgroundColor || '#000000',
    // The window is created hidden and shown on `ready-to-show`, so the first thing a player sees
    // is the game rather than a white rectangle while the runtime boots.
    show: false,
    title: config.productName,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Nothing in an export uses these, and both are attack surface in a window that will load
      // whatever the author put in their scene.
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });

  // A game with a File/Edit/View menu bar is a web page pretending to be a game. F11 and the
  // in-game controls are the whole interface.
  Menu.setApplicationMenu(null);

  window.once('ready-to-show', () => {
    window.show();
    if (config.fullscreen) window.setFullScreen(true);
  });

  // Mouse look needs pointer lock, and Electron asks before granting it. Everything else is
  // refused: an exported game has no business reading a microphone, and the default handler would
  // approve some of these silently.
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'pointerLock' || permission === 'fullscreen');
  });

  // A link to a real website opens in the player's browser rather than replacing the game with a
  // web page it cannot navigate back from — a packaged game has no address bar and no back button.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // F11 for fullscreen. Escape is left alone on purpose — the game uses it to pause, and a shell
    // that stole it would break the pause menu in a way the author could not fix.
    if (input.key === 'F11') {
      window.setFullScreen(!window.isFullScreen());
      event.preventDefault();
    }
  });

  void window.loadURL(`${ORIGIN}/index.html`);
  return window;
}

// A second copy of a game fighting the first over the same window is worse than no second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  void app.whenReady().then(() => {
    protocol.handle(SCHEME, async (request) => {
      const file = resolveWithin(APP_ROOT, new URL(request.url).pathname);
      if (!file) return new Response('Forbidden', { status: 403 });
      try {
        return await net.fetch(pathToFileURL(file).toString());
      } catch {
        // A missing file must be a 404, not a rejected request. `net.fetch` on a `file://` URL
        // throws when the path does not exist, and letting that escape turns every 404 into
        // "Failed to fetch" in the page — which is the message a player sees when their network
        // is down, and it sends whoever debugs it looking for a network problem that is not there.
        return new Response('Not found', { status: 404 });
      }
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention is to stay resident with no windows. A game is not a document editor:
    // closing the window means you are done playing, on every platform.
    app.quit();
  });
}
