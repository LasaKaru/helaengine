/**
 * Matching a rig's bone names against the parts an engine feature needs.
 *
 * Shared by the ragdoll binder and the foot placer, and extracted the moment there were two of them
 * — the matching rules below are subtle enough that a second copy would have drifted from the first
 * on the next exporter somebody tried.
 */

/** Bone name reduced to something the patterns can be compared against. */
export function normaliseBoneName(name: string): string {
  // `mixamorig:LeftUpLeg` and `Bone.Left.Up.Leg` both become `leftupleg`. Separators go because
  // every exporter picks a different one, and the tokens either side are what carry the meaning.
  return name
    .toLowerCase()
    .replace(/^.*[:|]/, '')
    .replace(/[\s._-]+/g, '');
}

/**
 * True when a normalised bone name carries the given side marker.
 *
 * Side markers are deliberately matched as separated tokens (`_l`, `.l`, `left`) rather than a bare
 * `l`, because half the bones in a rig contain the letter L — `Shoulder` and `Pelvis` among them —
 * and a naive match binds the left forearm to the pelvis with total confidence.
 */
export function boneIsSided(normalised: string, side: 'l' | 'r'): boolean {
  const other = side === 'l' ? 'r' : 'l';
  const word = side === 'l' ? 'left' : 'right';
  const otherWord = side === 'l' ? 'right' : 'left';

  if (normalised.includes(otherWord)) return false;
  if (normalised.includes(word)) return true;
  // A trailing marker, which is what survives normalising `Thigh_L`. Anchored to the end so
  // `Clavicle` does not read as a left-hand bone.
  if (normalised.endsWith(other)) return false;
  return normalised.endsWith(side);
}

/**
 * Binds each part to the first unclaimed bone whose name matches one of its patterns.
 *
 * `parts` is walked in order and each match is claimed, so a part listed earlier wins a bone a later
 * one would also have accepted — which is what keeps the more specific pattern in front. Parts whose
 * name ends in `L` or `R` additionally require that side marker.
 */
export function guessBoneNames<Part extends string>(
  parts: readonly Part[],
  patterns: Readonly<Record<Part, readonly string[]>>,
  boneNames: readonly string[],
): Record<Part, string> {
  const bound = Object.fromEntries(parts.map((part) => [part, ''])) as Record<Part, string>;
  const taken = new Set<string>();

  for (const part of parts) {
    const wantsSide = part.endsWith('L') ? 'l' : part.endsWith('R') ? 'r' : null;

    for (const pattern of patterns[part]) {
      const flatPattern = pattern.replace(/[\s._-]+/g, '');
      const match = boneNames.find((name) => {
        if (taken.has(name)) return false;
        const flat = normaliseBoneName(name);
        if (!flat.includes(flatPattern)) return false;
        return wantsSide === null || boneIsSided(flat, wantsSide);
      });

      if (match) {
        bound[part] = match;
        taken.add(match);
        break;
      }
    }
  }

  return bound;
}
