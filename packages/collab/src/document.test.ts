import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { JointSchema, SceneSchema, CURRENT_SCENE_VERSION, type Scene } from '@helaengine/schema';
import { applyScene, isEmpty, objectsMap, readScene, seedScene } from './document.js';

/**
 * Sprint 31 — the scene, as a CRDT.
 *
 * These tests are the specification of the merge behaviour, and they are written the way the
 * failure would be experienced: two documents, edited without knowledge of each other, then synced.
 * A test that only round-trips one document proves the serialisation and nothing about the thing
 * the sprint is actually for.
 */

function scene(overrides: Partial<Scene> = {}): Scene {
  return SceneSchema.parse({
    sceneId: 'scene_collab',
    version: CURRENT_SCENE_VERSION,
    name: 'Shared Level',
    objects: [
      { id: 'obj_0001', assetId: 'tree_pine_01', transform: { position: [0, 0, 0] } },
      { id: 'obj_0002', assetId: 'rock_boulder_01', transform: { position: [5, 0, 5] } },
    ],
    ...overrides,
  });
}

/** Two clients that have seen the same starting document and can be synced on demand. */
function pair(start: Scene): { a: Y.Doc; b: Y.Doc; sync: () => void } {
  const a = new Y.Doc();
  seedScene(a, start);

  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

  const sync = (): void => {
    // Both directions, twice — which is what a real connection does and what makes convergence a
    // claim rather than a coincidence. A one-way apply would let a test pass while one client is
    // permanently behind.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };

  return { a, b, sync };
}

function objectById(doc: Y.Doc, id: string): Record<string, unknown> | undefined {
  return readScene(doc).objects.find((object) => object.id === id) as
    Record<string, unknown> | undefined;
}

describe('seeding and reading back', () => {
  it('round-trips a scene through a Yjs document', () => {
    const doc = new Y.Doc();
    const original = scene();
    seedScene(doc, original);

    expect(readScene(doc)).toEqual(original);
  });

  it('knows an unseeded room from a seeded one', () => {
    const doc = new Y.Doc();
    expect(isEmpty(doc)).toBe(true);

    seedScene(doc, scene());
    expect(isEmpty(doc)).toBe(false);
  });

  it('validates on the way out, because the document is shared mutable state', () => {
    const doc = new Y.Doc();
    seedScene(doc, scene());

    // A client on a future build writes something this one has never heard of. Better to fail at
    // the boundary than three layers down inside a renderer.
    objectsMap(doc).get('obj_0001')!.set('transform', { position: 'over there' });
    expect(() => readScene(doc)).toThrow();
  });

  it('does not store an object id twice', () => {
    const doc = new Y.Doc();
    seedScene(doc, scene());

    // The map key is the id. A second copy inside the value could disagree with it, and the one
    // nobody reads is the one that goes wrong.
    expect(objectsMap(doc).get('obj_0001')!.has('id')).toBe(false);
    expect(readScene(doc).objects[0]!.id).toBe('obj_0001');
  });

  it('detaches from the scene it was given', () => {
    const doc = new Y.Doc();
    const original = scene();
    seedScene(doc, original);

    // Yjs stores by reference. If the caller's object went in unmodified, mutating it afterwards
    // would rewrite the document's idea of the past.
    original.objects[0]!.transform.position[0] = 999;
    expect(objectById(doc, 'obj_0001')!['transform']).toMatchObject({ position: [0, 0, 0] });
  });
});

describe('applying a local scene', () => {
  it('writes only what changed', () => {
    const doc = new Y.Doc();
    const start = scene();
    seedScene(doc, start);

    expect(applyScene(doc, start, start)).toBe(false);

    const moved = structuredClone(start);
    moved.objects[0]!.transform.position = [1, 2, 3];
    expect(applyScene(doc, moved, start)).toBe(true);
    expect(applyScene(doc, moved, moved)).toBe(false);
  });

  it('adds, edits and deletes objects', () => {
    const doc = new Y.Doc();
    seedScene(doc, scene());

    const next = structuredClone(scene());
    next.objects = [
      { ...next.objects[0]!, transform: { ...next.objects[0]!.transform, position: [9, 0, 9] } },
      SceneSchema.parse({
        sceneId: 'x',
        version: CURRENT_SCENE_VERSION,
        objects: [{ id: 'obj_0003', assetId: 'prop_crate_01' }],
      }).objects[0]!,
    ];

    applyScene(doc, next, scene());
    const read = readScene(doc);

    expect(read.objects.map((object) => object.id)).toEqual(['obj_0001', 'obj_0003']);
    expect(read.objects[0]!.transform.position).toEqual([9, 0, 9]);
  });

  it('updates a document section without touching the others', () => {
    const doc = new Y.Doc();
    seedScene(doc, scene());

    const renamed = { ...scene(), name: 'Renamed Level' };
    applyScene(doc, renamed, scene());

    expect(readScene(doc).name).toBe('Renamed Level');
    expect(readScene(doc).objects).toHaveLength(2);
  });
});

describe('merging concurrent edits', () => {
  it('merges two people moving two different objects — the case this exists for', () => {
    const { a, b, sync } = pair(scene());

    const mine = structuredClone(scene());
    mine.objects[0]!.transform.position = [10, 0, 0];
    applyScene(a, mine, scene());

    const theirs = structuredClone(scene());
    theirs.objects[1]!.transform.position = [0, 0, 10];
    applyScene(b, theirs, scene());

    sync();

    // Neither edit is lost, and both clients agree. This is the whole promise.
    for (const doc of [a, b]) {
      expect(objectById(doc, 'obj_0001')!['transform']).toMatchObject({ position: [10, 0, 0] });
      expect(objectById(doc, 'obj_0002')!['transform']).toMatchObject({ position: [0, 0, 10] });
    }
  });

  it('merges two edits to different fields of the *same* object', () => {
    const { a, b, sync } = pair(scene());

    const mine = structuredClone(scene());
    mine.objects[0]!.transform.position = [4, 0, 4];
    applyScene(a, mine, scene());

    const theirs = structuredClone(scene());
    theirs.objects[0]!.metadata = { label: 'The good tree' };
    applyScene(b, theirs, scene());

    sync();

    // One person moves it while the other renames it: both survive, because the fields replicate
    // independently rather than the object replicating as one blob.
    for (const doc of [a, b]) {
      const object = objectById(doc, 'obj_0001')!;
      expect(object['transform']).toMatchObject({ position: [4, 0, 4] });
      expect(object['metadata']).toMatchObject({ label: 'The good tree' });
    }
  });

  it('converges when two people move the same object, rather than diverging', () => {
    const { a, b, sync } = pair(scene());

    const mine = structuredClone(scene());
    mine.objects[0]!.transform.position = [1, 0, 0];
    applyScene(a, mine, scene());

    const theirs = structuredClone(scene());
    theirs.objects[0]!.transform.position = [2, 0, 0];
    applyScene(b, theirs, scene());

    sync();

    // One of the two wins — which one is Yjs's business, and deliberately not asserted here. What
    // *is* asserted is that both clients pick the same winner, because two editors quietly showing
    // different worlds is far worse than one person losing a drag they can simply repeat.
    const fromA = objectById(a, 'obj_0001')!['transform'];
    expect(fromA).toEqual(objectById(b, 'obj_0001')!['transform']);
    expect(fromA).toMatchObject({ position: expect.arrayContaining([expect.any(Number)]) });
  });

  it('survives two people deleting the same object at the same moment', () => {
    const { a, b, sync } = pair(scene());

    const withoutIt = structuredClone(scene());
    withoutIt.objects = withoutIt.objects.filter((object) => object.id !== 'obj_0002');

    applyScene(a, withoutIt, scene());
    applyScene(b, withoutIt, scene());
    sync();

    // The stress test the sprint plan names. A second delete of an already-deleted key is a no-op
    // in a Y.Map rather than an error, so this is a claim about the *design* being collision-proof
    // rather than about a guard somewhere catching it.
    for (const doc of [a, b]) {
      expect(readScene(doc).objects.map((object) => object.id)).toEqual(['obj_0001']);
    }
  });

  it('resolves a delete racing an edit, without leaving a half-object behind', () => {
    const { a, b, sync } = pair(scene());

    const deleted = structuredClone(scene());
    deleted.objects = deleted.objects.filter((object) => object.id !== 'obj_0002');
    applyScene(a, deleted, scene());

    const moved = structuredClone(scene());
    moved.objects[1]!.transform.position = [7, 0, 7];
    applyScene(b, moved, scene());

    sync();

    // The nastiest of the three, because the two operations are not even the same *kind*. What
    // must not happen is an object that exists with some fields missing — which is what an
    // array-of-objects representation produces when a delete and a field write interleave.
    const fromA = readScene(a);
    const fromB = readScene(b);
    expect(fromA.objects.map((object) => object.id)).toEqual(
      fromB.objects.map((object) => object.id),
    );
    expect(() => readScene(a)).not.toThrow();
  });

  it('does not revert a remote edit that landed since this client last looked', () => {
    // The bug this signature exists to prevent, as a test.
    //
    // A diffs its local scene against the *document* rather than against what it last knew, pushes
    // "every difference", and silently reverts B's edit — which arrived while A was busy. It looks
    // completely correct on A's screen. It only shows up under concurrency, which is the only
    // condition this feature is ever used in.
    const { a, b, sync } = pair(scene());
    const baseline = scene();

    // B moves the rock, and A receives it.
    const theirs = structuredClone(baseline);
    theirs.objects[1]!.transform.position = [8, 0, 8];
    applyScene(b, theirs, baseline);
    sync();
    expect(objectById(a, 'obj_0002')!['transform']).toMatchObject({ position: [8, 0, 8] });

    // A now edits something else entirely, pushing from the baseline it started with — which still
    // holds the rock at its original position.
    const mine = structuredClone(baseline);
    mine.objects[0]!.transform.position = [1, 1, 1];
    applyScene(a, mine, baseline);
    sync();

    // A's tree edit lands, and B's rock edit survives. Diffing against the document would have
    // written the rock back to [5, 0, 5] and called it a change.
    for (const doc of [a, b]) {
      expect(objectById(doc, 'obj_0001')!['transform']).toMatchObject({ position: [1, 1, 1] });
      expect(objectById(doc, 'obj_0002')!['transform']).toMatchObject({ position: [8, 0, 8] });
    }
  });

  it('does not resurrect an object somebody else deleted while this client held it', () => {
    const { a, b, sync } = pair(scene());
    const baseline = scene();

    const deleted = structuredClone(baseline);
    deleted.objects = deleted.objects.filter((object) => object.id !== 'obj_0002');
    applyScene(b, deleted, baseline);
    sync();

    // A pushes a scene that still contains the rock, because it changed something unrelated. The
    // rock must stay deleted — otherwise nobody can ever delete anything that somebody else has
    // open, which is every object in a shared session.
    const mine = structuredClone(baseline);
    mine.name = 'Renamed';
    applyScene(a, mine, baseline);
    sync();

    for (const doc of [a, b]) {
      expect(readScene(doc).objects.map((object) => object.id)).toEqual(['obj_0001']);
      expect(readScene(doc).name).toBe('Renamed');
    }
  });

  it('merges an add from each side, keeping both', () => {
    const { a, b, sync } = pair(scene());

    const mine = structuredClone(scene());
    mine.objects.push(
      SceneSchema.parse({
        sceneId: 'x',
        version: CURRENT_SCENE_VERSION,
        objects: [{ id: 'obj_mine', assetId: 'prop_crate_01' }],
      }).objects[0]!,
    );
    applyScene(a, mine, scene());

    const theirs = structuredClone(scene());
    theirs.objects.push(
      SceneSchema.parse({
        sceneId: 'x',
        version: CURRENT_SCENE_VERSION,
        objects: [{ id: 'obj_theirs', assetId: 'prop_barrel_01' }],
      }).objects[0]!,
    );
    applyScene(b, theirs, scene());

    sync();

    // Keyed by id, so two simultaneous adds are two entries rather than a fight over one index.
    for (const doc of [a, b]) {
      const ids = readScene(doc).objects.map((object) => object.id);
      expect(ids).toContain('obj_mine');
      expect(ids).toContain('obj_theirs');
      expect(ids).toHaveLength(4);
    }
  });

  it('lets a section be last-write-wins without dragging objects down with it', () => {
    const { a, b, sync } = pair(scene());

    // The honest limitation, asserted rather than described: two sculpts, one survives. What must
    // *not* happen is the losing client also losing the object edit it made in the same breath.
    const mine = structuredClone(scene());
    mine.terrain = { ...mine.terrain, heightmap: { encoding: 'base64', data: 'AAAA' } };
    mine.objects[0]!.transform.position = [3, 0, 3];
    applyScene(a, mine, scene());

    const theirs = structuredClone(scene());
    theirs.terrain = { ...theirs.terrain, heightmap: { encoding: 'base64', data: 'BBBB' } };
    applyScene(b, theirs, scene());

    sync();

    expect(readScene(a).terrain.heightmap).toEqual(readScene(b).terrain.heightmap);
    expect(['AAAA', 'BBBB']).toContain(readScene(a).terrain.heightmap!.data);
    expect(objectById(a, 'obj_0001')!['transform']).toMatchObject({ position: [3, 0, 3] });
  });
});

describe('reconnecting', () => {
  it('resyncs from server state rather than from the last local state', () => {
    const { a, b, sync } = pair(scene());

    // B goes offline and keeps editing.
    const offline = structuredClone(scene());
    offline.objects[1]!.metadata = { label: 'Edited while offline' };
    applyScene(b, offline, scene());

    // A carries on without them.
    const online = structuredClone(scene());
    online.objects[0]!.metadata = { label: 'Edited while they were away' };
    applyScene(a, online, scene());

    // B comes back. A state vector exchange sends only what each is missing — which is why this is
    // a reconnect rather than a reload, and why an offline edit is not silently thrown away.
    sync();

    for (const doc of [a, b]) {
      expect(objectById(doc, 'obj_0001')!['metadata']).toMatchObject({
        label: 'Edited while they were away',
      });
      expect(objectById(doc, 'obj_0002')!['metadata']).toMatchObject({
        label: 'Edited while offline',
      });
    }
  });
});

describe('every part of a scene, not only the parts somebody remembered', () => {
  /**
   * The regression this exists for.
   *
   * `graph` and `scatter` were added to `SceneSchema` and never added to `SYNCED_SECTIONS`, and
   * because `readScene` rebuilds the scene by *parsing* what it finds, an absent section came back
   * as its default rather than as an error. So joining a room replaced a level's whole visual
   * script with an empty graph, and its ground cover with nothing — silently, and only when a
   * second person was present. The compile-time guard in `collab.ts` is what stops it recurring;
   * this is the runtime half, written against the sections rather than against the list.
   */
  const populated = (): Scene =>
    SceneSchema.parse({
      sceneId: 'scene_collab',
      version: CURRENT_SCENE_VERSION,
      name: 'Shared Level',
      objects: [
        { id: 'obj_0001', assetId: 'tree_pine_01' },
        { id: 'obj_0002', assetId: 'rock_boulder_01' },
      ],
      graph: {
        nodes: [{ id: 'n_start', type: 'onStart' }],
        variables: [{ name: 'score', type: 'number', initial: 0 }],
        layout: { n_start: [10, 20] },
      },
      scatter: [{ id: 'cover', assetId: 'grass_large', density: 30 }],
      joints: [{ id: 'hinge', type: 'hinge', objectA: 'obj_0001', objectB: 'obj_0002' }],
    });

  it('carries the graph, the ground cover and the joints into a room', () => {
    const start = populated();
    const doc = new Y.Doc();
    seedScene(doc, start);

    const back = readScene(doc);
    expect(back.graph.nodes.map((node) => node.id)).toEqual(['n_start']);
    expect(back.graph.variables).toHaveLength(1);
    expect(back.scatter.map((layer) => layer.id)).toEqual(['cover']);
    expect(back.joints.map((joint) => joint.id)).toEqual(['hinge']);
  });

  it('merges a joint added by one client with a graph node added by the other', () => {
    const start = populated();
    const { a, b, sync } = pair(start);

    const mine: Scene = {
      ...start,
      joints: [
        ...start.joints,
        JointSchema.parse({ id: 'rope', type: 'rope', objectA: 'obj_0001', objectB: 'obj_0002' }),
      ],
    };
    applyScene(a, mine, start);

    const theirs = structuredClone(start);
    theirs.graph = { ...theirs.graph, layout: { ...theirs.graph.layout, n_start: [99, 99] } };
    applyScene(b, theirs, start);

    sync();

    // Different sections, so neither edit costs the other one. Section-level last-write-wins only
    // bites two people inside the *same* section, which is the trade `SYNCED_SECTIONS` documents.
    for (const doc of [a, b]) {
      expect(readScene(doc).joints).toHaveLength(2);
      expect(readScene(doc).graph.layout['n_start']).toEqual([99, 99]);
    }
  });
});
