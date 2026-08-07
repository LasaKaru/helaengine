import { useCallback, useMemo, useRef, useState } from 'react';
import {
  EVENT_NODES,
  outputsOf,
  validateGraph,
  type AssetManifest,
  type GraphNode,
  type GraphVariable,
  type VariableType,
} from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import {
  NODE_GROUPS,
  NODE_LABELS,
  describeNode,
  newNode,
  nextNodeId,
  nodeFamily,
} from '../graph/nodes';
import { GraphNodeFields } from './GraphNodeFields';

/**
 * The visual scripting canvas.
 *
 * A node graph is the one feature here that is genuinely a *language*, and the thing that makes it
 * safe is that the author never types one. Every node comes from the palette, every wire is checked
 * against `NODE_OUTPUTS`, and the problems list below the canvas is `validateGraph` run on each
 * keystroke — so a graph that cannot run says so while it is being drawn rather than when it is
 * played. Instant loops in particular are named here, on the canvas, by the ids of the nodes in
 * them.
 *
 * Wiring is click-then-click rather than drag-a-wire. A drag interaction on top of a drag-to-move
 * canvas means two gestures competing for the same pointer, and the click version is the one that
 * works with a keyboard: both ends are buttons.
 */

const NODE_WIDTH = 200;
const HEADER_HEIGHT = 46;
const PORT_SPACING = 24;
const CANVAS_WIDTH = 2400;
const CANVAS_HEIGHT = 1600;

/** Where a node's output port sits, in canvas coordinates. */
function portPoint(at: [number, number], index: number): [number, number] {
  return [at[0] + NODE_WIDTH, at[1] + HEADER_HEIGHT + index * PORT_SPACING + PORT_SPACING / 2];
}

/** Where a wire lands: the left edge of the target's header. */
function inputPoint(at: [number, number]): [number, number] {
  return [at[0], at[1] + HEADER_HEIGHT / 2];
}

/** A cubic with horizontal tangents, so wires leave and arrive flat and stay readable when crossed. */
function wirePath(from: [number, number], to: [number, number]): string {
  const reach = Math.max(40, Math.abs(to[0] - from[0]) * 0.5);
  return `M ${from[0]} ${from[1]} C ${from[0] + reach} ${from[1]}, ${to[0] - reach} ${to[1]}, ${to[0]} ${to[1]}`;
}

interface GraphEditorProps {
  manifest: AssetManifest;
  /**
   * The other levels in this game, for `loadLevel` to point at.
   *
   * Passed in rather than read from a store, because the graph canvas edits *one* level and the
   * level set is the project's business. Empty for a one-level game, which is what every project
   * built before levels existed is.
   */
  levels?: ReadonlyArray<{ id: string; name: string }>;
}

