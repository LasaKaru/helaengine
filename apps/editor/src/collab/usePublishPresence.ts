import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import { currentSession } from './current';

/**
 * Tells the room what this user has selected and whether they are mid-gesture.
 *
 * Subscribed to the stores rather than called from each interaction site, because "publish my
 * presence" would otherwise have to be remembered in the gizmo, the marquee, the scene tree, the
 * inspector and every future selection affordance — and the one that forgets is the one that leaves
 * a stale highlight on somebody else's screen.
 *
 * Camera position is deliberately **not** published on every frame. An orbit is sixty updates a
 * second per person, all of which are broadcast to everybody in the room, to move a dot. Presence
 * updates that cost more bandwidth than the edits are a bad trade, and the camera is only used for
 * an avatar position — so it is not published at all yet, and the field is in the schema for when
 * there is a "jump to them" affordance that justifies it.
 */
export function usePublishPresence(): void {
  useEffect(() => {
    const publishSelection = (selection: string[]): void => {
      currentSession()?.setPresence({ selection });
    };

    // Published immediately as well as on change: a session that connects after a selection was
    // made would otherwise show that user as having nothing selected until they clicked again.
    publishSelection(useSceneStore.getState().selectedIds);

    const stopScene = useSceneStore.subscribe((state, previous) => {
      if (state.selectedIds === previous.selectedIds) return;
      publishSelection(state.selectedIds);
    });

    /**
     * The soft-lock flag.
     *
     * `drag` is the editor's own record of an in-flight gesture — a gizmo drag, an asset being
     * placed — which is exactly what "Alex is editing this" should mean. Reusing it rather than
     * inventing a second notion of "busy" keeps the indicator honest: it is on precisely when the
     * editor itself believes a gesture is happening.
     */
    const stopEditor = useEditorStore.subscribe((state, previous) => {
      const editing = state.drag !== null;
      if (editing === (previous.drag !== null)) return;
      currentSession()?.setPresence({ editing });
    });

    return () => {
      stopScene();
      stopEditor();
    };
  }, []);
}
