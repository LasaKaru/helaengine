import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import {
  isReleasable,
  SharedBuildSchema,
  type PublishRequest,
  type SharedBuild,
} from '@helaengine/schema';

/**
 * Where shared builds live.
 *
 * Files on disk and a JSON index beside them, deliberately. This is not the storage layer the
 * product ends up with — Sprint 28 brings Postgres and object storage — and writing a database
 * abstraction now would be inventing an interface for requirements nobody has stated yet. What it
 * *is* is a real, complete implementation of the behaviour: publish, fetch, count, and refuse.
 */

export class RejectedBuild extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RejectedBuild';
    this.status = status;
  }
}

/**
 * How long an id is.
 *
 * Twenty-four hex characters — 96 bits. Unlisted builds are protected by nothing except this being
 * unguessable, so it is sized as a secret rather than as a slug. A short pretty id would make
 * "unlisted" mean "public to anyone who counts".
 */
const ID_BYTES = 12;

export interface ShareStoreOptions {
  root: string;
  /** Required by `org`-visibility builds. Absent means org sharing is refused rather than open. */
  orgToken?: string;
}

export class ShareStore {
  readonly #root: string;
  readonly #orgToken: string | null;

  constructor(options: ShareStoreOptions) {
    this.#root = resolve(options.root);
    this.#orgToken = options.orgToken ?? null;
    mkdirSync(this.#root, { recursive: true });
  }

  /**
   * Stores a build, if it is allowed to exist.
   *
   * The report is re-checked here rather than trusted. The editor already refused to download an
   * unreleasable build, but the editor is a browser tab and this is a service: anything that
   * enforces a rule only on the client has not enforced it. This is the same `isReleasable` the
   * editor used, which is the point of it living in the schema.
   */
  publish(request: PublishRequest): SharedBuild {
    if (!isReleasable(request.report)) {
      throw new RejectedBuild(
        'this build has not passed the pre-delivery checks, so it cannot be shared',
      );
    }
    if (request.visibility === 'org' && !this.#orgToken) {
      throw new RejectedBuild('org sharing is not configured on this server', 409);
    }

    const id = randomBytes(ID_BYTES).toString('hex');
    const folder = join(this.#root, id);
    let sizeBytes = 0;

    for (const file of request.files) {
      // Re-checked after the schema, because the schema validates the string and this validates the
      // *path it resolves to*. A name that passes both checks and still escapes is not a name.
      const target = join(folder, normalize(file.path));
      if (!target.startsWith(folder + '/') && target !== folder) {
        throw new RejectedBuild(`"${file.path}" would be written outside the build folder`);
      }

      mkdirSync(dirname(target), { recursive: true });
      const bytes =
        file.base64 === undefined
          ? Buffer.from(file.text ?? '', 'utf8')
          : Buffer.from(file.base64, 'base64');
      writeFileSync(target, bytes);
      sizeBytes += bytes.byteLength;
    }

    const build = SharedBuildSchema.parse({
      id,
      sceneName: request.sceneName,
      visibility: request.visibility,
      createdAt: new Date().toISOString(),
      sizeBytes,
      fileCount: request.files.length,
      plays: 0,
      lastPlayedAt: null,
    });

    this.#writeMeta(build);
    // The report is kept beside the build, not discarded. "Why was this allowed to be shared" is a
    // question somebody will ask about a build that turned out to be broken anyway.
    writeFileSync(join(folder, '.hela-report.json'), JSON.stringify(request.report, null, 2));
    return build;
  }

  get(id: string): SharedBuild | null {
    // Ids come off the wire and are used as path segments. Anything that is not the shape this
    // service mints is not looked up at all.
    if (!/^[0-9a-f]{24}$/.test(id)) return null;

    const meta = join(this.#root, id, '.hela-meta.json');
    if (!existsSync(meta)) return null;

    return SharedBuildSchema.parse(JSON.parse(readFileSync(meta, 'utf8')));
  }

  /** The absolute path of a file inside a build, or null if it is not there or not allowed. */
  fileFor(id: string, path: string): string | null {
    if (this.get(id) === null) return null;

    const folder = join(this.#root, id);
    const relative = normalize(path === '' || path === '/' ? 'index.html' : path).replace(
      /^\/+/,
      '',
    );
    const target = join(folder, relative);
    if (!target.startsWith(folder)) return null;

    // The metadata and the report are the service's, not the build's, so they are not served.
    // Matched on each *segment* rather than on the whole path: the first version tested
    // `target.includes('/.hela-')`, which is also true of every file in a store whose root
    // directory happens to be called `.hela-shared` — the default. It served nothing at all, and
    // no unit test noticed because they all used temp directories without the leading dot.
    if (relative.split('/').some((segment) => segment.startsWith('.hela-'))) return null;

    return existsSync(target) ? target : null;
  }

  /** Records a play. Called when the page itself is served, not when an asset is. */
  recordPlay(id: string): SharedBuild | null {
    const build = this.get(id);
    if (!build) return null;

    const next = { ...build, plays: build.plays + 1, lastPlayedAt: new Date().toISOString() };
    this.#writeMeta(next);
    return next;
  }

  /**
   * Everything anyone may browse.
   *
   * Public only. Unlisted and org builds are deliberately absent — a listing endpoint that returns
   * unlisted builds is a listing endpoint that makes "unlisted" a lie.
   */
  list(): SharedBuild[] {
    return readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.get(entry.name))
      .filter((build): build is SharedBuild => build !== null && build.visibility === 'public')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Whether a request carrying this token may see this build. */
  mayRead(build: SharedBuild, token: string | null): boolean {
    if (build.visibility !== 'org') return true;
    if (!this.#orgToken) return false;
    // Constant-time, because a token check that leaks its answer through timing is a token check
    // somebody can walk character by character.
    return timingSafeEqualString(token ?? '', this.#orgToken);
  }

  #writeMeta(build: SharedBuild): void {
    const folder = join(this.#root, build.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '.hela-meta.json'), JSON.stringify(build, null, 2));
  }
}

function timingSafeEqualString(a: string, b: string): boolean {
  // Hashed first so the comparison is over equal-length buffers whatever was sent — otherwise the
  // length check itself is the leak.
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  let same = 0;
  for (let index = 0; index < left.length; index += 1) same |= left[index]! ^ right[index]!;
  return same === 0;
}
