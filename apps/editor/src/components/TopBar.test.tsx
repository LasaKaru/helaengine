import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SceneObjectSchema } from '@helaengine/schema';
import { createEmptyScene, useSceneStore } from '../store/sceneStore';
import { TopBar } from './TopBar';

describe('TopBar', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene('Test Scene'), selectedIds: [] });
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

  it('disables actions whose sprints have not landed', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });
});
