import { CURRENT_SCENE_VERSION, parseScene, type Scene } from './scene.js';

/** Migrates a document from `version` to `version + 1`. Must be pure and side-effect free. */
export type SceneMigration = (scene: Record<string, unknown>) => Record<string, unknown>;

/**
 * Keyed by the version being migrated FROM. Empty today — v1 is the first published version.
 * The registry exists from commit #1 so that the first real migration is a one-line addition
 * rather than a retrofit across an installed base of saved projects.
 */
export const sceneMigrations: Record<number, SceneMigration> = {};

export class SceneMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneMigrationError';
  }
}

function readVersion(document: unknown): number {
  if (typeof document !== 'object' || document === null) {
    throw new SceneMigrationError('scene document must be an object');
  }
  const version = (document as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SceneMigrationError('scene document is missing a valid integer `version`');
  }
  return version;
}

/**
 * Runs a document through the migration chain up to `targetVersion`, without validating it.
 * Split out from `migrateScene` so the chain logic stays unit-testable independently of whatever
 * the current schema version happens to be.
 */
export function applyMigrationChain(
  document: unknown,
  targetVersion: number = CURRENT_SCENE_VERSION,
  registry: Record<number, SceneMigration> = sceneMigrations,
): Record<string, unknown> {
  let version = readVersion(document);

  if (version > targetVersion) {
    throw new SceneMigrationError(
      `scene version ${version} is newer than this build supports (${targetVersion}); upgrade HelaEngine`,
    );
  }

  let working = document as Record<string, unknown>;
  while (version < targetVersion) {
    const migrate = registry[version];
    if (!migrate) {
      throw new SceneMigrationError(`no migration registered from scene version ${version}`);
    }
    working = migrate(working);
    const next = readVersion(working);
    if (next <= version) {
      throw new SceneMigrationError(
        `migration from version ${version} did not advance the version`,
      );
    }
    version = next;
  }

  return working;
}

/**
 * Brings any supported scene document up to `CURRENT_SCENE_VERSION`, then validates it.
 * This — not `parseScene` — is what load paths (IndexedDB, API, exported bundles) should call.
 */
export function migrateScene(document: unknown): Scene {
  return parseScene(applyMigrationChain(document));
}
