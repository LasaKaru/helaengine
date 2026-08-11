import { describe, expect, it } from 'vitest';
import {
  PackParseError,
  looksLikeSkillPack,
  packProblems,
  parseSkillPack,
  requiredAssets,
} from './index.js';

/**
 * Reading a skill pack.
 *
 * A pack arrives from somewhere — a teammate, a download, a repository — so this file is a trust
 * boundary and most of what is worth pinning is what it *refuses*.
 */

const HEADER = `---
id: forest
name: Forest atmosphere
description: A breeze and two layers of ground cover.
---
`;

const pack = (body: string): string => HEADER + body;

describe('parsing', () => {
  it('reads a header, prose and patches', () => {
    const result = parseSkillPack(
      pack(`
Wind at 0.8 rather than 2: a breeze moves a canopy, a gale reads as a storm.

\`\`\`hela
[{ "op": "setWind", "value": { "strength": 0.8, "direction": 120 } }]
\`\`\`
`),
    );

    expect(result.frontmatter.id).toBe('forest');
    expect(result.frontmatter.name).toBe('Forest atmosphere');
    // The prose is half the value: a pack that explains why 0.8 teaches something a JSON blob does
    // not, and the editor shows it before applying anything.
    expect(result.body).toContain('a gale reads as a storm');
    expect(result.patches).toEqual([{ op: 'setWind', value: { strength: 0.8, direction: 120 } }]);
  });

  it('accepts several blocks and keeps document order', () => {
    // So a pack can explain each step next to the patches that perform it.
    const result = parseSkillPack(
      pack(`
First the look.

\`\`\`hela
{ "op": "applyLook", "look": "realistic" }
\`\`\`

Then the wind.

\`\`\`hela
{ "op": "setWind", "value": { "strength": 1 } }
\`\`\`
`),
    );

    expect(result.patches.map((patch) => patch.op)).toEqual(['applyLook', 'setWind']);
  });

  it('takes one patch or a list, because both read naturally', () => {
    const single = parseSkillPack(
      pack('\n```hela\n{ "op": "applyLook", "look": "stylized" }\n```\n'),
    );
    expect(single.patches).toHaveLength(1);
  });

  it('leaves fenced blocks in other languages as prose', () => {
    const result = parseSkillPack(
      pack(`
\`\`\`ts
const notAPatch = true;
\`\`\`

\`\`\`hela
{ "op": "applyLook", "look": "stylized" }
\`\`\`
`),
    );

    expect(result.patches).toHaveLength(1);
    expect(result.body).toContain('notAPatch');
  });
});

