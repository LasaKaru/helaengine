import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { percentile, type Target } from './measure.js';
import { heavyScene, type LoadOptions } from './scenarios.js';

/**
 * The collaboration server under a room full of people.
 *
 * This is a different measurement from the API's, and the sprint plan says so in as many words: the
 * API is stateless and its cost is per *request*, while this process holds a live socket and a
 * whole `Y.Doc` per open project for as long as somebody is editing. Requests per second is the
 * wrong unit here. What can actually go wrong is a room that takes longer and longer to let people
 * in, an edit that takes a visible moment to appear on somebody else's screen, or memory that grows
 * with connections and never comes back down.
 *
 * So there are three numbers, and they are the three ways a collaborative editor feels broken:
 * how long joining takes, how long an edit takes to arrive, and what a connection costs.
 */

/**
 * Targets, and the reasoning behind each.
 *
 * **Join** gets a second. Joining downloads the whole document — a real level is hundreds of
 * kilobytes of Yjs update — and it happens once, behind a spinner the user expects to see.
 *
 * **Propagation** gets 250 ms, and it is the tight one on purpose. This is the number a user
 * experiences as "is this thing live?": somebody drags a rock and the other editor watches it move.
 * Past roughly a quarter-second the illusion of a shared space is gone and it starts to feel like a
 * file being passed back and forth. It is also generous compared to the ~100 ms usually quoted for
 * direct manipulation, because this is a round trip through another process, not a local frame.
 *
 * **Memory per connection** gets 2 MB. Not a latency, and the only one of the three that predicts
 * where the ceiling is: at 2 MB a 512 MB container holds a couple of hundred editors, which is the
 * scale this product is being built for. It is a budget rather than a measurement of doom — the
 * point is to notice the day a per-socket buffer doubles it.
 */
export const COLLAB_TARGETS: Record<string, Target> = {
  join: { name: 'join a room', p95Ms: 1000 },
  propagate: { name: 'an edit reaching a peer', p95Ms: 250 },
};

/** Bytes of resident growth per live connection that we are willing to accept. */
export const MEMORY_PER_CONNECTION_BUDGET = 2 * 1024 * 1024;

export interface CollabOptions extends LoadOptions {
  /** Where the collab server listens, e.g. `ws://127.0.0.1:3200`. */
  collabOrigin: string;
  /** How many editors to put in the room at once. */
  connections: number;
  /** How many edits to time propagating between two of them. */
  edits: number;
}

export interface CollabReport {
  connections: number;
  /** How many of the attempted connections actually reached a synced state. */
  joined: number;
  join: { p50: number; p95: number; max: number };
  propagate: { p50: number; p95: number; max: number };
  /** Resident set growth on the *server* while the room was full, in bytes per connection. */
  memoryPerConnection: number | null;
  roomsOpen: number | null;
  /** Why joining stopped short, when it did. Null when every attempted connection synced. */
  stoppedBecause: string | null;
}

interface Editor {
  doc: Y.Doc;
  provider: WebsocketProvider;
}

/**
 * Opens one editor's connection and resolves when it has the document.
 *
 * `sync` rather than `status: connected`, and the gap between the two is the entire measurement:
 * the socket is open long before the document has arrived, and a user staring at an empty viewport
 * does not care that the TCP handshake went well.
 */
