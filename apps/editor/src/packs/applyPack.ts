import {
  applyLook,
  describePatch,
  packProblems,
  requiredAssets,
  type AssetManifest,
  type Scene,
  type SkillPack,
} from '@helaengine/schema';

/**
 * Applying a skill pack to a level.
 *
 * ## One edit, or none
 *
 * The whole pack lands as a single undoable change. Half a pack is worse than no pack: the author
 * is left with three of five changes and no way to name which two are missing, and Ctrl+Z would
 * have to be pressed an unknown number of times to get back.
 *
 * ## Why ids are rewritten
 *
 * A pack cannot know what is already in the level. Its object and node ids are *local* — meaningful
 * inside the pack and nowhere else — so they are remapped on the way in. That is what makes
 * applying the same pack twice add two doors rather than one door twice, and it is what stops a
 * pack whose author happened to call something `door` from silently replacing yours.
 */

export interface PackPlan {
  /** What will change, in order, in the author's language. */
  steps: string[];
  /** Assets the pack names that this project does not have. */
  missingAssets: string[];
  /** Reasons the pack cannot be applied at all. Non-empty means the button is disabled. */
  problems: string[];
}

/**
 * What applying a pack would do, without doing it.
 *
 * Shown before the button is pressed. A recipe that changes the lighting of a level somebody spent
 * an afternoon on should say so first.
 */
export function planPack(pack: SkillPack, manifest: AssetManifest): PackPlan {
  const known = new Set(manifest.assets.map((asset) => asset.id));
  const missingAssets = requiredAssets(pack).filter((id) => !known.has(id));

  const problems = packProblems(pack);
  if (missingAssets.length > 0) {
    /**
     * A missing asset is a problem, not a warning.
     *
     * A scatter layer naming a model the project does not have grows nothing, and a spawn node
     * naming one fails the graph's own validation — which stops the *whole* graph running,
     * including the parts that were already there and working. Refusing is the only outcome that
     * cannot damage the level.
     */
    problems.push(
      `this project does not have ${missingAssets.length === 1 ? 'the asset' : 'the assets'} ` +
        missingAssets.map((id) => `"${id}"`).join(', '),
    );
  }

  return { steps: pack.patches.map(describePatch), missingAssets, problems };
}

/** A local id turned into one nothing in the scene is using. */
function remapper(prefix: string, taken: Set<string>): (local: string) => string {
  const seen = new Map<string, string>();
  return (local) => {
    const existing = seen.get(local);
    if (existing) return existing;

    let candidate = `${prefix}${local}`;
    for (let index = 2; taken.has(candidate); index += 1) candidate = `${prefix}${local}_${index}`;

    taken.add(candidate);
    seen.set(local, candidate);
    return candidate;
  };
}

/**
 * Applies a pack, returning a new scene.
 *
 * Pure: takes a scene and gives back another, so the caller decides how it enters the document —
 * which for the editor means one `replaceScene` and therefore one undo step.
 *
 * Throws if `planPack` reported problems. Checking is the caller's job and the UI does it, but a
 * second refusal here means no code path can apply a pack that would break a graph.
 */
export function applyPack(scene: Scene, pack: SkillPack, manifest: AssetManifest): Scene {
  const plan = planPack(pack, manifest);
  if (plan.problems.length > 0) {
    throw new Error(`"${pack.frontmatter.name}" cannot be applied: ${plan.problems[0]}`);
  }

  // Seeded with what the scene already holds, so a rewritten id cannot collide with an existing one.
  const objectIds = new Set(scene.objects.map((object) => object.id));
  const nodeIds = new Set(scene.graph.nodes.map((node) => node.id));
  const variableNames = new Set(scene.graph.variables.map((variable) => variable.name));

  const prefix = `${pack.frontmatter.id}_`;
  const objectId = remapper(prefix, objectIds);
  const nodeId = remapper(prefix, nodeIds);

  let next: Scene = {
    ...scene,
    objects: [...scene.objects],
    scatter: [...scene.scatter],
    graph: {
      ...scene.graph,
      variables: [...scene.graph.variables],
      nodes: [...scene.graph.nodes],
      edges: [...scene.graph.edges],
      layout: { ...scene.graph.layout },
    },
    audioConfig: {
      ...scene.audioConfig,
      ambience: [...scene.audioConfig.ambience],
      sfx: [...scene.audioConfig.sfx],
    },
  };

  /** Where the next pack-added node goes on the canvas, below whatever is already there. */
  let laneY = Object.values(scene.graph.layout).reduce((low, [, y]) => Math.max(low, y), 0) + 160;
  let laneX = 60;

  for (const patch of pack.patches) {
    switch (patch.op) {
      case 'setEnvironment':
        next = { ...next, environment: { ...next.environment, ...patch.value } };
        break;

      case 'setWind':
        next = {
          ...next,
          environment: { ...next.environment, wind: { ...next.environment.wind, ...patch.value } },
        };
        break;

      case 'applyLook':
        // Through the same function the panel's button calls, so a pack and a click cannot disagree
        // about what "realistic" means.
        next = { ...next, environment: applyLook(next.environment, patch.look) };
        break;

      case 'setTerrain':
        next = { ...next, terrain: { ...next.terrain, ...patch.value } };
        break;

      case 'addScatterLayer':
        next = {
          ...next,
          scatter: [...next.scatter, { ...patch.value, id: objectId(patch.value.id) }],
        };
        break;

      case 'addAmbience':
        // Layers are keyed by asset, so a duplicate would silently replace rather than stack.
        if (!next.audioConfig.ambience.some((one) => one.assetId === patch.value.assetId)) {
          next = {
            ...next,
            audioConfig: {
              ...next.audioConfig,
              ambience: [...next.audioConfig.ambience, patch.value],
            },
          };
        }
        break;

      case 'addSfx':
        next = {
          ...next,
          audioConfig: { ...next.audioConfig, sfx: [...next.audioConfig.sfx, patch.value] },
        };
        break;

      case 'addObject':
        next = {
          ...next,
          objects: [
            ...next.objects,
            {
              ...patch.value,
              id: objectId(patch.value.id),
              // A pack's objects are roots. Re-parenting into somebody's hierarchy is a decision a
              // recipe is not in a position to make.
              parentId: null,
            },
          ],
        };
        break;

      case 'addGraphVariable': {
        // A name the level already declares is left alone: the level's own value is the author's,
        // and a pack overwriting it would reset progress the graph was already tracking.
        if (variableNames.has(patch.value.name)) break;
        variableNames.add(patch.value.name);
        next = {
          ...next,
          graph: { ...next.graph, variables: [...next.graph.variables, patch.value] },
        };
        break;
      }

      case 'addGraphNode': {
        const id = nodeId(patch.value.id);
        next = {
          ...next,
          graph: {
            ...next.graph,
            nodes: [...next.graph.nodes, { ...patch.value, id }],
            // Laid out in a row below the existing graph, so an applied pack is visibly a group
            // rather than a pile on top of whatever was already at the origin.
            layout: { ...next.graph.layout, [id]: [laneX, laneY] },
          },
        };
        laneX += 280;
        if (laneX > 1400) {
          laneX = 60;
          laneY += 160;
        }
        break;
      }

      case 'addGraphEdge':
        next = {
          ...next,
          graph: {
            ...next.graph,
            edges: [
              ...next.graph.edges,
              { ...patch.value, from: nodeId(patch.value.from), to: nodeId(patch.value.to) },
            ],
          },
        };
        break;
    }
  }

  return next;
}
