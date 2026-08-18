import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The step-by-step guide, checked for the ways a hand-written page rots.
 *
 * Not its prose — nothing here can tell whether a sentence is still true. What it can tell is
 * whether the page still hangs together: a chapter in the contents that no longer exists, a
 * screenshot that was renamed, a link to a document somebody deleted. Every one of those is
 * invisible in review, because the page still renders and the broken part is the part nobody
 * scrolled to.
 *
 * Deliberately parsing with regular expressions rather than adding an HTML parser. The file is one
 * page written by hand in this repository, not arbitrary markup from the internet, and a dependency
 * for a dozen matches is a dependency to keep alive for a dozen matches.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDE_DIR = resolve(HERE, '../../../docs/guide');
const HTML = join(GUIDE_DIR, 'index.html');

const html = readFileSync(HTML, 'utf8');

function matchAll(pattern: RegExp): string[] {
  return Array.from(html.matchAll(pattern), (match) => match[1] as string);
}

/**
 * The contents entries, found by their numbered span rather than by their surrounding `<li>`.
 *
 * The first version matched `<li><a href="…"` on one line, which was true when it was written and
 * stopped being true the moment Prettier reformatted the file. A test that depends on where the
 * formatter breaks a line is a test that fails for the wrong reason — and this one did, twice: once
 * when the anchor moved onto its own line, and again on the single longest entry, where Prettier
 * broke the line *between the attribute and the closing bracket*. Hence the `\s*`.
 */
const TOC_ENTRY = /<a href="#([^"]+)"\s*><span class="num">(\d+)<\/span>/g;

const sectionIds = matchAll(/<section id="([^"]+)"/g);
const tocTargets = Array.from(html.matchAll(TOC_ENTRY), (match) => match[1] as string);
const figureSources = matchAll(/<img[^>]*\ssrc="(shots\/[^"]+)"/g);
const docLinks = matchAll(/href="(\.\.\/[^"#]+)/g);

describe('the guide holds together', () => {
  it('has a chapter for every entry in the contents', () => {
    // The failure this catches: a chapter renamed in one place and not the other, which reads as a
    // link that silently does nothing.
    const missing = tocTargets.filter((target) => !sectionIds.includes(target));
    expect(missing).toEqual([]);
  });

  it('has an entry in the contents for every chapter', () => {
    // The other direction, and the one more likely to happen: a chapter added and never listed, so
    // nobody finds it.
    const orphans = sectionIds.filter((id) => !tocTargets.includes(id));
    expect(orphans).toEqual([]);
  });

  it('numbers the chapters in the order they appear', () => {
    /**
     * The contents is numbered by hand, because the numbers are also spoken in the prose — "see
     * chapter 22". A renumbering that misses one is the kind of error a reader trusts and follows
     * to the wrong place.
     */
    const numbers = Array.from(html.matchAll(TOC_ENTRY), (match) => Number(match[2]));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it('points every screenshot at a file that exists', () => {
    const missing = figureSources.filter((source) => !existsSync(join(GUIDE_DIR, source)));
    expect(missing).toEqual([]);
    // A guide about a visual editor with no pictures has gone wrong in some other way.
    expect(figureSources.length).toBeGreaterThan(10);
  });

  it('links only to documents that are still there', () => {
    const missing = docLinks.filter((link) => !existsSync(join(GUIDE_DIR, link)));
    expect(missing).toEqual([]);
  });

  it('fetches nothing from the internet', () => {
    /**
     * The guide has to open from a folder somebody unzipped, offline. A stylesheet or a script from
     * a CDN is a page that is blank exactly when the reader most needs it — on a machine that has
     * just been set up, or on a train.
     *
     * Links in prose to real websites are fine and are excluded; what must not appear is a
     * `<link>`, `<script>` or `<img>` that loads from elsewhere.
     */
    const external = [
      ...matchAll(/<link[^>]*\shref="(https?:[^"]+)"/g),
      ...matchAll(/<script[^>]*\ssrc="(https?:[^"]+)"/g),
      ...matchAll(/<img[^>]*\ssrc="(https?:[^"]+)"/g),
    ];
    expect(external).toEqual([]);
  });

  it('ships the stylesheet and the script it asks for', () => {
    for (const asset of ['guide.css', 'guide.js']) {
      expect(html).toContain(asset);
      expect(existsSync(join(GUIDE_DIR, asset))).toBe(true);
    }
  });
});
