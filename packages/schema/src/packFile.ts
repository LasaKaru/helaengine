import {
  PACK_FORMAT_VERSION,
  PackFrontmatterSchema,
  PackPatchSchema,
  type PackPatch,
  type SkillPack,
} from './pack.js';

/**
 * Reading a `.md` skill pack.
 *
 * The file is untrusted input, so this is a trust boundary and behaves like one: it parses, it
 * validates, and it fails with a message naming what was wrong. It never evaluates anything — the
 * patches are JSON inside fenced blocks, and JSON has no way to express a function.
 *
 * ## The shape
 *
 * ```markdown
 * ---
 * id: forest-atmosphere
 * name: Forest atmosphere
 * description: A breeze, two layers of ground cover and a warm afternoon look.
 * ---
 *
 * Prose explaining the choices. Shown before anything is applied.
 *
 * ```hela
 * [
 *   { "op": "applyLook", "look": "realistic" },
 *   { "op": "setWind", "value": { "strength": 0.8, "direction": 120 } }
 * ]
 * ```
 * ```
 *
 * Several `hela` blocks are allowed and are concatenated in document order, so a pack can explain
 * each step next to the patches that perform it rather than dumping everything at the end.
 */

export class PackParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PackParseError';
  }
}

/** The fence language that marks a patch block. Anything else is prose and is ignored. */
const PATCH_FENCE = 'hela';

/**
 * Frontmatter, as the small subset of YAML a pack header actually needs.
 *
 * A YAML parser is a dependency and an attack surface — the format has anchors, merge keys, and a
 * history of parsers that instantiate arbitrary types. A pack header is `key: value` and one list,
 * so this reads exactly that and refuses the rest. Anything more expressive belongs in the patch
 * blocks, where it is JSON and validated by Zod.
 */
function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new PackParseError(`the pack header line "${line}" is not "key: value"`);
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    // Quotes are optional and stripped when present, so `name: Forest` and `name: "Forest"` are the
    // same thing — which is what somebody writing one by hand will expect.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    // One list form: `tags: [a, b]`. Nested structures are deliberately not supported.
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      result[key] =
        inner === ''
          ? []
          : inner.split(',').map((entry) => entry.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    result[key] = value;
  }

  return result;
}

interface Split {
  frontmatter: string;
  rest: string;
}

/** Separates the `---` header from the body. */
function splitFrontmatter(source: string): Split {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    throw new PackParseError('a skill pack must begin with a --- header');
  }

  const end = text.indexOf('\n---', 3);
  if (end === -1) throw new PackParseError('the pack header is never closed with ---');

  return {
    frontmatter: text.slice(4, end),
    rest: text.slice(text.indexOf('\n', end + 1) + 1),
  };
}

/**
 * Every fenced `hela` block, and the prose with those blocks removed.
 *
 * Written as a scan rather than a regex with a global flag: a regex over a whole document with
 * nested backticks in prose is a source of quiet mismatches, and this needs to be exact about where
 * a block starts and ends.
 */
function extractBlocks(body: string): { blocks: string[]; prose: string } {
  const blocks: string[] = [];
  const prose: string[] = [];
  const lines = body.split('\n');

  let inside = false;
  let current: string[] = [];

  for (const line of lines) {
    const fence = line.trimStart();

    if (!inside && fence.startsWith('```')) {
      const language = fence.slice(3).trim();
      if (language === PATCH_FENCE) {
        inside = true;
        current = [];
        continue;
      }
      // A fence in some other language is prose — a pack may show example code.
      prose.push(line);
      continue;
    }

    if (inside && fence.startsWith('```')) {
      inside = false;
      blocks.push(current.join('\n'));
      continue;
    }

    if (inside) current.push(line);
    else prose.push(line);
  }

  if (inside) throw new PackParseError('a hela block is never closed with ```');

  return { blocks, prose: prose.join('\n').trim() };
}

/**
 * Reads a pack from markdown.
 *
 * Throws `PackParseError` with a message naming the problem — the header, a block's JSON, or the
 * patch that failed validation. A file that "nearly" parses is refused rather than half-applied.
 */
export function parseSkillPack(source: string): SkillPack {
  const { frontmatter, rest } = splitFrontmatter(source);

  const header = PackFrontmatterSchema.safeParse(parseFrontmatter(frontmatter));
  if (!header.success) {
    throw new PackParseError(`the pack header is not valid: ${header.error.issues[0]?.message}`, {
      cause: header.error,
    });
  }

  const { blocks, prose } = extractBlocks(rest);
  if (blocks.length === 0) {
    throw new PackParseError(
      `"${header.data.name}" has no \`\`\`${PATCH_FENCE} block, so it would change nothing`,
    );
  }

  const patches: PackPatch[] = [];
  for (const [index, block] of blocks.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (error) {
      throw new PackParseError(`block ${index + 1} of "${header.data.name}" is not JSON`, {
        cause: error,
      });
    }

    // A block may hold one patch or a list of them, because both read naturally next to prose.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const [at, entry] of list.entries()) {
      const patch = PackPatchSchema.safeParse(entry);
      if (!patch.success) {
        const op =
          typeof entry === 'object' && entry !== null && 'op' in entry
            ? String((entry as { op: unknown }).op)
            : 'with no op';
        throw new PackParseError(
          `block ${index + 1}, patch ${at + 1} of "${header.data.name}" (${op}) is not a change ` +
            `this engine can make: ${patch.error.issues[0]?.message}`,
          { cause: patch.error },
        );
      }
      patches.push(patch.data);
    }
  }

  return {
    format: PACK_FORMAT_VERSION,
    frontmatter: header.data,
    body: prose,
    patches,
  };
}

/** Whether a file looks like a pack at all, for deciding what a dropped file is. */
export function looksLikeSkillPack(source: string): boolean {
  return source.replace(/^\uFEFF/, '').startsWith('---') && source.includes('```hela');
}
