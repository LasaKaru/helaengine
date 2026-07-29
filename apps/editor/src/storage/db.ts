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

export class HelaEngineDatabase extends Dexie {
  projects!: Table<StoredProject, string>;
  uiAssets!: Table<StoredUiAsset, string>;

  constructor(name = 'helaengine') {
    super(name);
    // `updatedAt` is indexed so the projects list can sort by recency without loading every scene.
    this.version(1).stores({ projects: 'id, updatedAt, name' });
    // Dexie migrates in place: an existing database gains the new table without losing projects.
    this.version(2).stores({ projects: 'id, updatedAt, name', uiAssets: 'id, createdAt, kind' });
  }
}

export const db = new HelaEngineDatabase();
