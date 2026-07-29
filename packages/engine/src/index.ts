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
export { GameRuntime, startScene } from './GameRuntime.js';
export type { GameRuntimeOptions } from './GameRuntime.js';
export { TriggerRuntime } from './TriggerRuntime.js';
export type { TriggerRuntimeOptions, EventBus } from './TriggerRuntime.js';
export { INERT_WORLD } from './world.js';
export type { WorldHandle, SpawnRequest } from './world.js';
export { StateMachine } from './ai/StateMachine.js';
export type { State } from './ai/StateMachine.js';
export { SteeringAgent } from './ai/SteeringAgent.js';
export type { SteeringAgentOptions, SteeringMode } from './ai/SteeringAgent.js';
export {
  ChaseOnSightBehavior,
  ChaseOnSightParamsSchema,
  chaseOnSightDefinition,
} from './ai/ChaseOnSightBehavior.js';
export type { ChaseOnSightParams } from './ai/ChaseOnSightBehavior.js';
export { BUILTIN_ASSET_ENTRIES, isBuiltinTriggerAsset } from './assets.js';
export { InputManager, INPUT_ACTIONS, DEFAULT_KEY_BINDINGS } from './input/InputManager.js';
export type { InputAction, InputManagerOptions, Axis2 } from './input/InputManager.js';
export {
  FirstPersonRig,
  ThirdPersonRig,
  TopDownRig,
  createCameraRig,
  nextCameraMode,
  lookDirection,
} from './camera/CameraRig.js';
export type { CameraRig, CameraRigContext, CameraTarget, LookState } from './camera/CameraRig.js';
export { createPlayerAvatar } from './camera/PlayerAvatar.js';
export type { PlayerAvatar } from './camera/PlayerAvatar.js';
export { UIRenderer } from './ui/UIRenderer.js';
export type { UiScreen, UIRendererOptions, HudState } from './ui/UIRenderer.js';
export { themeVariables, panelStyleCss, THEME_PRESETS } from './ui/theme.js';