function joinRoom(
  collabOrigin: string,
  projectId: string,
  token: string,
  timeoutMs: number,
): Promise<{ editor: Editor; ms: number }> {
  const doc = new Y.Doc();
  const started = performance.now();

  const provider = new WebsocketProvider(collabOrigin, projectId, doc, {
    params: { token, project: projectId },
    // Node has a global WebSocket now, but y-websocket reaches for it at construction time and the
    // `ws` implementation is what the editor's browser build ends up talking to anyway.
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.destroy();
      doc.destroy();
      reject(new Error(`join timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    provider.on('sync', (synced: boolean) => {
      if (!synced) return;
      clearTimeout(timer);
      resolve({ editor: { doc, provider }, ms: performance.now() - started });
    });
  });
}

/**
 * Times an edit made by one editor arriving at another.
 *
 * Deliberately measured between two *specific* peers rather than as a broadcast fan-out average.
 * A mean over fifty listeners hides the case that matters — one editor consistently last — and the
 * user who is consistently last is the one who files the bug.
 */
async function timeEdit(from: Editor, to: Editor, key: string, timeoutMs: number): Promise<number> {
  const arrived = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edit never arrived')), timeoutMs);
    const observe = (): void => {
      if (to.doc.getMap('objects').get(key) === undefined) return;
      clearTimeout(timer);
      to.doc.getMap('objects').unobserve(observe);
      resolve(performance.now());
    };
    to.doc.getMap('objects').observe(observe);
  });

  const started = performance.now();
  from.doc.getMap('objects').set(key, { id: key, assetId: 'tree_pine_01' });
  return (await arrived) - started;
}

/** The server's own view of itself: how many rooms it holds, and how much memory it is using. */
async function serverHealth(
  origin: string,
): Promise<{ rooms: number; rss: number | null } | null> {
  const url = origin.replace(/^ws/, 'http');
  const response = await fetch(`${url}/health`).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json()) as { rooms?: number; rss?: number };
  return { rooms: body.rooms ?? 0, rss: typeof body.rss === 'number' ? body.rss : null };
}

/**
 * Puts `connections` editors into one room, times what they experience, and takes them out again.
 *
 * One room rather than one room each, because a room is where the work is: every edit fans out to
 * every other socket in it, so N editors in one project is N² message deliveries and N editors in N
 * projects is N. The first is the shape that falls over, and it is also what a studio actually does.
 */
export async function runCollabLoad(
  options: CollabOptions,
  account: { token: string; projectId: string },
): Promise<CollabReport> {
  const before = await serverHealth(options.collabOrigin);

  const joinTimes: number[] = [];
  const editors: Editor[] = [];
  let stoppedBecause: string | null = null;

  for (let index = 0; index < options.connections; index += 1) {
    try {
      const { editor, ms } = await joinRoom(
        options.collabOrigin,
        account.projectId,
        account.token,
        15_000,
      );
      editors.push(editor);
      joinTimes.push(ms);
    } catch (error) {
      // A refused or timed-out join is the finding, not an error to abort on: the report says how
      // many of the attempted connections made it, and a shortfall there is the headline. The
      // reason is carried out too — "0 of 10 synced" is a symptom, and a symptom without a cause
      // sends the next person reading the report back to reproducing it by hand.
      stoppedBecause = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const propagation: number[] = [];
  if (editors.length >= 2) {
    const first = editors[0]!;
    const last = editors[editors.length - 1]!;
    for (let index = 0; index < options.edits; index += 1) {
      try {
        propagation.push(await timeEdit(first, last, `load_${index}`, 10_000));
      } catch {
        propagation.push(Number.POSITIVE_INFINITY);
      }
    }
  }

  const during = await serverHealth(options.collabOrigin);

  for (const editor of editors) {
    editor.provider.destroy();
    editor.doc.destroy();
  }

  const sortedJoins = [...joinTimes].sort((a, b) => a - b);
  const sortedEdits = [...propagation].sort((a, b) => a - b);

  const grew = before?.rss != null && during?.rss != null ? during.rss - before.rss : null;

  return {
    connections: options.connections,
    joined: editors.length,
    join: {
      p50: percentile(sortedJoins, 0.5),
      p95: percentile(sortedJoins, 0.95),
      max: sortedJoins[sortedJoins.length - 1] ?? 0,
    },
    propagate: {
      p50: percentile(sortedEdits, 0.5),
      p95: percentile(sortedEdits, 0.95),
      max: sortedEdits[sortedEdits.length - 1] ?? 0,
    },
    memoryPerConnection: grew === null || editors.length === 0 ? null : grew / editors.length,
    roomsOpen: during?.rooms ?? null,
    stoppedBecause,
  };
}

/**
 * Creates the one account and one project the room will be shared through.
 *
 * All the editors sign in as the same user, which is not what a studio looks like but is what the
 * server sees: authorisation is per socket and the room is keyed by project, so fifty sockets on
 * one token exercise exactly the fan-out path fifty colleagues would. Signing up fifty users and
 * granting each a membership would measure the API's invitation flow instead.
 */
export async function prepareRoom(
  options: LoadOptions,
): Promise<{ token: string; projectId: string }> {
  const email = `collab-${Date.now().toString(36)}@example.com`;
  const signup = await fetch(`${options.origin}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-long-enough-password', displayName: 'Collab' }),
  });
  if (!signup.ok) {
    throw new Error(
      `could not create the collab load account (${signup.status}). ` +
        'Set AUTH_SIGNUPS_PER_HOUR high enough on the API.',
    );
  }

  const created = (await signup.json()) as {
    session: { token: string };
    personalOrganizationId: string;
  };

  const project = await fetch(`${options.origin}/orgs/${created.personalOrganizationId}/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${created.session.token}`,
    },
    body: JSON.stringify({ name: 'Collab Load', scene: heavyScene() }),
  });
  const madeProject = (await project.json()) as { project: { id: string } };

  return { token: created.session.token, projectId: madeProject.project.id };
}

