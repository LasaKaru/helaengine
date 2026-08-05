import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseAssetManifest } from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { DEFAULT_PLACEMENT } from '../placement';
import type { CloudAsset } from '../storage/cloudAssets';
import type { UploadedAssets } from '../storage/useUploadedAssets';
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

/**
 * Sprint 30 — the "My Assets" section.
 *
 * The `uploads` prop is the whole seam: absent means no account, and the section is not rendered at
 * all rather than rendered as a disabled advertisement. Present means it lists what this
 * organisation uploaded, *including* the rows that are still processing and the ones that failed —
 * which is the reason the section exists separately from the grid, since neither has a card.
 */
describe('AssetLibraryPanel — my assets', () => {
  function uploads(overrides: Partial<UploadedAssets> = {}): UploadedAssets {
    return {
      all: [],
      entries: [],
      available: true,
      busy: false,
      error: null,
      upload: async () => {},
      remove: async () => {},
      dismissError: () => {},
      ...overrides,
    };
  }

  function row(overrides: Partial<CloudAsset> & { assetId: string }): CloudAsset {
    return {
      id: `row_${overrides.assetId}`,
      name: overrides.assetId,
      category: 'props',
      status: 'ready',
      failure: null,
      glbPath: `orgs/org_1/assets/abc.glb`,
      thumbnailPath: null,
      polyCount: null,
      sizeBytes: 1024,
      organizationId: 'org_1',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('is absent entirely when no account is behind it', () => {
    render(<AssetLibraryPanel manifest={manifest} uploads={uploads({ available: false })} />);
    expect(screen.queryByRole('region', { name: /my assets/i })).not.toBeInTheDocument();
  });

  it('shows a processing asset and a failed one with its reason', () => {
    render(
      <AssetLibraryPanel
        manifest={manifest}
        uploads={uploads({
          all: [
            row({ assetId: 'still_going', name: 'Statue', status: 'pending', glbPath: null }),
            row({
              assetId: 'broken_one',
              name: 'Not A Model',
              status: 'failed',
              glbPath: null,
              failure: 'that file is not a binary glTF (.glb)',
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText('Processing…')).toBeInTheDocument();
    // The reason sits next to the asset it is about. "Processing failed" with the cause elsewhere
    // is how a fixable file turns into a support ticket.
    expect(screen.getByText(/not a binary glTF/)).toBeInTheDocument();
  });

  it('sends a chosen file to be uploaded, under the selected category', async () => {
    const user = userEvent.setup();
    const sent: Array<{ names: string[]; category: string }> = [];

    render(
      <AssetLibraryPanel
        manifest={manifest}
        uploads={uploads({
          upload: async (files, category) => {
            sent.push({ names: Array.from(files).map((file) => file.name), category });
          },
        })}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/upload category/i), 'rocks');
    await user.upload(
      screen.getByLabelText(/upload a model/i),
      new File([new Uint8Array([1, 2, 3])], 'my_boulder.glb', { type: 'model/gltf-binary' }),
    );

    expect(sent).toEqual([{ names: ['my_boulder.glb'], category: 'rocks' }]);
  });

  it('does not offer audio as an upload category, because you cannot place a sound', () => {
    render(<AssetLibraryPanel manifest={manifest} uploads={uploads()} />);
    const options = Array.from(
      screen.getByLabelText(/upload category/i).querySelectorAll('option'),
    ).map((option) => option.value);

    expect(options).toContain('props');
    expect(options).not.toContain('audio');
  });

  it('shows an upload failure and lets it be dismissed', async () => {
    const user = userEvent.setup();
    let dismissed = false;

    render(
      <AssetLibraryPanel
        manifest={manifest}
        uploads={uploads({
          error: 'That file is larger than 25 MB.',
          dismissError: () => {
            dismissed = true;
          },
        })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('larger than 25 MB');
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(dismissed).toBe(true);
  });

  it('deletes by asset id, not by row id', async () => {
    const user = userEvent.setup();
    const removed: string[] = [];

    render(
      <AssetLibraryPanel
        manifest={manifest}
        uploads={uploads({
          all: [row({ assetId: 'doomed_model', name: 'Doomed' })],
          remove: async (assetId) => {
            removed.push(assetId);
          },
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /delete doomed/i }));
    // The API's delete route is keyed on the asset id — the id that goes into a scene — rather
    // than the database row's uuid, and sending the wrong one deletes nothing and reports success.
    expect(removed).toEqual(['doomed_model']);
  });
});
