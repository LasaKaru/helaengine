import { z } from 'zod';
import { EnvironmentSchema } from './environment.js';
import { LookSchema } from './looks.js';
import { ScatterLayerSchema } from './scatter.js';
import { SceneObjectSchema } from './object.js';
import { GraphEdgeSchema, GraphNodeSchema, GraphVariableSchema } from './graph.js';
import { AmbienceLayerSchema, SfxBindingSchema } from './audio.js';
import { TerrainSchema } from './terrain.js';
import { WindSchema } from './wind.js';
import { IdSchema } from './primitives.js';

/**
 * A skill pack: a recipe an author can apply to a level.
 *
 * "Forest atmosphere" sets a wind, adds two ground-cover layers and applies a look. "Locked door"
 * adds a variable, a trigger and the graph nodes that wire them together. Each is a handful of
 * settings somebody worked out once, written down so it does not have to be worked out again.
 *
 * ## Why a pack is data and never code
 *
 * A pack arrives from somewhere — a teammate, a download, a repository. That makes it exactly as
 * untrusted as a scene file, and the engine's central rule applies unchanged: **nothing a document
 * names is ever executed.** A pack is a list of patches from a closed vocabulary, every one of them
 * validated against the schema it targets before anything is applied.
 *
 * So a pack can set your wind, grow grass and wire a door. It cannot introduce a new node type, a
 * new behaviour, or a new anything — those are engine changes, and an engine that could be extended
 * by a file it downloaded would be an engine that runs code its author did not ship.
 *
 * ## Why markdown
 *
 * Because the prose is half the value. A pack that says *why* the wind is 0.8 and not 2 teaches
 * something; a JSON blob with the same numbers does not. Frontmatter carries the identity, fenced
 * blocks carry the patches, and everything between is documentation the editor shows before
 * applying anything.
 */

export const PACK_FORMAT_VERSION = 1;

/**
 * One change a pack may make.
 *
 * A closed union, like every other extensible thing here. Adding a patch kind is a deliberate act
 * with a schema behind it — which is what makes "what can a pack do to my level" a question with a
 * complete answer rather than a hope.
 *
 * Everything here is *settings and content*. Nothing registers a name other packs could collide
 * over, and nothing reaches outside the scene document.
 */
export const PackPatchSchema = z.discriminatedUnion('op', [
  /** Whole-environment settings: background, fog, lighting, tone mapping, effects. */
  z.object({ op: z.literal('setEnvironment'), value: EnvironmentSchema.partial().strict() }),
  z.object({ op: z.literal('setWind'), value: WindSchema.partial().strict() }),
  /** One of the named look presets, applied exactly as the button does. */
  z.object({ op: z.literal('applyLook'), look: LookSchema }),
  /**
   * Terrain *settings*, never terrain data.
   *
   * A pack may say "this world is 512 metres" or change the layer palette. It may not ship a
   * heightmap: sculpting is the author's work, and a recipe that flattened it would be destroying
   * something rather than adding to it.
   *
   * `.strict()` rather than the default, here and on the two above. Zod's default is to *strip* an
   * unknown key, which would keep the heightmap out but tell the pack's author nothing — they would
   * ship a recipe that silently does less than it says. Refusing names the field.
   */
  z.object({
    op: z.literal('setTerrain'),
    value: TerrainSchema.omit({ heightmap: true, splatmap: true }).partial().strict(),
  }),

  z.object({ op: z.literal('addScatterLayer'), value: ScatterLayerSchema }),
  z.object({ op: z.literal('addAmbience'), value: AmbienceLayerSchema }),
  z.object({ op: z.literal('addSfx'), value: SfxBindingSchema }),

  /**
   * Objects, with ids the applier rewrites.
   *
   * A pack cannot know what is already in the level, so its ids are *local* — meaningful only
   * within the pack, and remapped on the way in. Two applications of the same pack therefore add
   * two doors rather than one door twice.
   */
  z.object({ op: z.literal('addObject'), value: SceneObjectSchema }),

  z.object({ op: z.literal('addGraphVariable'), value: GraphVariableSchema }),
  z.object({ op: z.literal('addGraphNode'), value: GraphNodeSchema }),
  z.object({ op: z.literal('addGraphEdge'), value: GraphEdgeSchema }),
]);
export type PackPatch = z.infer<typeof PackPatchSchema>;
export type PackPatchOp = PackPatch['op'];

