/**
 * Maps a request path onto a file inside the game folder, or refuses.
 *
 * Its own file, shipped beside `main.cjs`, so it can be unit tested without starting Electron. That
 * matters more than the tidiness: this is the one function in the desktop shell whose failure is a
 * security failure rather than a broken game, and a test that needs a windowing system to run is a
 * test that gets skipped.
 *
 * The refusal is not hypothetical. `hela://game/..%2f..%2f..%2fetc/passwd` reaches the handler with
 * the escapes still encoded — the URL parser normalises the *plain* `../` form away, so the encoded
 * one is the only shape that arrives intact, and it is the shape an attacker would use. Verified by
 * observation, not assumed: without this check that request answers 200 with the file.
 *
 * "An attacker" here is not far-fetched. A game ships assets, and an author who pastes a snippet
 * into their export, or uses a model pack with an embedded script, is running code they did not
 * write inside a window whose protocol handler has the main process's filesystem access.
 */
const path = require('node:path');

function resolveWithin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed escape (`%zz`) throws. Refusing is right — nothing in an export produces one.
    return null;
  }

  // A NUL byte truncates a path in some system calls, so `assets/x.glb\0../../etc/passwd` can pass
  // a string check and open a different file than the one that was checked.
  if (decoded.includes('\0')) return null;

  const file = path.normalize(path.join(root, decoded));
  // The separator is what makes this a containment check rather than a prefix check: without it a
  // root of `/games/hela` would also accept `/games/hela-private/save.dat`.
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

module.exports = { resolveWithin };
