import { z } from 'zod';

/**
 * The shape of a collaborative editing session.
 *
 * Here rather than in the editor or the server because both ends need to agree on it, and a
 * presence payload that means one thing to the sender and another to the receiver is a bug that
 * only appears when two people are actually in the room — which is the hardest kind to notice.
 */

/**
 * Where a collaborator is and what they are touching.
 *
 * Deliberately *not* part of `SceneSchema`. Presence is about people, not about the document: it
 * changes many times a second, nobody wants it in an undo stack, and saving it would mean a project
 * file that remembers where somebody's camera was on a Tuesday. It travels over the awareness
 * channel, which is ephemeral by design — a collaborator who closes the tab stops existing rather
 * than leaving a tombstone somebody has to clean up.
 */
export const PresenceSchema = z.object({
  userId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(200),
  /** Assigned by the client from its user id, so the same person is the same colour to everyone. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Where their edit camera is looking from, for a "jump to them" affordance and an avatar dot. */
  camera: z
    .object({
      position: z.tuple([z.number(), z.number(), z.number()]),
      target: z.tuple([z.number(), z.number(), z.number()]),
    })
    .nullable()
    .default(null),
  /** Object ids they have selected. This is what draws their highlight and their soft lock. */
  selection: z.array(z.string().max(64)).max(500).default([]),
  /**
   * Whether they are mid-gesture on their selection — dragging a gizmo, scrubbing a field.
   *
   * The difference between "Alex has this selected" and "Alex is moving this right now", which is
   * the difference between a highlight and a warning. The CRDT resolves a genuine collision either
   * way; this exists so two people do not spend ten seconds fighting over one gizmo before noticing.
   */
  editing: z.boolean().default(false),
  /** Milliseconds since epoch, for pruning a client whose tab was suspended rather than closed. */
  updatedAt: z.number().int().nonnegative(),
});
export type Presence = z.infer<typeof PresenceSchema>;

export function parsePresence(input: unknown): Presence | null {
  // Returns null rather than throwing: presence arrives from another browser, and one collaborator
  // on a stale build must not be able to crash everybody else's editor. An unreadable peer is a
  // peer you do not draw.
  const parsed = PresenceSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Colour for a collaborator, derived from their user id.
 *
 * Derived rather than assigned by the server so that everyone independently agrees on it without a
 * round trip — and so a reconnect does not make somebody change colour mid-session. Hand-picked
 * hues rather than a hash straight to HSL, because a generated palette reliably produces one
 * unreadable colour against the viewport's dark background.
 */
export const PRESENCE_COLORS = [
  '#e0658a',
  '#4aa3df',
  '#e0a458',
  '#7bc86c',
  '#b481e0',
  '#4ecdc4',
  '#e07a5f',
  '#8fa5e0',
] as const;

export function presenceColor(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length]!;
}

/**
 * The sections of a scene document that sync as a unit.
 *
 * `objects` is absent on purpose — it is the one part that gets true per-item merging, keyed by
 * object id, so that two people moving two different props never collide. Everything listed here is
 * last-write-wins *per section*, which is an honest trade rather than a hidden one:
 *
 * - **Terrain** is a base64 heightmap. Two people sculpting at once, one loses their stroke. There
 *   is no field-wise merge of a compressed image that would not be worse than that.
 * - **The rest** — the player block, the weapon catalogue, the menu, the mixer — are settings, and
 *   two people editing the same settings panel simultaneously is not the workflow this is for.
 *
 * Listed as a closed vocabulary so that adding a section to `SceneSchema` without deciding how it
 * syncs is a type error rather than a field that silently stops replicating.
 */
export const SYNCED_SECTIONS = [
  'name',
  'terrain',
  'environment',
  'player',
  'inventory',
  'unlockables',
  'audioConfig',
  'gameConfig',
  'uiConfig',
] as const;
export type SyncedSection = (typeof SYNCED_SECTIONS)[number];
