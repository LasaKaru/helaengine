import type * as Rapier from '@dimforge/rapier3d-compat';

/**
 * The Rapier namespace. Imported as a type only — the runtime import below is dynamic, and a
 * static one here would defeat it.
 */
export type RapierModule = typeof Rapier;

let pending: Promise<RapierModule> | null = null;
let loaded: RapierModule | null = null;

/**
 * Loads and initialises Rapier, once per page.
 *
 * Rapier ships as WebAssembly and cannot be used until its module has been instantiated, which is
 * asynchronous. The sprint plan is explicit that this should be handled at bootstrap rather than
 * scattered as readiness checks through the codebase, so this is the only place that knows about
 * it: everything downstream takes a resolved module and stays synchronous.
 *
 * The import is dynamic on purpose. The compat build inlines the entire `.wasm` as base64, so a
 * static import would put roughly a megabyte into the first chunk of every page — including the
 * projects screen, which has no physics in it.
 */
export async function initPhysics(): Promise<RapierModule> {
  if (loaded) return loaded;
  pending ??= import('@dimforge/rapier3d-compat').then(async (module) => {
    await module.init();
    loaded = module;
    return module;
  });

  try {
    return await pending;
  } catch (error) {
    // A failed init must not poison every later attempt: a reload of the wasm may well succeed.
    pending = null;
    throw error;
  }
}

/** The module if `initPhysics` has already resolved, otherwise null. Never triggers a load. */
export function physicsModule(): RapierModule | null {
  return loaded;
}

/** True once physics can be used synchronously. */
export function isPhysicsReady(): boolean {
  return loaded !== null;
}
