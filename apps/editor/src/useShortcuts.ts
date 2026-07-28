import { useEffect } from 'react';
import { useEditorStore } from './store/editorStore';
import { useProjectStore } from './store/projectStore';
import { useSceneStore } from './store/sceneStore';

/**
 * The keybind scheme, in one place so the reference modal and the handler cannot drift apart.
 *
 * **Unity/PlayCanvas-style W/E/R**, not Blender's G/R/S. The audience for this editor is people
 * making browser games, most of whom will have met Unity or PlayCanvas before Blender, and W/E/R
 * keeps the left hand near the modifier keys. Documented here because "pick one and write it down"
 * is the actual requirement — the choice matters far less than not changing it later.
 */
export const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: 'P', description: 'Play / stop behaviours' },
  { keys: 'Shift + P', description: 'Walk the scene (Play Preview)' },
  { keys: '1 / 2 / 3', description: 'Select, Sculpt, Paint tool' },
  { keys: 'W', description: 'Move tool' },
  { keys: 'E', description: 'Rotate tool' },
  { keys: 'R', description: 'Scale tool' },
  { keys: 'Click', description: 'Select object' },
  { keys: 'Shift + Click', description: 'Add to / remove from selection' },
  { keys: 'Drag on empty space', description: 'Marquee select' },
  { keys: 'Ctrl/⌘ + S', description: 'Save' },
  { keys: 'Ctrl/⌘ + Z', description: 'Undo' },
  { keys: 'Ctrl/⌘ + Shift + Z', description: 'Redo' },
  { keys: 'Ctrl/⌘ + Y', description: 'Redo (alternate)' },
  { keys: 'Ctrl/⌘ + D', description: 'Duplicate selection' },
  { keys: 'Ctrl/⌘ + A', description: 'Select all' },
  { keys: 'Delete / Backspace', description: 'Delete selection' },
  { keys: 'Escape', description: 'Leave walk mode, or clear the selection' },
  { keys: '?', description: 'Show this list' },
];

/** True when the user is typing, so shortcuts stay out of the way of text entry. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/** Objects above which deleting asks first, so a stray Delete cannot wipe out a scene. */
export const BULK_DELETE_THRESHOLD = 5;

export interface ShortcutOptions {
  /** Injectable so tests do not have to stub `window.confirm`. */
  confirm?: (message: string) => boolean;
}

export function useShortcuts(options: ShortcutOptions = {}): void {
  const confirmDelete = options.confirm;

  useEffect(() => {
    const ask = confirmDelete ?? ((message: string) => window.confirm(message));

    const handler = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;

      const scene = useSceneStore.getState();
      const editor = useEditorStore.getState();
      const selected = scene.selectedIds;
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 's') {
        // The browser's own save dialog is never what someone wants here.
        event.preventDefault();
        void useProjectStore.getState().save();
        return;
      }

      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) scene.redo();
        else scene.undo();
        return;
      }

      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        scene.redo();
        return;
      }

      if (modifier && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        if (selected.length > 0) scene.duplicateObjects(selected);
        return;
      }

      if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        scene.select(scene.scene.objects.map((object) => object.id));
        return;
      }

      if (modifier) return;

      // Walk mode owns the keyboard: WASD is movement, not tool switching. Escape is the way out
      // and is handled below, so nothing else here should fire while the player is walking.
      if (editor.walking) {
        if (event.key === 'Escape') editor.setWalking(false);
        return;
      }

      switch (event.key) {
        case 'p':
          editor.setPlaying(!editor.playing);
          break;
        case 'P':
          // Shift+P is the fuller preview: physics, behaviours and a body to walk around in.
          if (event.shiftKey) editor.setWalking(true);
          else editor.setPlaying(!editor.playing);
          break;
        case '1':
          editor.setTool('select');
          break;
        case '2':
          editor.setTool('sculpt');
          break;
        case '3':
          editor.setTool('paint');
          break;
        case 'w':
        case 'W':
          editor.setGizmoMode('translate');
          break;
        case 'e':
        case 'E':
          editor.setGizmoMode('rotate');
          break;
        case 'r':
        case 'R':
          editor.setGizmoMode('scale');
          break;
        case 'Delete':
        case 'Backspace': {
          if (selected.length === 0) return;
          event.preventDefault();
          if (
            selected.length >= BULK_DELETE_THRESHOLD &&
            !ask(`Delete ${selected.length} objects?`)
          ) {
            return;
          }
          scene.removeObjects(selected);
          break;
        }
        case 'Escape':
          if (editor.shortcutsOpen) editor.setShortcutsOpen(false);
          else scene.clearSelection();
          break;
        case '?':
          editor.setShortcutsOpen(!editor.shortcutsOpen);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [confirmDelete]);
}
