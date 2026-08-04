import { SceneSchema, type RepairPatch, type Scene } from '@helaengine/schema';

/**
 * Applies one patch to a scene, or explains why it will not.
 *
 * Two guarantees hold here and they are the reason this is a function rather than a spread:
 *
 * 1. **The result is re-parsed by `SceneSchema`.** A patch that produces a document the schema
 *    refuses is not applied at all. So the worst a bad proposal can do is fail — never leave a
 *    half-valid scene behind, and never smuggle an unexpected field in beside a legitimate edit.
 * 2. **The `switch` is exhaustive.** The `never` in the default arm means adding an operation to
 *    the union without handling it here is a compile error rather than a silent no-op that reports
 *    success.
 *
 * The input is not mutated. Repair is speculative — a patch that fails re-verification is thrown
 * away and the previous scene continues — so an in-place edit would corrupt the fallback.
 */
export type ApplyResult = { ok: true; scene: Scene } | { ok: false; reason: string };

export function applyPatch(scene: Scene, patch: RepairPatch): ApplyResult {
  const objectExists = (id: string): boolean => scene.objects.some((object) => object.id === id);

  let next: unknown;

  switch (patch.op) {
    case 'setPlayerSpawn':
      next = { ...scene, player: { ...scene.player, spawn: patch.spawn } };
      break;

    case 'setObjectPosition':
      if (!objectExists(patch.objectId)) return missing(patch.objectId);
      next = {
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === patch.objectId
            ? { ...object, transform: { ...object.transform, position: patch.position } }
            : object,
        ),
      };
      break;

    case 'setObjectCollider':
      if (!objectExists(patch.objectId)) return missing(patch.objectId);
      next = {
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === patch.objectId
            ? { ...object, physics: { ...object.physics, collider: patch.collider } }
            : object,
        ),
      };
      break;

    case 'clearObjectTrigger':
      if (!objectExists(patch.objectId)) return missing(patch.objectId);
      next = {
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === patch.objectId ? { ...object, trigger: null } : object,
        ),
      };
      break;

    case 'removeObject': {
      if (!objectExists(patch.objectId)) return missing(patch.objectId);
      // Children go with the parent, exactly as a delete in the editor does. Leaving them behind
      // would orphan them onto the world origin, which is a stranger scene than the broken one.
      const doomed = descendantsOf(scene, patch.objectId);
      next = { ...scene, objects: scene.objects.filter((object) => !doomed.has(object.id)) };
      break;
    }

    default: {
      const unreachable: never = patch;
      return { ok: false, reason: `unhandled repair operation: ${JSON.stringify(unreachable)}` };
    }
  }

  const parsed = SceneSchema.safeParse(next);
  if (!parsed.success) {
    return { ok: false, reason: `the patched scene is not valid: ${parsed.error.message}` };
  }
  return { ok: true, scene: parsed.data };
}

function missing(objectId: string): ApplyResult {
  return { ok: false, reason: `there is no object "${objectId}" in this scene` };
}

/** The object and everything parented beneath it, however deep. */
function descendantsOf(scene: Scene, rootId: string): Set<string> {
  const doomed = new Set([rootId]);
  let grew = true;

  while (grew) {
    grew = false;
    for (const object of scene.objects) {
      if (object.parentId && doomed.has(object.parentId) && !doomed.has(object.id)) {
        doomed.add(object.id);
        grew = true;
      }
    }
  }
  return doomed;
}
