import { useEffect, useRef } from 'react';
import { useProjectStore } from './store/projectStore';
import { useSceneStore } from './store/sceneStore';

/** Quiet period after the last edit before an autosave fires. */
export const AUTOSAVE_DELAY_MS = 20_000;

/**
 * Saves the open project a short while after editing stops.
 *
 * Debounced on the trailing edge rather than run on a timer: saving mid-gesture would serialise a
 * half-finished drag, and a fixed interval would write during a sculpt stroke — the one moment
 * when the document is largest and the frame budget tightest.
 *
 * A save also fires when the tab is hidden, which is the closest thing the browser offers to
 * "the user is leaving" that still reliably runs.
 */
export function useAutosave(enabled: boolean): void {
  const scene = useSceneStore((state) => state.scene);
  const projectId = useProjectStore((state) => state.projectId);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedProject = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !projectId) return;

    // The run right after a project opens is the document being loaded, not edited.
    //
    // Tracked here rather than reset from a second effect keyed on `projectId`: effects run in
    // declaration order, so that reset landed *after* this one and left the flag raised — which
    // swallowed the first real edit of every session, dirty flag, autosave and all.
    if (loadedProject.current !== projectId) {
      loadedProject.current = projectId;
      return;
    }

    useProjectStore.getState().markDirty();

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void useProjectStore.getState().save();
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [scene, enabled, projectId]);

  useEffect(() => {
    if (!enabled) return;

    const flush = (): void => {
      if (document.visibilityState === 'hidden' && useProjectStore.getState().dirty) {
        void useProjectStore.getState().save();
      }
    };

    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [enabled]);
}
