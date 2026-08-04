import { TerrainField } from '@helaengine/engine';
import {
  CURRENT_SCENE_VERSION,
  SceneSchema,
  type AudioConfigInput,
  type Scene,
  type Vec3,
} from '@helaengine/schema';

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
  behaviors?: Array<{ type: string; params: Record<string, unknown> }>;
  body?: 'static' | 'dynamic' | 'kinematic';
  /** Overrides the asset's collider. `none` is what a marker you walk *through* needs. */
  collider?: 'none';
  trigger?: Record<string, unknown>;
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

interface SceneExtras {
  terrain?: Partial<Scene['terrain']>;
  inventory?: Partial<Scene['inventory']>;
  unlockables?: Scene['unlockables'];
  audioConfig?: AudioConfigInput;
  /**
   * Where the player starts.
   *
   * Worth an explicit field rather than the schema's `[0, 0, 0]` default, because the origin is
   * also where a level designer naturally puts the centrepiece. The Village Outpost put its hut
   * there, and the player spawned inside it, wedged in its collider and unable to walk out — a bug
   * that survived every test this repo had until something actually tried to move.
   */
  player?: Partial<Scene['player']>;
}

function buildScene(name: string, placements: Placement[], extras: SceneExtras = {}): Scene {
  counter = 0;
  return SceneSchema.parse({
    sceneId: `scene_${Math.random().toString(36).slice(2, 10)}`,
    version: CURRENT_SCENE_VERSION,
    name,
    terrain: extras.terrain ?? {},
    inventory: extras.inventory ?? {},
    unlockables: extras.unlockables ?? [],
    audioConfig: extras.audioConfig ?? {},
    player: extras.player ?? {},
    objects: placements.map((placement) => ({
      id: objectId(),
      assetId: placement.assetId,
      transform: {
        position: placement.position,
        rotation: [0, placement.rotationY ?? 0, 0],
        scale: [placement.scale ?? 1, placement.scale ?? 1, placement.scale ?? 1],
      },
      ...(placement.behaviors ? { behaviors: placement.behaviors } : {}),
      ...(placement.trigger ? { trigger: placement.trigger } : {}),
      ...(placement.body || placement.collider
        ? {
            physics: {
              ...(placement.body ? { body: placement.body } : {}),
              ...(placement.collider ? { collider: placement.collider } : {}),
            },
          }
        : {}),
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
        terrain: sculptedTerrain((field) => {
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
        // In front of the hut rather than inside it. The hut stands at the origin, which is also
        // where the schema's default spawn is, so the player used to start wedged in its collider
        // with nowhere to walk — found by the pre-delivery smoke test, not by anybody reading this.
        player: { spawn: [0, 0, 9] },
        terrain: sculptedTerrain((field) => {
          field.sculpt(30, -30, 'raise', { radius: 34, strength: 0.5 });
          field.sculpt(-40, 20, 'raise', { radius: 28, strength: 0.35 });
          // Level the ground the hut stands on, so the buildings are not perched on a slope.
          field.sculpt(0, 0, 'flatten', { radius: 18, strength: 1 });
          field.paint(30, -30, 1, { radius: 24, strength: 0.8 });
        }),
      });
    },
  },
  {
    id: 'skirmish',
    name: 'Skirmish',
    description:
      'A pistol on a crate, a goblin that fights back, and medkits. The shortest path to a playable game.',
    build: () => {
      const random = seeded(20260816);
      const placements: Placement[] = [
        {
          assetId: 'prop_crate_01',
          position: [0, 0, -6],
          label: 'Pistol crate',
          behaviors: [
            { type: 'pickup', params: { kind: 'weapon', weaponId: 'weapon_0001', radius: 2 } },
          ],
        },
        {
          assetId: 'prop_barrel_01',
          position: [6, 0, -10],
          label: 'Ammo',
          behaviors: [
            {
              type: 'pickup',
              params: {
                kind: 'ammo',
                weaponId: 'weapon_0001',
                amount: 24,
                radius: 2,
                respawnSeconds: 20,
              },
            },
          ],
        },
        {
          assetId: 'prop_crate_01',
          position: [-6, 0, -10],
          label: 'Medkit',
          behaviors: [
            {
              type: 'pickup',
              params: { kind: 'health', amount: 40, radius: 2, respawnSeconds: 25 },
            },
          ],
        },
        {
          assetId: 'enemy_goblin_01',
          position: [2, 0, -20],
          rotationY: 180,
          label: 'Goblin',
          behaviors: [
            {
              type: 'chaseOnSight',
              params: { sightRange: 24, chaseSpeed: 3.5, health: 60, attackDamage: 12 },
            },
          ],
        },
        {
          assetId: 'enemy_goblin_01',
          position: [-3, 0, -24],
          rotationY: 170,
          label: 'Goblin two',
          behaviors: [
            {
              type: 'chaseOnSight',
              params: { sightRange: 24, chaseSpeed: 3.5, health: 60, attackDamage: 12 },
            },
          ],
        },
        // Two secrets' worth of scenery and two checkpoints. Placed before the generated treeline
        // so their ids stay obj_0006..obj_0009 no matter what the tree loop does.
        {
          assetId: 'building_hut_01',
          position: [-16, 0, -26],
          rotationY: 30,
          label: 'Hidden hut',
        },
        {
          assetId: 'logic_trigger_box',
          position: [14, 0, -6],
          scale: 4,
          label: 'Alcove',
          trigger: { shape: 'box', detects: 'player', once: false },
        },
        {
          assetId: 'prop_fence_01',
          position: [0, 0, -2],
          label: 'Checkpoint one',
          // No collider: a checkpoint is a place, and one you bounce off is a wall with a saving
          // throw attached. Found by walking into it.
          collider: 'none',
          behaviors: [{ type: 'checkpoint', params: { radius: 3, reset: { health: 'full' } } }],
        },
        {
          assetId: 'prop_fence_01',
          position: [0, 0, -16],
          label: 'Checkpoint two',
          collider: 'none',
          // Deeper into the fight, so it hands the ammo back as well — a scarcity stretch that
          // never refills is a checkpoint you dread rather than one you want.
          behaviors: [
            { type: 'checkpoint', params: { radius: 3, reset: { health: 'full', ammo: 'full' } } },
          ],
        },
      ];

      // A treeline, so the fight has cover and the line-of-sight checks have something to do.
      for (let index = 0; index < 14; index += 1) {
        const angle = (index / 14) * Math.PI * 2 + random() * 0.3;
        const distance = 26 + random() * 8;
        placements.push({
          assetId: random() > 0.5 ? 'tree_pine_01' : 'tree_oak_01',
          position: [
            Number((Math.cos(angle) * distance).toFixed(2)),
            0,
            Number((Math.sin(angle) * distance).toFixed(2)),
          ],
          rotationY: Number((random() * 360).toFixed(1)),
        });
      }

      return buildScene('Skirmish', placements, {
        terrain: sculptedTerrain((field) => {
          // Flat where the fight happens: a first playable should not also be a hill climb.
          field.sculpt(0, -12, 'flatten', { radius: 30, strength: 1 });
          field.sculpt(34, 20, 'raise', { radius: 26, strength: 0.4 });
        }),
        inventory: {
          weapons: [
            {
              id: 'weapon_0001',
              name: 'Pistol',
              damage: 30,
              range: 60,
              fireInterval: 0.28,
              automatic: false,
              clipSize: 8,
              reserveAmmo: 40,
              reloadSeconds: 1.1,
              spreadDegrees: 1.2,
            },
            {
              id: 'weapon_0002',
              name: 'Rifle',
              damage: 45,
              range: 120,
              fireInterval: 0.12,
              automatic: true,
              clipSize: 24,
              reserveAmmo: 96,
              reloadSeconds: 1.8,
              spreadDegrees: 2.5,
            },
          ],
          // Nothing to start with: finding the crate is the first thing the scene asks you to do,
          // and the rifle is behind a secret.
          startingWeaponIds: [],
        },
        unlockables: [
          {
            id: 'secret_0001',
            label: 'Rifle cache',
            unlockMethod: {
              type: 'inputSequence',
              sequence: ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right', 'B', 'A'],
              withinSeconds: 2,
            },
            actions: [{ type: 'unlockInventoryItem', weaponId: 'weapon_0002' }],
            once: true,
          },
          {
            id: 'secret_0002',
            label: 'Hidden hut',
            // The alcove volume, which is invisible in play like every other trigger.
            unlockMethod: { type: 'triggerVolume', triggerId: 'obj_0007' },
            actions: [
              { type: 'revealArea', objectIds: ['obj_0006'] },
              { type: 'emit', event: 'hutRevealed', payload: {} },
            ],
            once: true,
          },
        ],
        audioConfig: {
          music: {
            menuTrackAssetId: 'audio_music_menu',
            exploreTrackAssetId: 'audio_music_explore',
            combatTrackAssetId: 'audio_music_combat',
            crossfadeSeconds: 1.5,
            combatHoldSeconds: 6,
          },
          // Bound to event names the rest of the engine already raises — no gameplay code knows
          // that any of this makes a noise.
          sfx: [
            { event: 'pickup', assetId: 'audio_sfx_pickup' },
            { event: 'checkpoint', assetId: 'audio_sfx_checkpoint' },
            { event: 'playerDamaged', assetId: 'audio_sfx_damage' },
            { event: 'playerDied', assetId: 'audio_sfx_death' },
            { event: 'weaponFired', assetId: 'audio_sfx_shoot', volume: 0.7 },
            { event: 'weaponReloaded', assetId: 'audio_sfx_reload' },
            { event: 'secretUnlocked', assetId: 'audio_sfx_secret' },
            // In the world rather than in both ears: a goblin dying behind you should sound like
            // it happened behind you.
            { event: 'enemyDied', assetId: 'audio_sfx_death', positional: true, volume: 0.8 },
          ],
        },
      });
    },
  },
  {
    id: 'stress-test',
    name: 'Stress test',
    description:
      '520 objects: a forest of instanced props and twenty patrolling goblins. The recurring performance benchmark.',
    build: buildStressScene,
  },
];

/**
 * The performance benchmark scene, described in `docs/PERFORMANCE.md`.
 *
 * Deliberately shaped like a real level rather than like a synthetic torture test: five hundred
 * static props drawn from a handful of assets, so instancing has something to batch, plus twenty
 * enemies that each run a patrol, an AI state machine and a kinematic body — the things that cost
 * CPU rather than draw calls. A benchmark that only stressed one of those would hide the other.
 */
export function buildStressScene(): Scene {
  const random = seeded(20260801);
  const placements: Placement[] = [];
  const props = [
    'tree_pine_01',
    'tree_pine_02',
    'tree_oak_01',
    'rock_boulder_01',
    'rock_shard_01',
    'prop_barrel_01',
    'prop_crate_01',
    'prop_fence_01',
  ];

  for (let index = 0; index < 500; index += 1) {
    const assetId = props[Math.floor(random() * props.length)]!;
    placements.push({
      assetId,
      position: [
        Number(((random() - 0.5) * 118).toFixed(2)),
        0,
        Number(((random() - 0.5) * 118).toFixed(2)),
      ],
      rotationY: Number((random() * 360).toFixed(1)),
      scale: Number((0.8 + random() * 0.5).toFixed(2)),
    });
  }

  for (let index = 0; index < 20; index += 1) {
    const angle = (index / 20) * Math.PI * 2;
    const distance = 18 + random() * 34;
    const x = Number((Math.cos(angle) * distance).toFixed(2));
    const z = Number((Math.sin(angle) * distance).toFixed(2));
    placements.push({
      assetId: 'enemy_goblin_01',
      position: [x, 0, z],
      label: `Goblin ${index + 1}`,
      body: 'kinematic',
      behaviors: [
        {
          type: 'patrol',
          params: {
            waypoints: [
              [x, 0, z],
              [Number((x * 0.4).toFixed(2)), 0, Number((z * 0.4).toFixed(2))],
            ],
            speed: 2 + random(),
            mode: 'pingPong',
          },
        },
        {
          type: 'chaseOnSight',
          params: { sightRange: 22, chaseSpeed: 4, attackDamage: 4, attackInterval: 1.5 },
        },
      ],
    });
  }

  return buildScene('Stress Test', placements, {
    terrain: sculptedTerrain((field) => {
      field.sculpt(-40, -30, 'raise', { radius: 40, strength: 0.5 });
      field.sculpt(35, 34, 'raise', { radius: 36, strength: 0.4 });
      field.sculpt(0, 0, 'smooth', { radius: 70, strength: 0.5 });
      field.paint(-40, -30, 1, { radius: 30, strength: 0.8 });
    }),
  });
}

export function templateById(id: string): SceneTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
