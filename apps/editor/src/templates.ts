import { TerrainField } from '@helaengine/engine';
import { CURRENT_SCENE_VERSION, SceneSchema, type Scene, type Vec3 } from '@helaengine/schema';

export interface SceneTemplate {
  id: string;
  name: string;
  description: string;
  build(): Scene;
}

let counter = 0;
function objectId(): string {
  counter += 1;
  return `obj_${String(counter).padStart(4, '0')}`;
}

interface Placement {
  assetId: string;
  position: Vec3;
  rotationY?: number;
  scale?: number;
  label?: string;
}

/**
 * A deterministic pseudo-random source.
 *
 * Templates are generated rather than hand-listed, and a fixed seed means "Forest Clearing" is the
 * same clearing every time — which matters when someone reports a problem with it.
 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function buildScene(
  name: string,
  placements: Placement[],
  terrain: Partial<Scene['terrain']> = {},
): Scene {
  counter = 0;
  return SceneSchema.parse({
    sceneId: `scene_${Math.random().toString(36).slice(2, 10)}`,
    version: CURRENT_SCENE_VERSION,
    name,
    terrain,
    objects: placements.map((placement) => ({
      id: objectId(),
      assetId: placement.assetId,
      transform: {
        position: placement.position,
        rotation: [0, placement.rotationY ?? 0, 0],
        scale: [placement.scale ?? 1, placement.scale ?? 1, placement.scale ?? 1],
      },
      ...(placement.label ? { metadata: { label: placement.label } } : {}),
    })),
  });
}

/** Sculpts a terrain procedurally and returns it as document data. */
function sculptedTerrain(
  shape: (field: TerrainField) => void,
): Pick<Scene['terrain'], 'type' | 'heightmap' | 'splatmap'> {
  const field = new TerrainField({ segments: 64, size: [128, 128], maxHeight: 20 });
  shape(field);
  return {
    type: 'heightmap',
    heightmap: { encoding: 'base64', data: field.encodeHeights() },
    splatmap: { encoding: 'base64', data: field.encodeWeights() },
  };
}

export const TEMPLATES: SceneTemplate[] = [
  {
    id: 'blank',
    name: 'Empty field',
    description: 'Flat ground and nothing else. Start from scratch.',
    build: () => buildScene('Untitled scene', []),
  },
  {
    id: 'forest-clearing',
    name: 'Forest clearing',
    description: 'A ring of trees around open ground, with scattered rocks.',
    build: () => {
      const random = seeded(20260728);
      const placements: Placement[] = [];

      // Trees around a clearing, jittered so the ring does not read as a circle.
      for (let index = 0; index < 22; index += 1) {
        const angle = (index / 22) * Math.PI * 2 + (random() - 0.5) * 0.25;
        const distance = 22 + random() * 14;
        placements.push({
          assetId:
            random() > 0.55 ? 'tree_oak_01' : random() > 0.4 ? 'tree_pine_01' : 'tree_pine_02',
          position: [
            Number((Math.cos(angle) * distance).toFixed(2)),
            0,
            Number((Math.sin(angle) * distance).toFixed(2)),
          ],
          rotationY: Number((random() * 360).toFixed(1)),
          scale: Number((0.85 + random() * 0.4).toFixed(2)),
        });
      }

      for (let index = 0; index < 7; index += 1) {
        const angle = random() * Math.PI * 2;
        const distance = random() * 16;
        placements.push({
          assetId: random() > 0.5 ? 'rock_boulder_01' : 'rock_shard_01',
          position: [
            Number((Math.cos(angle) * distance).toFixed(2)),
            0,
            Number((Math.sin(angle) * distance).toFixed(2)),
          ],
          rotationY: Number((random() * 360).toFixed(1)),
        });
      }

      return buildScene('Forest Clearing', placements, {
        ...sculptedTerrain((field) => {
          // A gentle rise on one side, so the clearing is not a perfectly level disc.
          field.sculpt(-34, -28, 'raise', { radius: 40, strength: 0.55 });
          field.sculpt(38, 30, 'raise', { radius: 30, strength: 0.3 });
          field.sculpt(0, 0, 'smooth', { radius: 60, strength: 0.6 });
        }),
      });
    },
  },
  {
    id: 'village-outpost',
    name: 'Village outpost',
    description: 'A hut, a fenced yard with supplies, and a pair of goblins nosing around.',
    build: () => {
      const random = seeded(19950214);
      const placements: Placement[] = [
        { assetId: 'building_hut_01', position: [0, 0, 0], rotationY: 20, label: 'Hut' },
        { assetId: 'prop_barrel_01', position: [3.4, 0, 3.1] },
        { assetId: 'prop_crate_01', position: [4.6, 0, 2], rotationY: 35 },
        { assetId: 'prop_crate_01', position: [4.4, 0, 3.4], rotationY: 12 },
        { assetId: 'prop_fence_01', position: [-4.4, 0, -6] },
        { assetId: 'prop_fence_01', position: [-2.1, 0, -6] },
        { assetId: 'prop_fence_01', position: [0.2, 0, -6] },
        {
          assetId: 'enemy_goblin_01',
          position: [5.2, 0, -4],
          rotationY: 205,
          label: 'Goblin scout',
        },
        {
          assetId: 'enemy_goblin_01',
          position: [7.4, 0, -2],
          rotationY: 160,
          label: 'Goblin lookout',
        },
      ];

      for (let index = 0; index < 12; index += 1) {
        const angle = (index / 12) * Math.PI * 2 + random() * 0.4;
        const distance = 20 + random() * 10;
        placements.push({
          assetId: random() > 0.5 ? 'tree_pine_01' : 'tree_pine_02',
          position: [
            Number((Math.cos(angle) * distance).toFixed(2)),
            0,
            Number((Math.sin(angle) * distance).toFixed(2)),
          ],
          rotationY: Number((random() * 360).toFixed(1)),
        });
      }

      return buildScene('Village Outpost', placements, {
        ...sculptedTerrain((field) => {
          field.sculpt(30, -30, 'raise', { radius: 34, strength: 0.5 });
          field.sculpt(-40, 20, 'raise', { radius: 28, strength: 0.35 });
          // Level the ground the hut stands on, so the buildings are not perched on a slope.
          field.sculpt(0, 0, 'flatten', { radius: 18, strength: 1 });
          field.paint(30, -30, 1, { radius: 24, strength: 0.8 });
        }),
      });
    },
  },
];

export function templateById(id: string): SceneTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
