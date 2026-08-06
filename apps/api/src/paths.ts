import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Is this path really inside that directory?
 *
 * Written out because the obvious version is subtly wrong, and it was wrong here (Sprint 34).
 * Every local store in this repo guarded itself with
 *
 *   target.startsWith(root)
 *
 * which is true for `/data/assets-old/secret.glb` when the root is `/data/assets` — a *sibling*
 * directory whose name merely shares a prefix. `join` normalises `..` away, so the classic
 * traversal was already refused; this is the narrower case underneath it, and the difference is
 * one separator.
 *
 * `relative` is the honest test: a path inside the root has a relative form that neither starts
 * with `..` nor is absolute. It also handles Windows separators and case, which string comparison
 * on a prefix does not.
 */
export function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
