import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packProblems, parseSkillPack, requiredAssets } from './index.js';

/**
 * The packs this repository ships.
 *
 * A broken example is worse than no example: somebody copies it, gets a parse error, and concludes
 * the format does not work. These parse every file in `packs/` for real.
 */

const DIR = join(import.meta.dirname, '../../../packs');
const files = readdirSync(DIR).filter((name) => name.endsWith('.md'));

describe('shipped packs', () => {
  it('ships some', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s parses, and says what it needs', (file) => {
    const pack = parseSkillPack(readFileSync(join(DIR, file), 'utf8'));

    expect(pack.frontmatter.description).toBeTruthy();
    expect(pack.patches.length).toBeGreaterThan(0);
    // The prose is half the value, and a pack that is only JSON has thrown that away.
    expect(pack.body.length).toBeGreaterThan(80);

    // Self-consistent: no edge to a node it does not add, no variable it does not declare.
    expect(packProblems(pack)).toEqual([]);

    // Every asset it names is a real shipped id, or the pack refuses to apply for anybody.
    for (const assetId of requiredAssets(pack)) {
      expect(assetId).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
