import type { SceneObject, Transform, Vec3 } from '@helaengine/schema';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

const DEG2RAD = Math.PI / 180;

function tidy(value: number): number {
  return Number(value.toFixed(4));
}

function tidyVec(vector: Vec3): Vec3 {
  return [tidy(vector[0]), tidy(vector[1]), tidy(vector[2])];
}

/** Centroid of a set of objects — where a multi-selection gizmo sits. */
export function selectionPivot(objects: SceneObject[]): Vec3 {
  if (objects.length === 0) return [0, 0, 0];

  let x = 0;
  let y = 0;
  let z = 0;
  for (const object of objects) {
    x += object.transform.position[0];
    y += object.transform.position[1];
    z += object.transform.position[2];
  }
  const count = objects.length;
  return [x / count, y / count, z / count];
}

/** Rotates a point about the Y axis around a pivot. Yaw in degrees. */
function rotateAboutPivotY(point: Vec3, pivot: Vec3, yawDegrees: number): Vec3 {
  const yaw = yawDegrees * DEG2RAD;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const dx = point[0] - pivot[0];
  const dz = point[2] - pivot[2];
  return [pivot[0] + dx * cos + dz * sin, point[1], pivot[2] - dx * sin + dz * cos];
}

export interface GroupDelta {
  /** World-space translation applied to every selected object. */
  translation: Vec3;
  /** Yaw applied about the selection pivot, degrees. Roll/pitch are not offered for groups. */
  yaw: number;
  /** Uniform-per-axis scale factor applied about the selection pivot. */
  scale: Vec3;
}

export const IDENTITY_DELTA: GroupDelta = {
  translation: [0, 0, 0],
  yaw: 0,
  scale: [1, 1, 1],
};

/**
 * Applies a gizmo delta to a group of objects about a shared pivot.
 *
 * Rotation and scale move objects *around* the pivot as well as changing them, which is what makes
 * a multi-selection behave like one rigid thing rather than each object spinning in place. Only
 * yaw is offered for group rotation: pitching or rolling a group of ground-placed props tips them
 * off the terrain, and no one has ever wanted that.
 */
export function applyGroupDelta(
  objects: SceneObject[],
  pivot: Vec3,
  delta: GroupDelta,
): Array<{ id: string; transform: Transform }> {
  return objects.map((object) => {
    const { position, rotation, scale } = object.transform;

    const scaledPosition: Vec3 = [
      pivot[0] + (position[0] - pivot[0]) * delta.scale[0],
      pivot[1] + (position[1] - pivot[1]) * delta.scale[1],
      pivot[2] + (position[2] - pivot[2]) * delta.scale[2],
    ];

    const rotated =
      delta.yaw === 0 ? scaledPosition : rotateAboutPivotY(scaledPosition, pivot, delta.yaw);

    return {
      id: object.id,
      transform: {
        position: tidyVec([
          rotated[0] + delta.translation[0],
          rotated[1] + delta.translation[1],
          rotated[2] + delta.translation[2],
        ]),
        rotation: tidyVec([rotation[0], rotation[1] + delta.yaw, rotation[2]]),
        scale: tidyVec([
          scale[0] * delta.scale[0],
          scale[1] * delta.scale[1],
          scale[2] * delta.scale[2],
        ]),
      },
    };
  });
}

/** Normalises an angle to (-180, 180], so a gizmo that wraps past 180 does not spin the group. */
export function normalizeAngle(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Snaps a translation to the grid.
 *
 * Y is left alone for the same reason placement leaves it alone: height comes from the terrain the
 * object is standing on, and rounding it either floats or buries the object.
 */
export function snapPosition(position: Vec3, gridSize: number): Vec3 {
  const size = gridSize > 0 ? gridSize : 1;
  return [
    tidy(Math.round(position[0] / size) * size),
    tidy(position[1]),
    tidy(Math.round(position[2] / size) * size),
  ];
}
