/**
 * A static file server, in plain Node with no dependencies.
 *
 * `npx serve` would need a download; a batch file calling Python would need Python. This needs only
 * the Node in this folder, which keeps the whole "try HelaEngine" story to: unzip, double click,
 * use it.
 *
 * It serves its own folder by default, and any folder given as an argument — which is what makes it
 * useful twice. An exported game cannot be opened from `file://` (browsers refuse to fetch models
 * over it, and the screen just stays black), so the commonest question after a first export is how
 * to play the thing locally. The answer should not be "install a web server":
 *
 *   node path\to\serve.js .          serve this folder
 *   node path\to\serve.js . 5175     ...on another port, alongside the editor
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const PORT = Number(process.argv[3] || process.env.PORT || 5174);

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`Nothing to serve: ${ROOT} is not a folder.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(
    `${ROOT} has no index.html, so there is nothing to open.\n` +
      'If this is an exported game, point at the folder you unzipped, not the zip.',
  );
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

http
  .createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));

    // Anything outside the folder is refused rather than served. This listens on localhost only,
    // but a path-traversal bug is not something to leave lying around regardless.
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    // A single-page app: unknown paths are routes, not missing files.
    if (!fs.existsSync(file)) file = path.join(ROOT, 'index.html');

    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(response);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  HelaEngine is running.');
    console.log('');
    console.log('    http://localhost:' + PORT);
    console.log('');
    console.log('  Leave this window open while you use it. Close it to stop.');
    console.log('');
  });
