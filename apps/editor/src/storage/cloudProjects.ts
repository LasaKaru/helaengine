import { migrateScene, type Scene } from '@helaengine/schema';
import { ProjectLoadError, type ProjectSummary } from './projects';
import { rememberCorrelationId } from '../telemetry/report';

/**
 * The same project store, over the API.
 *
 * Implements the interface `projects.ts` already had — list, save, load, delete, duplicate — so
 * the editor's project screen and store do not need to know which one they are talking to. That
 * shape is what makes the migration from IndexedDB a substitution rather than a rewrite, and it is
 * why Sprint 8's local store keeps working when no API is configured.
 *
 * Two things it adds, because the cloud has them and a browser database does not:
 *
 * - **A base version on every save.** Saving is an append, and the server refuses an append based
 *   on a version somebody else has already moved past. `ConflictError` is what the editor shows as
 *   "someone else saved, reload?".
 * - **History.** Every save is a version, so listing them costs nothing extra and restoring one is
 *   another save rather than a rewrite.
 */

export class ConflictError extends Error {
  readonly latestVersion: number;

  constructor(message: string, latestVersion: number) {
    super(message);
    this.name = 'ConflictError';
    this.latestVersion = latestVersion;
  }
}

export class NotSignedIn extends Error {
  constructor() {
    super('You are not signed in.');
    this.name = 'NotSignedIn';
  }
}

export interface CloudProject extends ProjectSummary {
  organizationId: string;
  /** The version this copy is based on. Sent back with the next save. */
  version: number;
}

export interface VersionSummary {
  version: number;
  createdAt: string;
  authorId: string;
  authorName: string;
}

export interface CloudSession {
  origin: string;
  token: string;
  organizationId: string;
  /**
   * Who is signed in.
   *
   * Carried on the session rather than held beside it because collaboration needs it — a
   * collaborator's identity *is* their account, and their colour is derived from this id, so two
   * people in one organisation must not be able to look like the same person.
   */
  userId: string;
  displayName: string;
}

/** Where the API lives, when one is configured at all. */
export const API_ORIGIN: string | undefined = import.meta.env['VITE_API_ORIGIN'];

export class CloudProjects {
  readonly #session: CloudSession;

  constructor(session: CloudSession) {
    this.#session = session;
  }

  async list(): Promise<CloudProject[]> {
    const body = await this.#call<{
      projects: Array<{
        id: string;
        organizationId: string;
        name: string;
        thumbnail: string | null;
        latestVersion: number;
        createdAt: string;
        updatedAt: string;
      }>;
    }>('GET', `/orgs/${this.#session.organizationId}/projects`);

    return body.projects.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      ...(row.thumbnail ? { thumbnail: row.thumbnail } : {}),
      version: row.latestVersion,
      createdAt: Date.parse(row.createdAt),
      updatedAt: Date.parse(row.updatedAt),
    }));
  }

  async create(name: string, scene: Scene): Promise<CloudProject> {
    const body = await this.#call<{
      project: {
        id: string;
        organizationId: string;
        name: string;
        latestVersion: number;
        createdAt: string;
        updatedAt: string;
      };
    }>('POST', `/orgs/${this.#session.organizationId}/projects`, { name, scene });

    return {
      id: body.project.id,
      organizationId: body.project.organizationId,
      name: body.project.name,
      version: body.project.latestVersion,
      createdAt: Date.parse(body.project.createdAt),
      updatedAt: Date.parse(body.project.updatedAt),
    };
  }

  /**
   * Loads, migrating and validating on the way in.
   *
   * The same discipline the local store applies, and for the same reason: a document that came
   * back over a wire is untrusted input too. The server validates on the way out as well, so this
   * is the second of two checks rather than the only one — but a client that trusts a server it
   * did not write is a client that breaks the day somebody stands up their own.
   */
  async load(id: string): Promise<{ project: CloudProject; scene: Scene | null }> {
    const body = await this.#call<{
      project: {
        id: string;
        organizationId: string;
        name: string;
        thumbnail: string | null;
        latestVersion: number;
        createdAt: string;
        updatedAt: string;
      };
      scene: unknown;
      version: number;
    }>('GET', `/projects/${id}`);

    let scene: Scene | null = null;
    if (body.scene !== null) {
      try {
        scene = migrateScene(body.scene);
      } catch (error) {
        throw new ProjectLoadError(`Project "${body.project.name}" could not be read.`, {
          cause: error,
        });
      }
    }

    return {
      project: {
        id: body.project.id,
        organizationId: body.project.organizationId,
        name: body.project.name,
        ...(body.project.thumbnail ? { thumbnail: body.project.thumbnail } : {}),
        version: body.version,
        createdAt: Date.parse(body.project.createdAt),
        updatedAt: Date.parse(body.project.updatedAt),
      },
      scene,
    };
  }

  /** Appends a version. Throws `ConflictError` if somebody else saved first. */
  async save(id: string, scene: Scene, baseVersion: number): Promise<number> {
    const body = await this.#call<{ version: number }>('POST', `/projects/${id}/versions`, {
      scene,
      baseVersion,
    });
    return body.version;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.#call('PATCH', `/projects/${id}`, { name });
  }

  async setThumbnail(id: string, thumbnail: string): Promise<void> {
    await this.#call('PATCH', `/projects/${id}`, { thumbnail });
  }

  async remove(id: string): Promise<void> {
    await this.#call('DELETE', `/projects/${id}`);
  }

  async history(id: string): Promise<VersionSummary[]> {
    const body = await this.#call<{ versions: VersionSummary[] }>(
      'GET',
      `/projects/${id}/versions`,
    );
    return body.versions;
  }

  /** Restores by appending. The returned version is the *new* one holding the old content. */
  async restore(id: string, version: number): Promise<{ version: number; scene: Scene }> {
    const body = await this.#call<{ version: number; scene: unknown }>(
      'POST',
      `/projects/${id}/versions/${version}/restore`,
    );
    return { version: body.version, scene: migrateScene(body.scene) };
  }

  async #call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#session.origin}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#session.token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Kept so a crash report, or a support conversation, can name the last thing this tab asked
      // the server to do. See `telemetry/report.ts`.
      rememberCorrelationId(response);
    } catch {
      throw new Error(
        `Could not reach the API at ${this.#session.origin} — it may not be running, or it may ` +
          `not be allowing requests from this editor.`,
      );
    }

    if (response.status === 401) throw new NotSignedIn();

    // 204 has no body by definition, and parsing one would fail on a response that is correct.
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;

    if (response.status === 409) {
      // The number matters as much as the message: it is what the editor reloads to.
      const latest = /version (\d+)/.exec(String(parsed['error'] ?? ''))?.[1];
      throw new ConflictError(
        String(parsed['error'] ?? 'Somebody else saved this project.'),
        latest ? Number(latest) : 0,
      );
    }

    if (!response.ok) {
      throw new Error(
        String(parsed['error'] ?? `The API refused this request (${response.status}).`),
      );
    }
    return parsed as T;
  }
}
