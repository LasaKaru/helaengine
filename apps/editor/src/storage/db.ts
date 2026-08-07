import Dexie, { type Table } from 'dexie';

/**
 * A project as it sits on disk.
 *
 * `sceneJson` is stored as a string rather than a structured object on purpose: IndexedDB would
 * happily hold the object, but round-tripping through JSON is exactly what the cloud API will do
 * in Sprint 29, and a document that survives one survives the other. It also means the stored form
 * is inert data that no amount of prototype trickery can smuggle behaviour into.
 */
export interface StoredProject {
  id: string;
  name: string;
  /** Data URL of a viewport screenshot taken at save time. Absent until the first save. */
  thumbnail?: string;
  sceneJson: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * An image or video the author uploaded for the game's UI.
 *
 * Held as a `Blob` in the browser until there is somewhere to put it (Sprint 30's asset storage).
 * That is not a stopgap so much as the same local-first bet the rest of the editor makes: a home
 * screen background should work before anyone has signed in.
 */
export interface StoredUiAsset {
  id: string;
  name: string;
  kind: 'image' | 'video';
  mimeType: string;
  bytes: number;
  data: Blob;
  createdAt: number;
}

/**
 * A model the author imported from their own disk.
 *
 * Held here rather than only in memory, and that is the whole point of the table. Models imported
 * from a `.hela` file live as blob URLs that die with the tab, so reopening a project showed
 * placeholders until the models were uploaded to an account. Somebody building a game on their own
 * machine should not need an account to keep their own art, so this is the local half of the asset
 * library: the same shape a cloud asset has, stored where the projects are stored.
 *
 * Everything measurable is measured once, at import, and kept — `polyCount`, `bounds`, the
 * animation clip names and whether the model is skinned. The editor needs all four before the model
 * is loaded (the inspector's animation dropdowns, the placeholder box, the batching decision), and
 * re-deriving them would mean decoding every model on every page load.
 */
export interface StoredLocalAsset {
  /** `local_<slug>`, derived from the filename so re-importing replaces rather than duplicates. */
  id: string;
  name: string;
  category: string;
  mimeType: string;
  bytes: number;
  data: Blob;
  polyCount: number;
  bounds: [number, number, number];
  animations: string[];
  skinned: boolean;
  /**
   * Attribution, as the author typed it.
   *
   * Optional, because a model somebody made themselves has nobody to credit. Carried into the
   * manifest so an export's CREDITS file says where a custom asset came from — the same guarantee
   * the shipped library gives, extended to the assets that are most likely to have a licence
   * somebody needs to honour.
   */
  license?: string;
  author?: string;
  sourceUrl?: string;
  createdAt: number;
}

export class HelaEngineDatabase extends Dexie {
  projects!: Table<StoredProject, string>;
  uiAssets!: Table<StoredUiAsset, string>;
  localAssets!: Table<StoredLocalAsset, string>;

  constructor(name = 'helaengine') {
    super(name);
    // `updatedAt` is indexed so the projects list can sort by recency without loading every scene.
    this.version(1).stores({ projects: 'id, updatedAt, name' });
    // Dexie migrates in place: an existing database gains the new table without losing projects.
    this.version(2).stores({ projects: 'id, updatedAt, name', uiAssets: 'id, createdAt, kind' });
    this.version(3).stores({
      projects: 'id, updatedAt, name',
      uiAssets: 'id, createdAt, kind',
      localAssets: 'id, createdAt, category',
    });
  }
}

export const db = new HelaEngineDatabase();
