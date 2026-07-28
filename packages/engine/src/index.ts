export {
  SceneLoader,
  LoadedScene,
  MissingAssetError,
  terrainFieldFromDocument,
} from './SceneLoader.js';
export { TerrainField, LAYER_COUNT } from './TerrainField.js';
export type { SculptMode, BrushOptions, TerrainFieldOptions } from './TerrainField.js';
export { bytesToBase64, base64ToBytes } from './base64.js';
export { BehaviorRuntime } from './BehaviorRuntime.js';
export type { BehaviorRuntimeOptions, BehaviorProblem } from './BehaviorRuntime.js';
export {
  BehaviorRegistry,
  behaviorRegistry,
  UnknownBehaviorError,
  InvalidBehaviorParamsError,
} from './behaviors/BehaviorRegistry.js';
export type {
  Behavior,
  BehaviorDefinition,
  GameObject,
  BehaviorContext,
} from './behaviors/Behavior.js';
export {
  PatrolBehavior,
  PatrolParamsSchema,
  patrolDefinition,
} from './behaviors/PatrolBehavior.js';
export type { PatrolParams } from './behaviors/PatrolBehavior.js';
export { registerBuiltinBehaviors } from './behaviors/builtins.js';
export type {
  SceneLoaderOptions,
  PreloadReport,
  PreloadFailure,
  PreloadProgress,
  PreviewNode,
} from './SceneLoader.js';
export { pickTerrain, pickObject } from './picking.js';
export type { SurfaceHit } from './picking.js';
export { ManifestAssetResolver, MISSING_ASSET_ENTRY } from './assets.js';
export type { AssetResolver } from './assets.js';
export { GltfModelSource, disposeObjectTree } from './models.js';
export type { ModelSource, GltfModelSourceOptions } from './models.js';
export { OrbitCamera } from './OrbitCamera.js';
export type { OrbitCameraOptions } from './OrbitCamera.js';
export { Viewport } from './Viewport.js';
export type { ViewportOptions, FrameCallback } from './Viewport.js';
export { ENGINE_VERSION } from './version.js';
export { PhysicsWorld } from './physics/PhysicsWorld.js';
export type { PhysicsWorldOptions, ObjectBodySpec, BodyRecord } from './physics/PhysicsWorld.js';
export { PlayerController } from './physics/PlayerController.js';
export type { MoveInput } from './physics/PlayerController.js';
export { initPhysics, isPhysicsReady, physicsModule } from './physics/rapier.js';
export type { RapierModule } from './physics/rapier.js';
export { colliderDescFor, collectTrimesh } from './physics/colliders.js';
export type { ColliderShapeInput, TrimeshData } from './physics/colliders.js';
export { buildScenePhysics, resolveColliderType } from './physics/buildScenePhysics.js';
export type {
  ScenePhysicsOptions,
  ScenePhysicsReport,
  ScenePhysicsSkip,
} from './physics/buildScenePhysics.js';
