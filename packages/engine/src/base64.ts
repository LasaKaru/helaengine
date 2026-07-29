const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(256).fill(255);
  for (let index = 0; index < ALPHABET.length; index += 1) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/**
 * Base64 encode/decode without `btoa`, `atob` or `Buffer`.
 *
 * Terrain data is encoded in the browser (the editor), in Node (tests, and the server-side export
 * worker from Sprint 32) and inside exported projects. Hand-rolling ~40 lines beats branching on
 * which globals happen to exist in each of those, and keeps the engine free of a polyfill
 * dependency it would otherwise carry into every export.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    out +=
      ALPHABET[(chunk >> 18) & 63]! +
      ALPHABET[(chunk >> 12) & 63]! +
      ALPHABET[(chunk >> 6) & 63]! +
      ALPHABET[chunk & 63]!;
  }

  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index]! << 16;
    out += `${ALPHABET[(chunk >> 18) & 63]!}${ALPHABET[(chunk >> 12) & 63]!}==`;
  } else if (remaining === 2) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    out += `${ALPHABET[(chunk >> 18) & 63]!}${ALPHABET[(chunk >> 12) & 63]!}${ALPHABET[(chunk >> 6) & 63]!}=`;
  }

  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  // Padding is kept rather than stripped: the output length is derived from the group count minus
  // the padding, and dropping "=" first loses the information needed to get the tail right.
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const groups = Math.floor(clean.length / 4);
  if (groups === 0) return new Uint8Array(0);

  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(groups * 3 - padding);

  let out = 0;
  for (let group = 0; group < groups; group += 1) {
    const index = group * 4;
    const chunk =
      (sextet(clean, index) << 18) |
      (sextet(clean, index + 1) << 12) |
      (sextet(clean, index + 2) << 6) |
      sextet(clean, index + 3);

    if (out < bytes.length) bytes[out++] = (chunk >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (chunk >> 8) & 255;
    if (out < bytes.length) bytes[out++] = chunk & 255;
  }

  return bytes;
}

/** A single base64 digit. Padding and anything unrecognised contribute zero bits. */
function sextet(text: string, index: number): number {
  const value = LOOKUP[text.charCodeAt(index)]!;
  return value === 255 ? 0 : value;
}
