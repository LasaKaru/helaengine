import { z } from 'zod';
import { IdSchema } from './primitives.js';
import { SavedWeaponSchema } from './save.js';
import { SceneSchema, safeParseScene, type Scene } from './scene.js';

/**
 * A game: several levels, one of which is where the player starts.
 *
 * ## Why this exists rather than a folder of scene files
 *
 * A level needs to know which levels it can send the player to, and the editor needs to be able to
 * show you that list. Both fall out of holding the levels together. Kept as separate files, "load
 * level `caves`" is a string that means nothing until it is fetched and might be wrong forever;
 * held here, it is checked the moment the document is parsed, exactly like a wire in a graph.
 *
 * ## Why a `Scene` is still the unit
 *
 * A level *is* a scene — the same terrain, objects, environment, graph and settings it has always
 * been. Nothing about the scene document changes to accommodate this, which is the whole reason a
 * project built before levels existed still opens: `asProject` wraps a bare scene in a one-level
 * project, and every consumer that only ever wanted one level reads `startLevel(project)`.
 *
 * The level's id and name are the scene's own `sceneId` and `name`, not a second pair alongside
 * them. Two names for one thing is two things to keep in step.
 */

export const CURRENT_PROJECT_VERSION = 1;

/**
 * What the player keeps when they walk through a door.
 *
 * Named in the schema rather than left as "whatever the runtime happened to be holding", because
 * it is the answer to a design question — does a key picked up in level one still open the door in
 * level two? — and a question answered by an implementation detail gets a different answer every
 * time somebody refactors.
 */
export const CarriedStateSchema = z.object({
  /** Null means "use the new level's starting health", which is what a fresh game does. */
  health: z.number().min(0).max(10_000).nullable().default(null),
  /**
   * The player's kit, in the same shape a save file uses.
   *
   * Reused rather than redefined. A weapon with its reserve ammo is one idea, and a second
   * representation of it would be a second thing to keep in step with `Inventory` — the two would
   * drift the first time a weapon gained a field, and the bug would be a level transition quietly
   * losing ammo.
   */
  weapons: z.array(SavedWeaponSchema).max(16).default([]),
  currentWeaponId: IdSchema.nullable().default(null),
  unlockedIds: z.array(IdSchema).max(32).default([]),
  /**
   * Graph variables, by name.
   *
   * Carried by name and dropped if the next level does not declare one: a level is a document that
   * can be opened on its own, so it has to declare everything it reads, and silently inheriting an
   * undeclared variable would make a level that only runs when reached from the right direction.
   */
  variables: z
    .record(IdSchema, z.union([z.number(), z.boolean(), z.string().max(500)]))
    .default({}),
});
export type CarriedState = z.infer<typeof CarriedStateSchema>;

export const EMPTY_CARRIED_STATE: CarriedState = {
  health: null,
  weapons: [],
  currentWeaponId: null,
  unlockedIds: [],
  variables: {},
};

export const GameProjectSchema = z
  .object({
    version: z.literal(CURRENT_PROJECT_VERSION),
    name: z.string().min(1).max(200).default('Untitled game'),
    /** Which level the game begins on. Must be one of `levels`. */
    startLevelId: IdSchema,
    /** Every level, in the order the editor lists them. At least one — a game with none is not one. */
    levels: z.array(SceneSchema).min(1).max(64),
  })
  .superRefine((project, ctx) => {
    const seen = new Set<string>();
    for (const [index, level] of project.levels.entries()) {
      if (seen.has(level.sceneId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['levels', index, 'sceneId'],
          message: `two levels share the id "${level.sceneId}"`,
        });
      }
      seen.add(level.sceneId);
    }

    if (!seen.has(project.startLevelId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startLevelId'],
        message: `the start level "${project.startLevelId}" is not one of the levels`,
      });
    }
  });
export type GameProject = z.infer<typeof GameProjectSchema>;

export function parseProject(input: unknown): GameProject {
  return GameProjectSchema.parse(input);
}

/**
 * Reads either shape: a project, or a lone scene saved before projects existed.
 *
 * This function is the entire backwards-compatibility story, and it is deliberately one function
 * rather than a version field on the scene. A `.hela` file, a cloud project row and an export
 * payload written last year each hold a bare scene; every one of them keeps working because every
 * reader goes through here, and a one-level project is not a compatibility shim — it is what a
 * game with one level genuinely is.
 */
export function asProject(input: unknown): GameProject {
  const project = GameProjectSchema.safeParse(input);
  if (project.success) return project.data;

  const scene = safeParseScene(input);
  if (scene.success) return projectFromScene(scene.data);

  // Reported as a project failure rather than a scene one: the caller asked for a project, and the
  // scene attempt was this function's idea. Its errors would send the reader looking for a field
  // the document was never meant to have.
  return GameProjectSchema.parse(input);
}

export function projectFromScene(scene: Scene): GameProject {
  return {
    version: CURRENT_PROJECT_VERSION,
    name: scene.name,
    startLevelId: scene.sceneId,
    levels: [scene],
  };
}

/** The level the game begins on. Never undefined: the schema guarantees it exists. */
export function startLevel(project: GameProject): Scene {
  return (
    project.levels.find((level) => level.sceneId === project.startLevelId) ?? project.levels[0]!
  );
}

export function levelById(project: GameProject, levelId: string): Scene | null {
  return project.levels.find((level) => level.sceneId === levelId) ?? null;
}

/** Replaces one level in place, keeping the order. Returns a new project. */
export function withLevel(project: GameProject, level: Scene): GameProject {
  return {
    ...project,
    levels: project.levels.map((current) => (current.sceneId === level.sceneId ? level : current)),
  };
}

/**
 * Level ids a level's graph can send the player to, and which of them do not exist.
 *
 * The check the folder-of-files design cannot make. `validateGraph` cannot do it — a scene is
 * parseable on its own and knows nothing of its siblings — so it lives here, and the editor runs it
 * whenever the level set changes.
 */
export function danglingLevelLinks(project: GameProject): Array<{ from: string; to: string }> {
  const known = new Set(project.levels.map((level) => level.sceneId));
  const dangling: Array<{ from: string; to: string }> = [];

  for (const level of project.levels) {
    for (const node of level.graph.nodes) {
      if (node.type === 'loadLevel' && node.levelId !== '' && !known.has(node.levelId)) {
        dangling.push({ from: level.sceneId, to: node.levelId });
      }
    }
  }
  return dangling;
}
