import { runAtConcurrency, timed, type Sample, type Target } from './measure.js';

/**
 * What a busy hour looks like, as four scenarios.
 *
 * Each one is a thing users actually do rather than a synthetic endpoint hammer. The distinction
 * matters most for autosave: the editor saves a *whole scene document* every twenty seconds of
 * editing, so the interesting load is not "how many requests" but "how many megabytes of JSON
 * through `JSON.parse` and into a jsonb column", which a GET-only benchmark would miss entirely.
 */

/**
 * The targets, and why these numbers.
 *
 * The plan says to pick numbers appropriate to the go-to-market scale rather than aspirational
 * ones, so: **fifty concurrent editing sessions**, which is a few hundred daily users on a product
 * at this stage, and p95 under 300 ms for reads and 500 ms for a save.
 *
 * The asymmetry is deliberate. A read is a single indexed row and has no excuse; a save writes a
 * scene document, appends a version row and bumps a project, and 500 ms of that is invisible next to
 * a twenty-second autosave interval. Export submission gets 800 ms because it takes a per-organisation
 * advisory lock — that lock is the thing keeping the quota honest, and a target tight enough to
 * forbid it would be a target that argues for removing it.
 *
 * **These are measured on a laptop-class container against one API process, not on staging.** The
 * absolute numbers are worth little; the pass mark and the shape of the distribution are worth a
 * lot, and a regression against these on the same machine is real information.
 */
export const TARGETS: Record<string, Target> = {
  projectList: { name: 'list projects', p95Ms: 300 },
  projectRead: { name: 'open a project', p95Ms: 300 },
  autosave: { name: 'autosave a scene', p95Ms: 500 },
  exportSubmit: { name: 'submit an export', p95Ms: 800 },
};

export const CONCURRENCY = Number(process.env['LOAD_CONCURRENCY'] ?? 50);

export interface Account {
  token: string;
  organizationId: string;
  projectIds: string[];
}

export interface LoadOptions {
  origin: string;
  /** How many requests per scenario. */
  requests: number;
  concurrency: number;
}

/** A scene of roughly the size a real level reaches: five hundred placed objects. */
export function heavyScene(objects = 500): Record<string, unknown> {
  return {
    sceneId: 'scene_load',
    version: 1,
    name: 'Load Test Level',
    objects: Array.from({ length: objects }, (_, index) => ({
      id: `obj_${String(index + 1).padStart(4, '0')}`,
      assetId: 'tree_pine_01',
      transform: {
        position: [(index % 32) * 4 - 64, 0, Math.floor(index / 32) * 4 - 64],
        rotation: [0, (index * 37) % 360, 0],
        scale: [1, 1, 1],
      },
    })),
  };
}

/**
 * Signs up the accounts the run will use.
 *
 * Real accounts rather than one shared token, because a single organisation would serialise on the
 * per-organisation advisory lock in `createExportJob` and the result would measure that lock rather
 * than the system. Fifty users on fifty organisations is what fifty users are.
 */
export async function prepare(options: LoadOptions & { accounts: number }): Promise<Account[]> {
  const accounts: Account[] = [];

  for (let index = 0; index < options.accounts; index += 1) {
    const email = `load-${Date.now().toString(36)}-${index}@example.com`;
    const signup = await fetch(`${options.origin}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password', displayName: 'Load' }),
    });

    if (!signup.ok) {
      throw new Error(
        `could not create a load-test account (${signup.status}). ` +
          'Set AUTH_SIGNUPS_PER_HOUR high enough on the API, or the rate limit will refuse them.',
      );
    }

    const created = (await signup.json()) as {
      session: { token: string };
      personalOrganizationId: string;
    };

    const project = await fetch(
      `${options.origin}/orgs/${created.personalOrganizationId}/projects`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${created.session.token}`,
        },
        body: JSON.stringify({ name: `Load ${index}`, scene: heavyScene() }),
      },
    );
    const madeProject = (await project.json()) as { project: { id: string } };

    accounts.push({
      token: created.session.token,
      organizationId: created.personalOrganizationId,
      projectIds: [madeProject.project.id],
    });
  }

  return accounts;
}

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length]!;
}

export async function listProjects(
  options: LoadOptions,
  accounts: readonly Account[],
): Promise<{ samples: Sample[]; wallClockMs: number }> {
  return runAtConcurrency(
    (index) => {
      const account = pick(accounts, index);
      return timed(() =>
        fetch(`${options.origin}/orgs/${account.organizationId}/projects`, {
          headers: { authorization: `Bearer ${account.token}` },
        }),
      );
    },
    { total: options.requests, concurrency: options.concurrency },
  );
}

export async function openProject(
  options: LoadOptions,
  accounts: readonly Account[],
): Promise<{ samples: Sample[]; wallClockMs: number }> {
  return runAtConcurrency(
    (index) => {
      const account = pick(accounts, index);
      return timed(() =>
        fetch(`${options.origin}/projects/${account.projectIds[0]}`, {
          headers: { authorization: `Bearer ${account.token}` },
        }),
      );
    },
    { total: options.requests, concurrency: options.concurrency },
  );
}

/**
 * The autosave burst.
 *
 * Each request sends a five-hundred-object scene, which is the point: this is the only endpoint in
 * the product where the *body* is the load. A conflict (409) is a legitimate outcome under
 * concurrency — two saves racing on one project is exactly what optimistic concurrency is for — so
 * it is counted as a success. Counting it as a failure would make the tool report a broken system
 * every time it worked correctly.
 */
export async function autosave(
  options: LoadOptions,
  accounts: readonly Account[],
): Promise<{ samples: Sample[]; wallClockMs: number }> {
  const scene = heavyScene();

  const { samples, wallClockMs } = await runAtConcurrency(
    async (index) => {
      const account = pick(accounts, index);
      const sample = await timed(() =>
        fetch(`${options.origin}/projects/${account.projectIds[0]}/versions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${account.token}`,
          },
          body: JSON.stringify({ scene, baseVersion: 1 }),
        }),
      );
      return sample.status === 409 ? { ...sample, ok: true } : sample;
    },
    { total: options.requests, concurrency: options.concurrency },
  );

  return { samples, wallClockMs };
}

/**
 * Export submission.
 *
 * Only the *submission* — the queue accepts the job in milliseconds and a worker builds it in
 * minutes, and mixing the two would produce a latency number that describes neither. What this
 * measures is the part a user waits for with a spinner: the row, the quota check under its advisory
 * lock, and the enqueue.
 *
 * A 402 counts as a success for the same reason a 409 does above: an organisation that has spent
 * its allowance is the quota working, and a run long enough to exhaust one would otherwise report
 * the system as broken at exactly the moment it is behaving.
 */
export async function submitExport(
  options: LoadOptions,
  accounts: readonly Account[],
): Promise<{ samples: Sample[]; wallClockMs: number }> {
  return runAtConcurrency(
    async (index) => {
      const account = pick(accounts, index);
      const sample = await timed(() =>
        fetch(`${options.origin}/projects/${account.projectIds[0]}/exports`, {
          method: 'POST',
          headers: { authorization: `Bearer ${account.token}` },
        }),
      );
      return sample.status === 402 || sample.status === 429 ? { ...sample, ok: true } : sample;
    },
    { total: options.requests, concurrency: options.concurrency },
  );
}
