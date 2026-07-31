import type { AssetCategory } from '@helaengine/schema';

/**
 * Triangle budgets from `docs/ASSET-CONVENTIONS.md`. Exceeding a budget warns; exceeding twice the
 * budget fails ingest, so nobody quietly ships a 40k-triangle "rock" into the library.
 */
export const polyBudgets: Record<AssetCategory, number> = {
  props: 2000,
  rocks: 500,
  trees: 2000,
  enemies: 4000,
  buildings: 8000,
  terrain: 8000,
  // Logic assets are trigger volumes: the engine draws them as an outline and the pipeline never
  // ingests one, so any triangle count at all means somebody has miscategorised a model.
  logic: 0,
  // Nor does an audio asset have geometry. Same reasoning: a triangle here means a miscategorised
  // file, and the pipeline should say so rather than ingest a model as a sound.
  audio: 0,
};

export const HARD_LIMIT_MULTIPLIER = 2;

export type BudgetVerdict = { level: 'ok' | 'warn' | 'fail'; budget: number };

export function checkPolyBudget(category: AssetCategory, polyCount: number): BudgetVerdict {
  const budget = polyBudgets[category];
  if (polyCount > budget * HARD_LIMIT_MULTIPLIER) return { level: 'fail', budget };
  if (polyCount > budget) return { level: 'warn', budget };
  return { level: 'ok', budget };
}
