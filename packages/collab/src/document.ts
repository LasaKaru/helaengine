import * as Y from 'yjs';
import { SYNCED_SECTIONS, SceneSchema, type Scene, type SceneObject } from '@helaengine/schema';

/**
 * A scene document, as a Yjs document.
 *
 * The whole design is one decision: **objects merge per object, everything else merges per
 * section.** That is not a compromise between two better options — it is the shape of the work.
 * Two people building a level are almost always touching different props, and a CRDT that resolves
 * that without either of them noticing is the entire point. Two people editing the same audio mixer
 * panel is not a workflow; making it merge field-by-field would be engineering for a situation that
 * does not arise, and it would still not help the case that actually hurts.
 *
 * The case that actually hurts is terrain. It is a base64 heightmap — one opaque string — so two
 * simultaneous sculpt strokes cannot merge, and the later one wins whole. That is stated in
 * `SYNCED_SECTIONS`, surfaced to the user as a soft lock, and left as a known limit rather than
 * papered over. Splitting the heightmap into per-tile keys would narrow the loss without removing
 * it, at the cost of a second representation of terrain that every other part of the codebase would
 * have to learn. Worth revisiting the day somebody actually loses a stroke.
 *
 * Two maps, then:
 *
 * - `objects`: `Y.Map<objectId, Y.Map<field, JSON>>`. Keyed by id rather than an array, because a
 *   `Y.Array` merges concurrent inserts by *position*, and two people adding a tree at the same
 *   moment would get two trees in an order neither of them chose — while a delete and an edit of
 *   the same object would fight over an index that has moved.
 * - `document`: `Y.Map<section, JSON>`. One entry per member of `SYNCED_SECTIONS`.
 *
 * `sceneId` and `version` live in `document` too but are never written after the room is seeded:
 * they identify the document rather than describing it.
 */

export const OBJECTS_KEY = 'objects';
export const DOCUMENT_KEY = 'document';

/** Fields of a scene object that replicate independently. */
const OBJECT_FIELDS = [
  'assetId',
  'parentId',
  'transform',
  'behaviors',
  'physics',
  'trigger',
  'metadata',
] as const;
type ObjectField = (typeof OBJECT_FIELDS)[number];

export function objectsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(OBJECTS_KEY);
}

export function documentMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(DOCUMENT_KEY);
}

/** Whether a room has been seeded. An empty doc is a room nobody has opened yet. */
export function isEmpty(doc: Y.Doc): boolean {
  return documentMap(doc).size === 0 && objectsMap(doc).size === 0;
}

/**
 * Writes a whole scene into an empty document.
 *
 * Only for seeding a new room. Calling it on a populated document would be a "my copy wins" that
 * silently discards whatever the other clients have — which is precisely the failure a CRDT is
 * there to prevent, so it is not offered as an option. Re-syncing an existing room is `applyScene`.
 */
export function seedScene(doc: Y.Doc, scene: Scene, origin?: unknown): void {
  doc.transact(() => {
    const document = documentMap(doc);
    document.set('sceneId', scene.sceneId);
    document.set('version', scene.version);
    for (const section of SYNCED_SECTIONS) {
      document.set(section, clone(scene[section]));
    }

    const objects = objectsMap(doc);
    for (const object of scene.objects) objects.set(object.id, toYObject(object));
  }, origin);
}

/**
 * Pushes *this client's own changes* into the document.
 *
 * The direction that matters for correctness, and the one that is easy to get subtly and
 * disastrously wrong. The obvious implementation — diff the local scene against the document and
 * write every difference — looks right and is a "my copy wins": anything a collaborator changed
 * since this client last looked is a difference, so pushing reverts it. Two people editing at once
 * then spend the session undoing each other, which is worse than having no CRDT at all, because it
 * happens silently and only under concurrency.
 *
 * So the baseline is `previous` — the scene as this client last knew it — and the question asked of
 * every field is **"did *I* change this?"** rather than "does this differ from the document?".
 * Fields the user did not touch are never written, which is precisely what leaves a remote edit to
 * a different field, or a different object, intact.
 *
 * `previous` is required rather than optional. An optional baseline would default to the reverting
 * behaviour, and a footgun with a safe alternative one argument away is still a footgun.
 *
 * Returns whether anything was written, so a caller can avoid an empty transaction.
 */
