import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseAssetManifest } from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { DEFAULT_PLACEMENT } from '../placement';
import { AssetLibraryPanel } from './AssetLibraryPanel';

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'tree_pine_01', name: 'Pine Tree', category: 'trees', tags: ['conifer'] },
    { id: 'tree_oak_01', name: 'Oak Tree', category: 'trees', tags: ['broadleaf'] },
    { id: 'rock_boulder_01', name: 'Boulder', category: 'rocks', tags: ['stone'] },
    { id: 'building_hut_01', name: 'Thatched Hut', category: 'buildings', tags: ['village'] },
  ],
});

describe('AssetLibraryPanel', () => {
  beforeEach(() => {
    useEditorStore.setState({
      drag: null,
      placement: DEFAULT_PLACEMENT,
      assetSearch: '',
      assetCategory: null,
    });
  });

  it('reports the full library when nothing is filtered', () => {
    render(<AssetLibraryPanel manifest={manifest} />);
    expect(screen.getByText(/4 of 4/)).toBeInTheDocument();
  });

  it('offers a tab per category with counts', () => {
    render(<AssetLibraryPanel manifest={manifest} />);
    expect(screen.getByRole('button', { name: /trees 2/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rocks 1/i })).toBeInTheDocument();
  });

  it('filters by category', async () => {
    const user = userEvent.setup();
    render(<AssetLibraryPanel manifest={manifest} />);

    await user.click(screen.getByRole('button', { name: /rocks 1/i }));

    expect(useEditorStore.getState().assetCategory).toBe('rocks');
    expect(screen.getByText(/1 of 4/)).toBeInTheDocument();
  });

  it('searches across name, id and tags', async () => {
    const user = userEvent.setup();
    render(<AssetLibraryPanel manifest={manifest} />);
    const search = screen.getByLabelText('Search assets');

    await user.type(search, 'broadleaf');
    expect(screen.getByText(/1 of 4/)).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'hut_01');
    expect(screen.getByText(/1 of 4/)).toBeInTheDocument();
  });

  it('says so when a search matches nothing', async () => {
    const user = userEvent.setup();
    render(<AssetLibraryPanel manifest={manifest} />);

    await user.type(screen.getByLabelText('Search assets'), 'spaceship');

    expect(screen.getByText(/No assets match/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 4/)).toBeInTheDocument();
  });

  it('combines a category filter with a search', async () => {
    const user = userEvent.setup();
    render(<AssetLibraryPanel manifest={manifest} />);

    await user.click(screen.getByRole('button', { name: /trees 2/i }));
    await user.type(screen.getByLabelText('Search assets'), 'oak');

    expect(screen.getByText(/1 of 4/)).toBeInTheDocument();
  });
  it('leaves audio out of the library entirely, counts included', () => {
    // Audio shares the manifest — one answer to "what assets does this project have" — but a sound
    // is not something you drag onto the terrain, and a count that includes it is a count nobody
    // can reconcile with what they see.
    render(
      <AssetLibraryPanel
        manifest={parseAssetManifest({
          version: 1,
          assets: [
            { id: 'prop_crate_01', name: 'Crate', category: 'props' },
            { id: 'audio_music_menu', name: 'Menu music', category: 'audio' },
            { id: 'audio_sfx_pickup', name: 'Pickup', category: 'audio' },
          ],
        })}
      />,
    );

    expect(screen.queryByText('Menu music')).toBeNull();
    expect(screen.getByRole('button', { name: /^All/ })).toHaveTextContent('1');
    expect(screen.getByText(/drag onto the terrain/)).toHaveTextContent('1 of 1');
  });
});
