import Dexie, { type Table } from 'dexie';

/**
 * A project as it sits on disk.
 *
 * `sceneJson` is stored as a string rather than a structured object on purpose: IndexedDB would
 * happily hold the object, but round-tripping through JSON is exactly what the cloud API will do
 * in Sprint 17, and a document that survives one survives the other. It also means the stored form
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

export class HelaEngineDatabase extends Dexie {
  projects!: Table<StoredProject, string>;

  constructor(name = 'helaengine') {
    super(name);
    // `updatedAt` is indexed so the projects list can sort by recency without loading every scene.
    this.version(1).stores({ projects: 'id, updatedAt, name' });
  }
}

export const db = new HelaEngineDatabase();
