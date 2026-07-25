import { describe, expect, it } from 'vitest';
import { checkPolyBudget, polyBudgets } from './budgets.js';
import { readAssetMetadata } from './metadata.js';
import { metadataFile } from './paths.js';

describe('poly budgets', () => {
  it('passes an asset inside its category budget', () => {
    expect(checkPolyBudget('rocks', 400).level).toBe('ok');
  });

  it('warns between the budget and the hard limit', () => {
    expect(checkPolyBudget('rocks', polyBudgets.rocks + 1).level).toBe('warn');
    expect(checkPolyBudget('rocks', polyBudgets.rocks * 2).level).toBe('warn');
  });

  it('fails past twice the budget', () => {
    expect(checkPolyBudget('rocks', polyBudgets.rocks * 2 + 1).level).toBe('fail');
  });

  it('gives buildings a larger allowance than rocks', () => {
    expect(polyBudgets.buildings).toBeGreaterThan(polyBudgets.rocks);
  });
});

describe('asset metadata', () => {
  it('reads declared metadata for a known asset', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    const goblin = metadata.get('enemy_goblin_01');

    expect(goblin).toMatchObject({
      name: 'Goblin',
      category: 'enemies',
      colliderType: 'capsule',
      declared: true,
    });
  });

  it('falls back to a guessed category and readable name for an undeclared asset', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    const guessed = metadata.get('tree_willow_09');

    expect(guessed).toMatchObject({ name: 'Tree Willow 09', category: 'trees', declared: false });
  });

  it('lands unrecognised prefixes in props rather than throwing', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    expect(metadata.get('widget_thing_01').category).toBe('props');
  });

  it('declares every starter asset that ships in raw-assets', async () => {
    const metadata = await readAssetMetadata(metadataFile);
    for (const assetId of [
      'tree_pine_01',
      'tree_pine_02',
      'tree_oak_01',
      'rock_boulder_01',
      'rock_shard_01',
      'building_hut_01',
      'enemy_goblin_01',
      'prop_barrel_01',
      'prop_crate_01',
      'prop_fence_01',
    ]) {
      expect(metadata.get(assetId).declared, `${assetId} should be declared`).toBe(true);
    }
  });
});