export function applyScene(doc: Y.Doc, next: Scene, previous: Scene, origin?: unknown): boolean {
  let changed = false;

  doc.transact(() => {
    const document = documentMap(doc);
    for (const section of SYNCED_SECTIONS) {
      // Untouched locally: leave whatever the document holds, which may be somebody else's edit.
      if (same(previous[section], next[section])) continue;
      // Touched locally but already agreeing: a write would be an update with no new information,
      // and every such write is a message to every other client.
      if (same(document.get(section), next[section])) continue;

      document.set(section, clone(next[section]));
      changed = true;
    }

    const objects = objectsMap(doc);
    const before = new Map(previous.objects.map((object) => [object.id, object]));

    for (const object of next.objects) {
      const was = before.get(object.id);
      const existing = objects.get(object.id);

      if (!was) {
        // Added locally. If it is somehow already there, the fields loop below reconciles it rather
        // than replacing the map — replacing would discard a collaborator's edit to the same id.
        if (!existing) {
          objects.set(object.id, toYObject(object));
          changed = true;
          continue;
        }
      }

      if (!existing) {
        // Present locally and in the baseline, but gone from the document: somebody deleted it
        // while this client held it. Their delete wins — resurrecting an object because a local
        // field happened to differ would make deletion impossible whenever anyone had it open.
        continue;
      }

      for (const field of OBJECT_FIELDS) {
        if (was && same(was[field], object[field])) continue;
        if (same(existing.get(field), object[field])) continue;

        existing.set(field, clone(object[field]));
        changed = true;
      }
    }

    const stillHere = new Set(next.objects.map((object) => object.id));
    for (const id of before.keys()) {
      // Deleted locally: it was in the baseline and is not in the new scene. Objects that are in
      // the document but in neither are somebody else's addition, and are left alone.
      if (stillHere.has(id) || !objects.has(id)) continue;
      objects.delete(id);
      changed = true;
    }
  }, origin);

  return changed;
}

/**
 * Reads the document back as a scene.
 *
 * Parsed through `SceneSchema` on the way out, not merely cast. The document is shared mutable
 * state that several browsers and a server have written to, so it is untrusted input in the same
 * way a file on disk is — and a scene that fails validation should fail here, at the boundary,
 * rather than three layers down inside a renderer.
 *
 * Objects come out in insertion order, which is `Y.Map`'s iteration order and is stable across
 * clients. Order does not carry meaning in this document — the scene tree nests by `parentId`, not
 * by position — so it needs no separate ordering structure.
 */
export function readScene(doc: Y.Doc): Scene {
  const document = documentMap(doc);
  const objects = [...objectsMap(doc).entries()].map(([id, fields]) => fromYObject(id, fields));

  const raw: Record<string, unknown> = {
    sceneId: document.get('sceneId'),
    version: document.get('version'),
    objects,
  };
  for (const section of SYNCED_SECTIONS) raw[section] = document.get(section);

  return SceneSchema.parse(raw);
}

function toYObject(object: SceneObject): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  // `id` is the key this map is stored under, so storing it again would be a second copy that can
  // disagree with the first — and the one nobody is looking at is the one that goes wrong.
  for (const field of OBJECT_FIELDS) map.set(field, clone(object[field]));
  return map;
}

function fromYObject(id: string, fields: Y.Map<unknown>): Record<string, unknown> {
  const object: Record<string, unknown> = { id };
  for (const field of OBJECT_FIELDS) object[field] = fields.get(field);
  return object;
}

/**
 * Plain JSON, detached from whatever it came from.
 *
 * Yjs stores values by reference, and a scene handed in here is very often an Immer draft or a
 * frozen object from the store. Storing either would mean the CRDT and the store share a mutable
 * object, and the next local edit would change the document's idea of the past.
 */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Structural equality, by serialisation.
 *
 * Slower than a hand-written deep compare and correct without maintenance, which is the right trade
 * for a function whose job is to decide whether to write. Key order is stable here because both
 * sides originate from the same schema's parse, which emits keys in declaration order.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export type { ObjectField };
