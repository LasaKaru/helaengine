import { useMemo, useState } from 'react';
import { buildTree, flattenTree, reparentedTransform } from '../reparent';
import { useSceneStore, wouldCreateCycle } from '../store/sceneStore';

/**
 * The scene graph panel: a hierarchical list of every object, with drag-to-reparent and
 * rename-in-place.
 *
 * Native HTML5 drag-and-drop here, unlike the viewport's pointer-based drags. This is a list of
 * DOM rows, where the browser's drop targets and drag image are exactly right; the viewport avoids
 * HTML5 DnD because it needs pointer coordinates against a 3D raycast, which is a different
 * problem.
 */
export function SceneTree(): React.JSX.Element {
  const scene = useSceneStore((state) => state.scene);
  const selectedIds = useSceneStore((state) => state.selectedIds);
  const select = useSceneStore((state) => state.select);
  const toggleSelected = useSceneStore((state) => state.toggleSelected);
  const setParent = useSceneStore((state) => state.setParent);
  const setLabel = useSceneStore((state) => state.setLabel);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const rows = useMemo(() => flattenTree(buildTree(scene)), [scene]);

  const canDropOn = (targetId: string | null): boolean =>
    dragId !== null && dragId !== targetId && !wouldCreateCycle(scene, dragId, targetId);

  const drop = (targetId: string | null): void => {
    if (dragId === null || !canDropOn(targetId)) return;
    // The new local transform is computed first, so the object keeps its world position instead of
    // jumping by the parent's offset.
    setParent(dragId, targetId, reparentedTransform(scene, dragId, targetId));
    setDragId(null);
    setDropTarget(undefined);
  };

  return (
    <section className="panel panel-tree" aria-label="Scene">
      <h2>Scene</h2>

      {rows.length === 0 ? (
        <p className="panel-hint">This scene is empty.</p>
      ) : (
        <>
          <ul className="tree" role="tree" aria-label="Scene objects">
            {rows.map(({ object, depth }) => {
              const isSelected = selectedIds.includes(object.id);
              const isDropTarget = dropTarget === object.id && canDropOn(object.id);

              return (
                <li key={object.id} role="none">
                  {renamingId === object.id ? (
                    <input
                      className="tree-rename"
                      autoFocus
                      defaultValue={object.metadata.label ?? object.id}
                      aria-label={`Rename ${object.id}`}
                      style={{ paddingLeft: 8 + depth * 14 }}
                      onBlur={(event) => {
                        setLabel(object.id, event.target.value);
                        setRenamingId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  ) : (
                    <div
                      role="treeitem"
                      tabIndex={0}
                      aria-level={depth + 1}
                      aria-selected={isSelected}
                      className={`tree-row${isSelected ? ' selected' : ''}${
                        isDropTarget ? ' drop-target' : ''
                      }`}
                      style={{ paddingLeft: 8 + depth * 14 }}
                      data-object-id={object.id}
                      onDragOver={(event) => {
                        if (!canDropOn(object.id)) return;
                        event.preventDefault();
                        setDropTarget(object.id);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        drop(object.id);
                      }}
                      onClick={(event) => {
                        if (event.shiftKey) toggleSelected(object.id);
                        else select([object.id]);
                      }}
                      onDoubleClick={() => setRenamingId(object.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === 'F2') {
                          event.preventDefault();
                          setRenamingId(object.id);
                        }
                        if (event.key === ' ') {
                          event.preventDefault();
                          select([object.id]);
                        }
                      }}
                    >
                      {/*
                        Only the grip is draggable. Chromium suppresses dblclick on a draggable
                        element, so a whole-row drag handle would cost rename-on-double-click —
                        and a grip is a clearer affordance for reordering anyway.
                      */}
                      <span
                        className="tree-grip"
                        draggable
                        aria-hidden="true"
                        title="Drag to nest"
                        onDragStart={(event) => {
                          setDragId(object.id);
                          event.dataTransfer.effectAllowed = 'move';
                          // Firefox refuses to start a drag without payload on the transfer.
                          event.dataTransfer.setData('text/plain', object.id);
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setDropTarget(undefined);
                        }}
                      >
                        ⠿
                      </span>
                      {depth > 0 && <span className="tree-branch" aria-hidden="true" />}
                      <span className="object-label">{object.metadata.label ?? object.id}</span>
                      <span className="object-asset">{object.assetId}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Dropping below the list unparents — the only way back to the root once nested. */}
          <div
            className={`tree-root-drop${dropTarget === null && canDropOn(null) ? ' drop-target' : ''}`}
            data-testid="tree-root-drop"
            onDragOver={(event) => {
              if (!canDropOn(null)) return;
              event.preventDefault();
              setDropTarget(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              drop(null);
            }}
          >
            Drop here to unparent
          </div>

          <p className="panel-hint tree-hint">
            Drag the grip to nest · double-click or F2 to rename
          </p>
        </>
      )}
    </section>
  );
}
