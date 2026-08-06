import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectsScreen } from './ProjectsScreen';
import { useProjectStore } from '../store/projectStore';
import { listProjects } from '../storage/backend';
import type * as Backend from '../storage/backend';

// Only the one call is replaced. The action under test is the real one from the store, so this
// checks its error handling rather than a re-implementation of it.
vi.mock('../storage/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof Backend>()),
  listProjects: vi.fn(async () => []),
}));

/**
 * Sprint 37 — the three states of a list, which are not two.
 *
 * `projects: []` used to mean both "you have none" and "we have not looked yet", and the screen
 * could not tell them apart. A signed-in user with a dozen projects was shown *"Nothing saved yet.
 * Pick a template above"* for the length of the fetch — the product telling somebody their work is
 * gone, on the first screen they see after signing in.
 *
 * These assert on what a user reads rather than on which branch rendered, because the bug was never
 * a missing branch: it was a true-sounding sentence attached to the wrong state.
 */

/** A partial state patch. Zustand accepts one at runtime; the typed overload wants the whole state. */
function setState(patch: Partial<ReturnType<typeof useProjectStore.getState>>): void {
  useProjectStore.setState(patch as ReturnType<typeof useProjectStore.getState>);
}

/**
 * The store's real action, captured before any test replaces it.
 *
 * The retry test swaps `refreshProjects` for a spy to prove the button calls it, and without this
 * the swap leaks: the next test asks the store to refresh and gets the previous test's stub, which
 * resolves happily and asserts nothing. That is exactly how it failed the first time it was run.
 */
const realRefresh = useProjectStore.getState().refreshProjects;

afterEach(() => {
  setState({
    projects: [],
    projectsStatus: 'ready',
    projectsError: null,
    refreshProjects: realRefresh,
  });
  vi.mocked(listProjects).mockClear();
});

describe('the projects list', () => {
  it('says it is loading rather than that nothing is saved', () => {
    setState({ projects: [], projectsStatus: 'loading', projectsError: null });
    render(<ProjectsScreen />);

    expect(screen.getByText(/Loading your projects/i)).toBeInTheDocument();
    // The exact sentence that was the bug. Its absence is the whole point of the change.
    expect(screen.queryByText(/Nothing saved yet/i)).not.toBeInTheDocument();
  });

  it('still says nothing is saved when the list really is empty', () => {
    setState({ projects: [], projectsStatus: 'ready', projectsError: null });
    render(<ProjectsScreen />);

    // The original message was right for the original case, and a fix that lost it would have
    // traded a wrong answer for no answer.
    expect(screen.getByText(/Nothing saved yet/i)).toBeInTheDocument();
  });

  it('offers a retry when the list could not be loaded', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    setState({
      projects: [],
      projectsStatus: 'error',
      projectsError: 'Could not reach the API.',
      refreshProjects: refresh,
    });
    render(<ProjectsScreen />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Could not reach the API/);
    expect(screen.queryByText(/Nothing saved yet/i)).not.toBeInTheDocument();

    // A retry rather than only a sentence: a list that fails to load is usually a network blip, and
    // the alternative is telling somebody to reload and lose whatever else they were doing.
    await userEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(refresh).toHaveBeenCalled();
  });
});

describe('refreshing the list', () => {
  it('records a failure instead of leaving an empty list and an unhandled rejection', async () => {
    // Every caller of `refreshProjects` is a fire-and-forget refresh after some other action
    // succeeded. Throwing would produce an unhandled rejection *and* an empty list — the same
    // silent wrong answer, arrived at a different way. So the action swallows and records.
    vi.mocked(listProjects).mockRejectedValueOnce(new Error('the network is down'));

    await expect(useProjectStore.getState().refreshProjects()).resolves.toBeUndefined();

    expect(useProjectStore.getState().projectsStatus).toBe('error');
    expect(useProjectStore.getState().projectsError).toContain('the network is down');
  });

  it('reaches ready with the rows it was given', async () => {
    vi.mocked(listProjects).mockResolvedValueOnce([
      { id: 'p1', name: 'A Level', updatedAt: new Date().toISOString() },
    ] as never);

    await useProjectStore.getState().refreshProjects();

    expect(useProjectStore.getState().projectsStatus).toBe('ready');
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });
});
