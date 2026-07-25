import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SceneObjectSchema } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from './store/sceneStore';
import { useEditorStore } from './store/editorStore';
import { BULK_DELETE_THRESHOLD, useShortcuts } from './useShortcuts';

function seed(count: number): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `obj_${String(index).padStart(4, '0')}`;
    useSceneStore.getState().addObject(SceneObjectSchema.parse({ id, assetId: 'tree_pine_01' }));
    ids.push(id);
  }
  return ids;
}

function press(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

describe('useShortcuts', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
    useEditorStore.setState({ gizmoMode: 'translate', shortcutsOpen: false });
  });

  it('switches gizmo mode with W / E / R', () => {
    renderHook(() => useShortcuts());

    press('e');
    expect(useEditorStore.getState().gizmoMode).toBe('rotate');
    press('r');
    expect(useEditorStore.getState().gizmoMode).toBe('scale');
    press('w');
    expect(useEditorStore.getState().gizmoMode).toBe('translate');
  });

  it('deletes the selection without asking below the bulk threshold', () => {
    const confirm = vi.fn(() => true);
    renderHook(() => useShortcuts({ confirm }));

    const ids = seed(2);
    useSceneStore.getState().select(ids);
    press('Delete');

    expect(confirm).not.toHaveBeenCalled();
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);
  });

  it('asks before deleting a large selection', () => {
    const confirm = vi.fn(() => true);
    renderHook(() => useShortcuts({ confirm }));

    const ids = seed(BULK_DELETE_THRESHOLD);
    useSceneStore.getState().select(ids);
    press('Delete');

    expect(confirm).toHaveBeenCalledWith(`Delete ${BULK_DELETE_THRESHOLD} objects?`);
    expect(useSceneStore.getState().scene.objects).toHaveLength(0);
  });

  it('keeps the objects when a bulk delete is declined', () => {
    renderHook(() => useShortcuts({ confirm: () => false }));

    const ids = seed(BULK_DELETE_THRESHOLD + 1);
    useSceneStore.getState().select(ids);
    press('Delete');

    expect(useSceneStore.getState().scene.objects).toHaveLength(BULK_DELETE_THRESHOLD + 1);
  });

  it('duplicates with Ctrl+D and selects the copies', () => {
    renderHook(() => useShortcuts());

    const ids = seed(1);
    useSceneStore.getState().select(ids);
    press('d', { ctrlKey: true });

    const state = useSceneStore.getState();
    expect(state.scene.objects).toHaveLength(2);
    expect(state.selectedIds).toEqual(['obj_0002']);
  });

  it('selects everything with Ctrl+A', () => {
    renderHook(() => useShortcuts());
    const ids = seed(3);

    press('a', { metaKey: true });

    expect(useSceneStore.getState().selectedIds).toEqual(ids);
  });

  it('clears the selection with Escape', () => {
    renderHook(() => useShortcuts());
    useSceneStore.getState().select(seed(1));

    press('Escape');

    expect(useSceneStore.getState().selectedIds).toEqual([]);
  });

  it('closes the shortcuts modal with Escape before touching the selection', () => {
    renderHook(() => useShortcuts());
    const ids = seed(1);
    useSceneStore.getState().select(ids);
    useEditorStore.getState().setShortcutsOpen(true);

    press('Escape');

    expect(useEditorStore.getState().shortcutsOpen).toBe(false);
    expect(useSceneStore.getState().selectedIds).toEqual(ids);
  });

  it('stays out of the way while the user is typing', () => {
    renderHook(() => useShortcuts());
    const ids = seed(1);
    useSceneStore.getState().select(ids);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

    expect(useSceneStore.getState().scene.objects).toHaveLength(1);
    expect(useEditorStore.getState().gizmoMode).toBe('translate');
    input.remove();
  });
});
