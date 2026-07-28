import * as THREE from 'three';
import type { Scene, SceneObject, Transform, Vec3 } from '@helaengine/schema';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function tidy(value: number): number {
  return Number(value.toFixed(4));
}

/** Composes an object's local transform into a matrix. */
function localMatrix(transform: Transform): THREE.Matrix4 {
  const euler = new THREE.Euler(
    transform.rotation[0] * DEG2RAD,
    transform.rotation[1] * DEG2RAD,
    transform.rotation[2] * DEG2RAD,
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(...transform.scale),
  );
}

/**
 * World matrix of an object, walking up the document's parent chain.
 *
 * Derived from the document rather than read off the Three.js nodes on purpose: reparenting is a
 * document edit, and computing it from the same data the document stores keeps the result
 * independent of whatever the renderer happens to have built.
 */
export function worldMatrix(scene: Scene, objectId: string): THREE.Matrix4 {
  const byId = new Map(scene.objects.map((object) => [object.id, object]));

  const chain: SceneObject[] = [];
  const seen = new Set<string>();
  let current = byId.get(objectId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }

  const matrix = new THREE.Matrix4();
  for (const object of chain) matrix.multiply(localMatrix(object.transform));
  return matrix;
}

/**
 * The local transform an object needs under a new parent to stay exactly where it looks.
 *
 * Without this, dropping a lamp onto a building teleports the lamp by the building's offset —
 * technically a correct reparent, and visibly wrong to the person who did it.
 */
export function reparentedTransform(
  scene: Scene,
  objectId: string,
  newParentId: string | null,
): Transform {
  const world = worldMatrix(scene, objectId);

  if (newParentId !== null) {
    const parentWorld = worldMatrix(scene, newParentId);
    world.premultiply(parentWorld.invert());
  }

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  world.decompose(position, quaternion, scale);

  const euler = new THREE.Euler().setFromQuaternion(quaternion);

  const asVec = (vector: THREE.Vector3): Vec3 => [tidy(vector.x), tidy(vector.y), tidy(vector.z)];

  return {
    position: asVec(position),
    rotation: [tidy(euler.x * RAD2DEG), tidy(euler.y * RAD2DEG), tidy(euler.z * RAD2DEG)],
    scale: asVec(scale),
  };
}

export interface TreeNode {
  object: SceneObject;
  depth: number;
  children: TreeNode[];
}

/** Builds the display tree. Objects whose parent is missing surface at the root rather than vanish. */
export function buildTree(scene: Scene): TreeNode[] {
  const nodes = new Map<string, TreeNode>(
    scene.objects.map((object) => [object.id, { object, depth: 0, children: [] }]),
  );

  const roots: TreeNode[] = [];
  for (const object of scene.objects) {
    const node = nodes.get(object.id)!;
    const parent = object.parentId === null ? undefined : nodes.get(object.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const setDepth = (node: TreeNode, depth: number): void => {
    node.depth = depth;
    for (const child of node.children) setDepth(child, depth + 1);
  };
  for (const root of roots) setDepth(root, 0);

  return roots;
}

/** Flattens the tree into render order — parents immediately followed by their descendants. */
export function flattenTree(roots: TreeNode[]): TreeNode[] {
  const flat: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    flat.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return flat;
}