/** Human-readable summary of one patch, for the preview the editor shows before applying. */
export function describePatch(patch: PackPatch): string {
  switch (patch.op) {
    case 'setEnvironment':
      return `Change ${Object.keys(patch.value).length} environment setting(s)`;
    case 'setWind':
      return patch.value.strength === 0 ? 'Switch the wind off' : 'Set the wind';
    case 'applyLook':
      return `Apply the ${patch.look} look`;
    case 'setTerrain':
      return `Change ${Object.keys(patch.value).length} terrain setting(s)`;
    case 'addScatterLayer':
      return `Add ground cover: ${patch.value.name}`;
    case 'addAmbience':
      return `Add ambience: ${patch.value.assetId}`;
    case 'addSfx':
      return `Bind a sound to "${patch.value.event}"`;
    case 'addObject':
      return `Place ${patch.value.assetId}`;
    case 'addGraphVariable':
      return `Add graph variable "${patch.value.name}"`;
    case 'addGraphNode':
      return `Add graph node "${patch.value.id}"`;
    case 'addGraphEdge':
      return `Wire ${patch.value.from} → ${patch.value.to}`;
  }
}

export const PackFrontmatterSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
  version: z.string().max(32).default('1.0.0'),
  /** Free-form labels for filtering. Not a vocabulary — nothing depends on their contents. */
  tags: z.array(z.string().max(32)).max(12).default([]),
  author: z.string().max(120).optional(),
});
export type PackFrontmatter = z.infer<typeof PackFrontmatterSchema>;

export const SkillPackSchema = z.object({
  format: z.literal(PACK_FORMAT_VERSION),
  frontmatter: PackFrontmatterSchema,
  /** The markdown between the frontmatter and the patches. Shown before anything is applied. */
  body: z.string().max(20_000).default(''),
  patches: z.array(PackPatchSchema).min(1).max(200),
});
export type SkillPack = z.infer<typeof SkillPackSchema>;

/**
 * Asset ids a pack needs the project to have.
 *
 * Gathered so the editor can say "this pack wants `grass_large`, which you do not have" *before*
 * applying anything, rather than leaving a scatter layer that grows nothing and a spawn node that
 * fails validation. A pack cannot ship models — it is a text file — so this is the honest limit of
 * what one can promise.
 */
export function requiredAssets(pack: SkillPack): string[] {
  const wanted = new Set<string>();
  for (const patch of pack.patches) {
    if (patch.op === 'addScatterLayer') wanted.add(patch.value.assetId);
    if (patch.op === 'addAmbience') wanted.add(patch.value.assetId);
    if (patch.op === 'addSfx') wanted.add(patch.value.assetId);
    if (patch.op === 'addObject') wanted.add(patch.value.assetId);
    if (patch.op === 'addGraphNode' && patch.value.type === 'spawn')
      wanted.add(patch.value.assetId);
  }
  return [...wanted].filter((id) => id !== '');
}

/**
 * Problems that would make a pack do something other than what it says.
 *
 * Checked before applying rather than after, because a half-applied pack is worse than a refused
 * one: the author is left with three of five changes and no way to name which two are missing.
 */
export function packProblems(pack: SkillPack): string[] {
  const problems: string[] = [];

  const nodeIds = new Set(
    pack.patches.filter((patch) => patch.op === 'addGraphNode').map((patch) => patch.value.id),
  );
  const variables = new Set(
    pack.patches
      .filter((patch) => patch.op === 'addGraphVariable')
      .map((patch) => patch.value.name),
  );

  for (const patch of pack.patches) {
    if (patch.op !== 'addGraphEdge') continue;
    // An edge to a node the pack does not carry would land in the level as a dangling wire and
    // stop the whole graph running — including the parts that were already there and working.
    if (!nodeIds.has(patch.value.from)) {
      problems.push(`an edge starts at "${patch.value.from}", which this pack does not add`);
    }
    if (!nodeIds.has(patch.value.to)) {
      problems.push(`an edge ends at "${patch.value.to}", which this pack does not add`);
    }
  }

  for (const patch of pack.patches) {
    if (patch.op !== 'addGraphNode') continue;
    const node = patch.value;
    const name =
      node.type === 'setVariable' || node.type === 'addToVariable'
        ? node.name
        : node.type === 'branch' && node.condition.type === 'flag'
          ? node.condition.name
          : null;
    if (name !== null && name !== '' && !variables.has(name)) {
      // Same reasoning: an undeclared variable is a graph error, and a pack must not be able to
      // break a level's existing graph by being applied to it.
      problems.push(`node "${node.id}" uses variable "${name}", which this pack does not declare`);
    }
  }

  return problems;
}