export function formatCollabReport(report: CollabReport): string {
  const budget = MEMORY_PER_CONNECTION_BUDGET;
  const memory =
    report.memoryPerConnection === null
      ? '        n/a'
      : `${(report.memoryPerConnection / 1024).toFixed(0).padStart(7)} KiB`;

  const lines = [
    `  connections attempted   ${String(report.connections).padStart(6)}`,
    `  connections synced      ${String(report.joined).padStart(6)}`,
    `  join            p50 ${report.join.p50.toFixed(0).padStart(5)}ms  ` +
      `p95 ${report.join.p95.toFixed(0).padStart(5)}ms  max ${report.join.max.toFixed(0)}ms`,
    `  edit to a peer  p50 ${report.propagate.p50.toFixed(0).padStart(5)}ms  ` +
      `p95 ${report.propagate.p95.toFixed(0).padStart(5)}ms  max ${report.propagate.max.toFixed(0)}ms`,
    `  memory / connection ${memory}   (budget ${(budget / 1024 / 1024).toFixed(0)} MiB)`,
    `  rooms open on the server ${report.roomsOpen ?? 'n/a'}`,
  ];

  return lines.join('\n');
}

/** The pass/fail verdict, as reasons rather than a boolean nobody can act on. */
export function judgeCollab(report: CollabReport): string[] {
  const reasons: string[] = [];

  if (report.joined < report.connections) {
    reasons.push(
      `only ${report.joined} of ${report.connections} connections synced` +
        (report.stoppedBecause === null ? '' : ` (${report.stoppedBecause})`),
    );
  }
  if (report.join.p95 > COLLAB_TARGETS['join']!.p95Ms) {
    reasons.push(
      `join p95 ${report.join.p95.toFixed(0)}ms is over the ${COLLAB_TARGETS['join']!.p95Ms}ms target`,
    );
  }
  if (report.propagate.p95 > COLLAB_TARGETS['propagate']!.p95Ms) {
    reasons.push(
      `propagation p95 ${report.propagate.p95.toFixed(0)}ms is over the ` +
        `${COLLAB_TARGETS['propagate']!.p95Ms}ms target`,
    );
  }
  if (
    report.memoryPerConnection !== null &&
    report.memoryPerConnection > MEMORY_PER_CONNECTION_BUDGET
  ) {
    reasons.push(
      `${(report.memoryPerConnection / 1024 / 1024).toFixed(1)} MiB per connection is over the ` +
        `${(MEMORY_PER_CONNECTION_BUDGET / 1024 / 1024).toFixed(0)} MiB budget`,
    );
  }

  return reasons;
}
