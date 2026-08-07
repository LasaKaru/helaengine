/**
 * Three.js itself, re-exported.
 *
 * For exported projects, which have no package manager: somebody hand-editing an export needs a
 * `Vector3` and has nowhere else to get one. In the editor and the co-op server this is the very
 * same module instance — `three` is external in that build — so it cannot become a second copy.
 */
export * as THREE from 'three';
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
export {
  PickupBehavior,
  PickupParamsSchema,
  pickupDefinition,
} from './behaviors/PickupBehavior.js';
export type { PickupParams } from './behaviors/PickupBehavior.js';
export {
  CheckpointBehavior,
  CheckpointParamsSchema,
  checkpointDefinition,
} from './behaviors/CheckpointBehavior.js';
export type { CheckpointParams } from './behaviors/CheckpointBehavior.js';
export { registerBuiltinBehaviors } from './behaviors/builtins.js';
export { Animator } from './animation/Animator.js';
export { cloneModel, hasSkeleton } from './animation/clone.js';
export { SaveStore, saveKey } from './save/SaveStore.js';
export { CoopClient } from './net/CoopClient.js';
export type { CoopClientOptions, CoopTransport, CoopInput, CoopStatus } from './net/CoopClient.js';
export { RemotePlayers, interpolateAngle } from './net/RemotePlayers.js';
export type { RemotePlayerSnapshot } from './net/RemotePlayers.js';
export { AudioSystem } from './audio/AudioSystem.js';
export type { AudioSystemOptions, SfxVoice } from './audio/AudioSystem.js';
export { MixerStore, MIXER_KEY } from './audio/MixerStore.js';
export { MusicPlayer } from './audio/MusicPlayer.js';
export type { MusicPlayerOptions, MusicTrack } from './audio/MusicPlayer.js';
export type { SaveStorage, SaveStoreOptions } from './save/SaveStore.js';
export { Inventory } from './combat/Inventory.js';
export type { CarriedWeapon } from './combat/Inventory.js';
export { WeaponSystem } from './combat/WeaponSystem.js';
export type { WeaponSystemOptions, WeaponInput, ShotHit } from './combat/WeaponSystem.js';
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
export { GltfModelSource, disposeObjectTree, modelClips, setModelClips } from './models.js';
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
export { UnlockRuntime } from './unlock/UnlockRuntime.js';
export type { UnlockRuntimeOptions } from './unlock/UnlockRuntime.js';
export { createDetector, TRIGGER_ENTERED } from './unlock/detectors.js';
export type { UnlockDetector } from './unlock/detectors.js';
export { GameRuntime, startScene } from './GameRuntime.js';
export type { GameRuntimeOptions } from './GameRuntime.js';
export { TriggerRuntime } from './TriggerRuntime.js';
export type { TriggerRuntimeOptions, EventBus } from './TriggerRuntime.js';
export { INERT_WORLD } from './world.js';
export type { WorldHandle, SpawnRequest, PickupRequest, CheckpointRequest } from './world.js';
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
