import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The containment check, tested directly.
 *
 * It has its own file and its own test because the end-to-end test cannot carry it. Running a
 * packaged build with this check deleted still answers the traversal request `404` — Electron's
 * `net.fetch` refuses the escaped path for reasons of its own — so the e2e test passes either way
 * and proves nothing about this function. Relying on that would be relying on undocumented
 * behaviour in a dependency to provide a security property.
 *
 * The e2e test asserts `403` specifically, which only this function produces; these assert the
 * function itself. Between them, deleting the check fails both.
 */

const require = createRequire(import.meta.url);
const { resolveWithin } = require('./shell/resolve-within.cjs') as {
  resolveWithin: (root: string, urlPath: string) => string | null;
};

const ROOT = '/games/hela';

describe('resolveWithin', () => {
  it('resolves an ordinary asset path', () => {
    expect(resolveWithin(ROOT, '/assets/models/tree.glb')).toBe(
      '/games/hela/assets/models/tree.glb',
    );
  });

  it('allows the root itself', () => {
    // Normalises to a trailing slash, which is contained and which the file fetch then answers 404
    // for because a directory is not a file. Allowed rather than refused: it is not an escape.
    expect(resolveWithin(ROOT, '/')).toBe(`${ROOT}/`);
  });

  it('decodes the escapes a real filename needs', () => {
    expect(resolveWithin(ROOT, '/assets/models/oak%20tree.glb')).toBe(
      '/games/hela/assets/models/oak tree.glb',
    );
  });

  it('refuses a percent-encoded escape from the folder', () => {
    // The shape that actually arrives: the URL parser normalises plain `../` away before the
    // handler sees it, so this is the only form that reaches here intact — and without this check
    // it is answered 200 with the file.
    expect(resolveWithin(ROOT, '/..%2f..%2f..%2fetc/passwd')).toBeNull();
  });

  it('refuses a plain escape, in case one ever reaches it', () => {
    expect(resolveWithin(ROOT, '/../../etc/passwd')).toBeNull();
  });

  it('refuses a sibling folder that merely starts with the root', () => {
    // A prefix check rather than a containment check would let `/games/hela-private/...` through,
    // and every path in it would look plausible in a log.
    expect(resolveWithin(ROOT, '/../hela-private/saves.dat')).toBeNull();
  });

  it('refuses a NUL byte, which truncates a path after it has been checked', () => {
    expect(resolveWithin(ROOT, '/assets/ok.glb%00/../../../etc/passwd')).toBeNull();
  });

  it('refuses a malformed escape rather than throwing', () => {
    expect(resolveWithin(ROOT, '/assets/%zz.glb')).toBeNull();
  });
});