export function GraphEditor({ manifest, levels = [] }: GraphEditorProps): React.JSX.Element | null {
  const open = useEditorStore((state) => state.graphOpen);
  const setOpen = useEditorStore((state) => state.setGraphOpen);

  const graph = useSceneStore((state) => state.scene.graph);
  const objects = useSceneStore((state) => state.scene.objects);
  const addGraphNode = useSceneStore((state) => state.addGraphNode);
  const updateGraphNode = useSceneStore((state) => state.updateGraphNode);
  const removeGraphNode = useSceneStore((state) => state.removeGraphNode);
  const moveGraphNode = useSceneStore((state) => state.moveGraphNode);
  const connectGraph = useSceneStore((state) => state.connectGraph);
  const disconnectGraph = useSceneStore((state) => state.disconnectGraph);
  const setGraphVariables = useSceneStore((state) => state.setGraphVariables);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The output port waiting for a target, if wiring is in progress. */
  const [armed, setArmed] = useState<{ from: string; port: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const problems = useMemo(() => validateGraph(graph), [graph]);
  const objectIds = useMemo(() => objects.map((object) => object.id), [objects]);
  const spawnable = useMemo(
    () => manifest.assets.filter((asset) => asset.category !== 'logic'),
    [manifest],
  );

  /** Which nodes a problem points at, so the canvas can mark them. */
  const flagged = useMemo(() => {
    const marks = new Map<string, 'error' | 'warning'>();
    for (const problem of problems) {
      for (const id of problem.nodeIds) {
        if (problem.severity === 'error' || !marks.has(id)) marks.set(id, problem.severity);
      }
    }
    return marks;
  }, [problems]);

  const at = useCallback(
    (nodeId: string): [number, number] => graph.layout[nodeId] ?? [40, 40],
    [graph.layout],
  );

  const onPointerMove = (event: React.PointerEvent): void => {
    const held = drag.current;
    const canvas = canvasRef.current;
    if (!held || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    moveGraphNode(held.id, [
      Math.max(0, Math.round(event.clientX - bounds.left - held.offsetX)),
      Math.max(0, Math.round(event.clientY - bounds.top - held.offsetY)),
    ]);
  };

  const addNode = (type: Parameters<typeof newNode>[0]): void => {
    const id = nextNodeId(graph, type);
    // Laid out on a grid wider and taller than a node, so a run of additions never buries an
    // earlier node's ports. A small diagonal cascade looks tidier and is unusable: the ports sit on
    // the right edge, and anything dropped on top of them takes the clicks meant for wiring.
    const index = graph.nodes.length;
    const column = index % 4;
    const row = Math.floor(index / 4);
    addGraphNode(
      newNode(type, id, {
        assetId: spawnable[0]?.id,
        objectId: objectIds[0],
        variableName: graph.variables[0]?.name,
        levelId: levels[0]?.id,
      }),
      [60 + column * (NODE_WIDTH + 80), 60 + row * 160],
    );
    setSelectedId(id);
  };

  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;
  const outgoing = graph.edges.filter((edge) => edge.from === selectedId);

  const updateVariable = (index: number, patch: Partial<GraphVariable>): void =>
    setGraphVariables(
      graph.variables.map((variable, at) => (at === index ? { ...variable, ...patch } : variable)),
    );

  if (!open) return null;

  return (
    <div className="graph-editor" role="dialog" aria-modal="true" aria-label="Node graph">
      <header className="graph-editor-bar">
        <h2>Node graph</h2>
        <span className="graph-status">
          {graph.nodes.length} nodes · {graph.edges.length} connections
        </span>
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>

      <div className="graph-editor-body">
        <aside className="graph-palette" aria-label="Add node">
          {NODE_GROUPS.map((group) => (
            <div key={group.label}>
              <h3>{group.label}</h3>
              {group.types.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`graph-add ${nodeFamily(type)}`}
                  onClick={() => addNode(type)}
                >
                  {NODE_LABELS[type]}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div
          className="graph-canvas-scroll"
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <div
            className="graph-canvas"
            ref={canvasRef}
            style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
            onClick={() => setArmed(null)}
          >
            <svg className="graph-wires" width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
              {graph.edges.map((edge, index) => {
                const source = graph.nodes.find((node) => node.id === edge.from);
                const target = graph.nodes.find((node) => node.id === edge.to);
                if (!source || !target) return null;
                const port = outputsOf(source).indexOf(edge.port);
                if (port === -1) return null;
                return (
                  <path
                    key={`${edge.from}-${edge.port}-${edge.to}-${index}`}
                    className={edge.port === 'false' ? 'wire false' : 'wire'}
                    d={wirePath(portPoint(at(edge.from), port), inputPoint(at(edge.to)))}
                  />
                );
              })}
            </svg>

            {graph.nodes.map((node) => {
              const [x, y] = at(node.id);
              const ports = outputsOf(node);
              const mark = flagged.get(node.id);
              return (
                <div
                  key={node.id}
                  className={[
                    'graph-node',
                    nodeFamily(node.type),
                    selectedId === node.id ? 'selected' : '',
                    mark ?? '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    left: x,
                    top: y,
                    width: NODE_WIDTH,
                    height: HEADER_HEIGHT + ports.length * PORT_SPACING + 8,
                    // The one being worked on comes to the front, so its ports stay clickable after
                    // it has been dragged under a neighbour.
                    zIndex: selectedId === node.id ? 2 : 1,
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="graph-node-head"
                    aria-label={`${NODE_LABELS[node.type]} ${node.id}`}
                    aria-pressed={selectedId === node.id}
                    onPointerDown={(event) => {
                      // Wiring wins over dragging: while a port is armed, a click on a node is the
                      // author saying "here", not the start of a move.
                      if (armed) return;
                      drag.current = {
                        id: node.id,
                        offsetX: event.clientX - event.currentTarget.getBoundingClientRect().left,
                        offsetY: event.clientY - event.currentTarget.getBoundingClientRect().top,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setSelectedId(node.id);
                    }}
                    onClick={() => {
                      if (!armed) return;
                      if (armed.from !== node.id) connectGraph(armed.from, armed.port, node.id);
                      setArmed(null);
                    }}
                  >
                    <span className="graph-node-type">{NODE_LABELS[node.type]}</span>
                    <span className="graph-node-detail">{describeNode(node)}</span>
                  </button>

                  {ports.map((port, index) => (
                    <button
                      key={port}
                      type="button"
                      className={
                        armed?.from === node.id && armed.port === port
                          ? 'graph-port armed'
                          : 'graph-port'
                      }
                      style={{ top: HEADER_HEIGHT + index * PORT_SPACING }}
                      aria-label={`${node.id} output ${port}`}
                      aria-pressed={armed?.from === node.id && armed.port === port}
                      onClick={() =>
                        setArmed((current) =>
                          current?.from === node.id && current.port === port
                            ? null
                            : { from: node.id, port },
                        )
                      }
                    >
                      {port}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <aside className="graph-inspector" aria-label="Graph inspector">
          <section>
            <h3>Variables</h3>
            {graph.variables.length === 0 && <p className="panel-hint">None yet.</p>}
            {graph.variables.map((variable, index) => (
              <div className="graph-variable" key={index}>
                <label className="param-row">
                  <span>Name</span>
                  <input
                    type="text"
                    aria-label={`Variable ${index + 1} name`}
                    spellCheck={false}
                    value={variable.name}
                    onChange={(event) => updateVariable(index, { name: event.target.value })}
                  />
                </label>
                <label className="param-row">
                  <span>Type</span>
                  <select
                    aria-label={`Variable ${index + 1} type`}
                    value={variable.type}
                    onChange={(event) => {
                      // The initial value has to change with the type, or a `number` variable keeps
                      // a string initial and the document fails its own schema on save.
                      const type = event.target.value as VariableType;
                      const initial = type === 'number' ? 0 : type === 'boolean' ? false : '';
                      updateVariable(index, { type, initial });
                    }}
                  >
                    <option value="number">Number</option>
                    <option value="boolean">True / false</option>
                    <option value="text">Text</option>
                  </select>
                </label>
                <label className="param-row">
                  <span>Starts at</span>
                  {variable.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      aria-label={`Variable ${index + 1} initial`}
                      checked={variable.initial === true}
                      onChange={(event) => updateVariable(index, { initial: event.target.checked })}
                    />
                  ) : (
                    <input
                      type={variable.type === 'number' ? 'number' : 'text'}
                      aria-label={`Variable ${index + 1} initial`}
                      value={String(variable.initial)}
                      onChange={(event) =>
                        updateVariable(index, {
                          initial:
                            variable.type === 'number'
                              ? Number(event.target.value) || 0
                              : event.target.value,
                        })
                      }
                    />
                  )}
                </label>
                <button
                  type="button"
                  aria-label={`Remove variable ${index + 1}`}
                  onClick={() =>
                    setGraphVariables(graph.variables.filter((_x, at) => at !== index))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setGraphVariables([
                  ...graph.variables,
                  { name: `variable${graph.variables.length + 1}`, type: 'number', initial: 0 },
                ])
              }
            >
              Add variable
            </button>
          </section>

          <section>
            <h3>Node</h3>
            {!selected && <p className="panel-hint">Pick a node on the canvas.</p>}
            {selected && (
              <>
                <p className="graph-selected-id">{selected.id}</p>
                <GraphNodeFields
                  node={selected}
                  context={{ variables: graph.variables, objectIds, assets: spawnable, levels }}
                  onChange={(next: GraphNode) => updateGraphNode(next)}
                />

                {outgoing.length > 0 && (
                  <div className="graph-connections">
                    <h4>Connections</h4>
                    {outgoing.map((edge, index) => (
                      <div className="graph-connection" key={`${edge.port}-${edge.to}-${index}`}>
                        <span>
                          {edge.port} → {edge.to}
                        </span>
                        <button
                          type="button"
                          aria-label={`Disconnect ${edge.port} to ${edge.to}`}
                          onClick={() => disconnectGraph(edge.from, edge.port, edge.to)}
                        >
                          Disconnect
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    removeGraphNode(selected.id);
                    setSelectedId(null);
                  }}
                >
                  Delete node
                </button>
              </>
            )}
          </section>

          <section aria-label="Graph problems">
            <h3>Problems</h3>
            {problems.length === 0 && (
              <p className="panel-hint">
                {graph.nodes.some((node) => EVENT_NODES.includes(node.type))
                  ? 'Ready to run.'
                  : 'Add a “When…” node to give the graph a starting point.'}
              </p>
            )}
            <ul className="graph-problems">
              {problems.map((problem, index) => (
                <li key={index} className={problem.severity}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(problem.nodeIds[0] ?? null)}
                    disabled={problem.nodeIds.length === 0}
                  >
                    {problem.message}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
