import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseAssetManifest } from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { createEmptyScene, useSceneStore } from '../store/sceneStore';
import { GraphEditor } from './GraphEditor';

/**
 * The canvas, driven the way a user drives it.
 *
 * These go through the rendered controls rather than calling store actions, because the interesting
 * claims are about the *interaction*: that wiring takes two clicks and produces a legal edge, that
 * the problems list is live rather than computed on save, and that deleting a node takes its wires
 * with it. None of those can be checked by inspecting the store's reducers.
 */

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'tree_pine_01', name: 'Pine Tree', category: 'trees', tags: [] },
    { id: 'logic_trigger_box', name: 'Trigger', category: 'logic', tags: [] },
  ],
});

function open(): ReturnType<typeof userEvent.setup> {
  useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
  useEditorStore.setState({ graphOpen: true });
  const user = userEvent.setup();
  render(<GraphEditor manifest={manifest} />);
  return user;
}

const graph = (): ReturnType<typeof useSceneStore.getState>['scene']['graph'] =>
  useSceneStore.getState().scene.graph;

describe('GraphEditor', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
    useEditorStore.setState({ graphOpen: false });
  });

  it('renders nothing while closed', () => {
    useEditorStore.setState({ graphOpen: false });
    render(<GraphEditor manifest={manifest} />);
    expect(screen.queryByRole('dialog', { name: 'Node graph' })).toBeNull();
  });

  it('adds a node from the palette and puts it on the canvas', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'On start' }));

    expect(graph().nodes).toEqual([{ id: 'onStart1', type: 'onStart' }]);
    // Given a position, not left at the origin under the palette where it cannot be seen.
    expect(graph().layout.onStart1).toBeDefined();
    expect(screen.getByRole('button', { name: 'On start onStart1' })).toBeInTheDocument();
  });

  it('wires two nodes with two clicks', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'On start' }));
    await user.click(screen.getByRole('button', { name: 'Show message' }));

    await user.click(screen.getByRole('button', { name: 'onStart1 output then' }));
    await user.click(screen.getByRole('button', { name: 'Show message showMessage1' }));

    expect(graph().edges).toEqual([{ from: 'onStart1', port: 'then', to: 'showMessage1' }]);
  });

  it('does not wire a node to itself', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Show message' }));
    await user.click(screen.getByRole('button', { name: 'showMessage1 output then' }));
    await user.click(screen.getByRole('button', { name: 'Show message showMessage1' }));

    // An instant self-loop would be caught by validation, but offering it at all is a canvas that
    // lets you draw a hang and then tells you off for it.
    expect(graph().edges).toEqual([]);
  });

  it('gives a branch both of its ports and nothing else', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Branch' }));

    expect(screen.getByRole('button', { name: 'branch1 output true' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'branch1 output false' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'branch1 output then' })).toBeNull();
  });

  it('shows a problem as it is created, not on save', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Destroy object' }));

    // A fresh project has no objects, so the target is blank — and the canvas says so immediately.
    const problems = screen.getByRole('region', { name: 'Graph problems' });
    expect(problems).toHaveTextContent('no target object chosen');
  });

  it('takes the wires with the node when it is deleted', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'On start' }));
    await user.click(screen.getByRole('button', { name: 'Wait' }));
    await user.click(screen.getByRole('button', { name: 'onStart1 output then' }));
    await user.click(screen.getByRole('button', { name: 'Wait wait1' }));
    expect(graph().edges).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Wait wait1' }));
    await user.click(screen.getByRole('button', { name: 'Delete node' }));

    expect(graph().nodes).toHaveLength(1);
    // Left behind, these would be a validation error the author never made.
    expect(graph().edges).toEqual([]);
    expect(graph().layout.wait1).toBeUndefined();
  });

  it('keeps a variable’s starting value in step with its type', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    expect(graph().variables[0]).toEqual({ name: 'variable1', type: 'number', initial: 0 });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Variable 1 type' }), 'boolean');

    // Not `initial: 0` with `type: 'boolean'` — that document fails its own schema on save, and it
    // is the mistake a naive patch makes.
    expect(graph().variables[0]).toEqual({ name: 'variable1', type: 'boolean', initial: false });
  });

  it('disconnects a wire from the inspector', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'On start' }));
    await user.click(screen.getByRole('button', { name: 'Wait' }));
    await user.click(screen.getByRole('button', { name: 'onStart1 output then' }));
    await user.click(screen.getByRole('button', { name: 'Wait wait1' }));

    await user.click(screen.getByRole('button', { name: 'On start onStart1' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect then to wait1' }));

    expect(graph().edges).toEqual([]);
    expect(graph().nodes).toHaveLength(2);
  });

  it('offers only spawnable assets, not the logic volumes', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Spawn object' }));

    const options = screen
      .getAllByRole('option')
      .map((option) => option.textContent)
      .filter(Boolean);
    expect(options).toContain('Pine Tree');
    expect(options).not.toContain('Trigger');
  });
});
