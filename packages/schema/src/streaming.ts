import { z } from 'zod';

/**
 * World chunks: a spatial partition of the level, and a distance beyond which it is not drawn.
 *
 * ## Why a grid and not an octree
 *
 * The task this came from asked for an octree or a BVH, and both are the wrong shape for what a
 * level actually is. A game level is a *shell on a plane*: things sit on the ground, and the world
 * is a few hundred metres wide and about twenty metres tall. An octree spends its first subdivision
 * splitting a volume that is empty above and below, and every level after that rediscovers that the
 * interesting axis is horizontal. A BVH is better for ray queries against irregular geometry and
 * worse for the query actually being asked here, which is "what is near this point" — a question a
 * uniform grid answers by arithmetic, with no tree to walk and nothing to rebalance when an object
 * moves.
 *
 * The grid is over X and Z only, for the same reason. A level tall enough for that to be wrong is a
 * level this engine has other problems with.
 *
 * ## What the distance actually bounds, and what it does not
 *
 * It bounds **drawing**. Chunks further away than this are taken out of the render, one distance
 * test per chunk rather than one frustum test per mesh, and nothing in them is submitted.
 *
 * It does **not** bound memory, and the reason is worth understanding before anybody relies on it.
 * Placed objects in this engine are clones that share one geometry and one material per asset — that
 * sharing is why two hundred trees cost one material — so unloading a placement frees almost
 * nothing. The memory ceiling of a level is set by how many *distinct assets* it uses, not by how
 * many objects it has. Lowering that ceiling means evicting assets, which cannot happen while any
 * placement still references them. Recorded here rather than implied by the word "streaming".
 *
 * ## Why it is off by default
 *
 * Because a draw distance is visible: things beyond it are not there. Every scene saved before this
 * existed draws everything it always drew, and an author who wants the trade makes it deliberately.
 */

export const StreamingSchema = z.object({
  /**
   * How far from the camera a chunk is still drawn, in metres. Zero is off.
   *
   * Zero rather than a large number, because a large number is still the whole machinery running —
   * a grid built, a distance test per chunk per camera move — to reach the same answer as not
   * having it. Off means nothing is built.
   */
  distance: z.number().min(0).max(5000).default(0),
  /**
   * How wide a chunk is, in metres.
   *
   * The trade is between the number of chunks to test and how much a single chunk over-draws: at
   * one metre the test costs more than the drawing it saves, and at five hundred the whole level is
   * one chunk and nothing is ever culled. Thirty-two is about a building.
   */
  size: z.number().min(4).max(512).default(32),
  /**
   * Whether chunks hidden behind the terrain are skipped.
   *
   * Terrain rather than arbitrary occluders, and that is the whole design. WebGL2 has occlusion
   * queries but Three does not expose them, and a software depth rasteriser is a renderer of its
   * own. What an outdoor level actually has is one enormous occluder — the ground it is standing on
   * — and a hill either blocks the line of sight to a chunk or it does not, which is a dozen height
   * samples to answer. Indoor levels built from walls get nothing from this, and are told so.
   */
  occlusion: z.boolean().default(false),
});
export type Streaming = z.infer<typeof StreamingSchema>;

/** Whether a document is asking for any of this. Off is the absence of the system. */
export function streamingIsActive(streaming: Streaming): boolean {
  return streaming.distance > 0 || streaming.occlusion;
}

/**
 * What is wrong with a streaming setting, in the author's terms.
 *
 * The fog check is the one that matters. A draw distance shorter than the fog's far plane means
 * objects vanish in clear air — the most recognisable "cheap game" artefact there is, and one an
 * author will read as a bug in the engine rather than as their own number.
 */
export function streamingProblems(
  streaming: Streaming,
  fogFar: number | null,
  terrainRelief = 1,
): string[] {
  const problems: string[] = [];
  if (!streamingIsActive(streaming)) return problems;

  // A flat level has no hills to hide behind, so the test runs, finds nothing, and costs a dozen
  // height samples per chunk to say so. Worth saying out loud, because "I switched it on and
  // nothing happened" is otherwise indistinguishable from a broken feature.
  if (streaming.occlusion && terrainRelief < 2) {
    problems.push(
      'this terrain is almost flat, so there is nothing for the occlusion test to hide anything ' +
        'behind — sculpt some hills, or leave it off',
    );
  }

  if (streaming.distance > 0 && fogFar !== null && streaming.distance < fogFar) {
    problems.push(
      `objects disappear at ${Math.round(streaming.distance)}m but the fog does not close in ` +
        `until ${Math.round(fogFar)}m, so they will vanish in clear air`,
    );
  }
  if (streaming.distance > 0 && fogFar === null) {
    problems.push(
      'there is no fog, so objects will vanish at the draw distance rather than fade out of it',
    );
  }
  if (streaming.distance > 0 && streaming.distance < streaming.size * 2) {
    problems.push(
      `a ${Math.round(streaming.distance)}m distance is barely wider than one ${Math.round(
        streaming.size,
      )}m chunk, so whole blocks of the level will appear and disappear at once`,
    );
  }

  return problems;
}