describe('refusing', () => {
  it('refuses an op the engine has never heard of', () => {
    /**
     * The closed vocabulary, at the file boundary.
     *
     * A pack asking for `runShellCommand` is not a pack with a bad patch — it is not a pack. This
     * is the same guarantee the scene format makes, and it is why a pack can be downloaded from a
     * stranger.
     */
    expect(() =>
      parseSkillPack(pack('\n```hela\n{ "op": "runShellCommand", "cmd": "rm -rf /" }\n```\n')),
    ).toThrow(PackParseError);
  });

  it('names the op it refused, so the author can find it', () => {
    let message = '';
    try {
      parseSkillPack(pack('\n```hela\n{ "op": "installPlugin" }\n```\n'));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('installPlugin');
  });

  it('refuses a patch whose values are outside the schema', () => {
    // Bounded ranges are what stop a pack setting a wind of ten thousand metres.
    expect(() =>
      parseSkillPack(pack('\n```hela\n{ "op": "setWind", "value": { "strength": 9999 } }\n```\n')),
    ).toThrow(/setWind/);
  });

  it('refuses a file with no header', () => {
    expect(() => parseSkillPack('```hela\n[]\n```')).toThrow(/must begin with a --- header/);
  });

  it('refuses a header that is never closed', () => {
    expect(() => parseSkillPack('---\nid: x\nname: X\n')).toThrow(/never closed/);
  });

  it('refuses a header missing what a pack has to say about itself', () => {
    expect(() => parseSkillPack('---\nid: x\n---\n\n```hela\n[]\n```\n')).toThrow(
      /header is not valid/,
    );
  });

  it('refuses a pack that would change nothing', () => {
    // Silently doing nothing is the outcome a user cannot diagnose.
    expect(() => parseSkillPack(pack('\nJust prose, no patches.\n'))).toThrow(/no ```hela block/);
  });

  it('refuses a block that is not JSON', () => {
    expect(() => parseSkillPack(pack('\n```hela\n{ op: setWind }\n```\n'))).toThrow(/is not JSON/);
  });

  it('refuses a block that is never closed', () => {
    expect(() => parseSkillPack(pack('\n```hela\n[]\n'))).toThrow(/never closed/);
  });

  it('refuses terrain data, which is the author’s own work', () => {
    // A pack may resize a world. It may not flatten a landscape somebody sculpted — that is
    // destroying something rather than adding to it, and `setTerrain` omits the fields entirely.
    expect(() =>
      parseSkillPack(
        pack(
          '\n```hela\n{ "op": "setTerrain", "value": { "heightmap": { "encoding": "base64", "data": "AA==" } } }\n```\n',
        ),
      ),
    ).toThrow();
  });
});

describe('frontmatter', () => {
  it('reads quoted and unquoted values the same', () => {
    const quoted = parseSkillPack(
      '---\nid: x\nname: "A name"\ndescription: \'A description\'\n---\n\n```hela\n{ "op": "applyLook", "look": "stylized" }\n```\n',
    );
    expect(quoted.frontmatter.name).toBe('A name');
    expect(quoted.frontmatter.description).toBe('A description');
  });

  it('reads the one list form', () => {
    const result = parseSkillPack(
      '---\nid: x\nname: X\ndescription: D\ntags: [forest, outdoor]\n---\n\n```hela\n{ "op": "applyLook", "look": "stylized" }\n```\n',
    );
    expect(result.frontmatter.tags).toEqual(['forest', 'outdoor']);
  });

  it('refuses a header line that is not key: value', () => {
    // Rather than reaching for a YAML parser, which has anchors, merge keys and a history of
    // instantiating arbitrary types. A pack header does not need any of that.
    expect(() =>
      parseSkillPack(
        '---\nid: x\nname: X\ndescription: D\n- a list item\n---\n\n```hela\n[]\n```\n',
      ),
    ).toThrow(/is not "key: value"/);
  });
});

describe('packProblems', () => {
  const parse = (patches: string): ReturnType<typeof parseSkillPack> =>
    parseSkillPack(pack(`\n\`\`\`hela\n${patches}\n\`\`\`\n`));

  it('catches an edge to a node the pack does not add', () => {
    /**
     * Why this is checked before applying rather than after.
     *
     * A dangling wire is a graph *error*, and an errored graph refuses to run — including the parts
     * of the level's graph that were already there and working. A pack must not be able to break a
     * level by being applied to it.
     */
    const result = parse(`[
      { "op": "addGraphNode", "value": { "id": "start", "type": "onStart" } },
      { "op": "addGraphEdge", "value": { "from": "start", "port": "then", "to": "ghost" } }
    ]`);
    expect(packProblems(result).join('\n')).toContain('"ghost"');
  });

  it('catches a node using a variable the pack does not declare', () => {
    const result = parse(`[
      { "op": "addGraphNode", "value": {
        "id": "set", "type": "setVariable", "name": "score", "value": { "kind": "number", "value": 1 } } }
    ]`);
    expect(packProblems(result).join('\n')).toContain('"score"');
  });

  it('says nothing about a pack that declares what it uses', () => {
    const result = parse(`[
      { "op": "addGraphVariable", "value": { "name": "score", "type": "number", "initial": 0 } },
      { "op": "addGraphNode", "value": { "id": "start", "type": "onStart" } },
      { "op": "addGraphNode", "value": {
        "id": "set", "type": "setVariable", "name": "score", "value": { "kind": "number", "value": 1 } } },
      { "op": "addGraphEdge", "value": { "from": "start", "port": "then", "to": "set" } }
    ]`);
    expect(packProblems(result)).toEqual([]);
  });
});

describe('requiredAssets', () => {
  it('gathers every asset a pack names', () => {
    // So the editor can say "this pack wants grass_large, which you do not have" before applying
    // anything — a pack is a text file and cannot ship models.
    const result = parseSkillPack(
      pack(`
\`\`\`hela
[
  { "op": "addScatterLayer", "value": { "id": "g", "assetId": "grass_large" } },
  { "op": "addAmbience", "value": { "assetId": "audio_ambience_wind" } }
]
\`\`\`
`),
    );
    expect(requiredAssets(result).sort()).toEqual(['audio_ambience_wind', 'grass_large']);
  });
});

describe('looksLikeSkillPack', () => {
  it('tells a pack from a scene file', () => {
    expect(looksLikeSkillPack(pack('\n```hela\n[]\n```\n'))).toBe(true);
    expect(looksLikeSkillPack('{ "sceneId": "x" }')).toBe(false);
    expect(looksLikeSkillPack('---\nid: x\n---\n\nJust a document.')).toBe(false);
  });
});
