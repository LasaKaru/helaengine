import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SceneObjectSchema } from '@helaengine/schema';
import { useProjectStore } from '../store/projectStore';
import { createEmptyScene, useSceneStore } from '../store/sceneStore';
import { TopBar } from './TopBar';

describe('TopBar', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene('Test Scene'), selectedIds: [] });
    useProjectStore.setState({ dirty: false, saveState: { status: 'idle' } });
  });

  it('shows the project name from the store', () => {
    render(<TopBar />);
    expect(screen.getByLabelText('Project name')).toHaveValue('Test Scene');
  });

  it('writes name edits back to the document', async () => {
    const user = userEvent.setup();
    render(<TopBar />);

    await user.clear(screen.getByLabelText('Project name'));
    await user.type(screen.getByLabelText('Project name'), 'Village');

    expect(useSceneStore.getState().scene.name).toBe('Village');
  });

  it('reflects object count changes from the store', () => {
    render(<TopBar />);
    expect(screen.getByText('0 objects')).toBeInTheDocument();

    // Wrapped in `act` because the mutation originates outside React — the store is the source of
    // truth, and this is exactly how a viewport drag or a dev-console call will reach the UI.
    act(() => {
      useSceneStore
        .getState()
        .addObject(SceneObjectSchema.parse({ id: 'obj_0001', assetId: 'tree_pine_01' }));
    });

    expect(screen.getByText('1 objects')).toBeInTheDocument();
  });

  it('offers save, and still disables actions whose sprints have not landed', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('reports unsaved changes', () => {
    useProjectStore.setState({ dirty: true, saveState: { status: 'idle' } });
    render(<TopBar />);
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
  });

  it('reports a failed save rather than staying silent', () => {
    useProjectStore.setState({
      dirty: false,
      saveState: { status: 'error', message: 'disk full' },
    });
    render(<TopBar />);
    expect(screen.getByRole('status')).toHaveTextContent('Save failed');
  });
});
