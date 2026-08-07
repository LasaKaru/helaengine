import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROJECT_VERSION,
  GameProjectSchema,
  asProject,
  danglingLevelLinks,
  levelById,
  parseScene,
  projectFromScene,
  startLevel,
  withLevel,
  type Scene,
} from './index.js';

/**
 * The project document, and mainly the one claim that matters: every file written before levels
 * existed still opens.
 */

function scene(sceneId: string, parts: Partial<Scene> = {}): Scene {
  return parseScene({ sceneId, version: 1, name: sceneId, objects: [], ...parts });
}

function project(levels: Scene[], startLevelId = levels[0]!.sceneId): unknown {
  return { version: CURRENT_PROJECT_VERSION, name: 'Game', startLevelId, levels };
}

describe('asProject', () => {
  it('reads a lone scene as a one-level game', () => {
    // The entire backwards-compatibility story. A `.hela` file, a cloud row and an export payload
    // written before this feature each hold exactly this shape.
    const level = scene('forest');
    const result = asProject(level);

    expect(result.levels).toHaveLength(1);
    expect(result.startLevelId).toBe('forest');
    expect(result.name).toBe('forest');
    // Not a shim around the old shape: a game with one level *is* a one-level project.
    expect(result.levels[0]).toEqual(level);
  });

  it('reads a project unchanged', () => {
    const result = asProject(project([scene('a'), scene('b')], 'b'));
    expect(result.levels.map((level) => level.sceneId)).toEqual(['a', 'b']);
    expect(result.startLevelId).toBe('b');
  });

  it('reports a broken project as a project, not as a broken scene', () => {
    // A document that is nearly a project should not send the reader hunting for `terrain` and
    // `player` because the scene attempt was this function's own idea.
    let message = '';
    try {
      asProject({ version: 1, name: 'Game', startLevelId: 'a', levels: [] });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('levels');
    expect(message).not.toContain('terrain');
  });
});

describe('GameProjectSchema', () => {
  it('refuses a start level that is not one of the levels', () => {
    // Caught at the parse boundary, where a folder-of-files design could only find out by fetching.
    // Zod serialises the message into JSON, so the quotes around the id arrive escaped.
    expect(() => GameProjectSchema.parse(project([scene('a')], 'nowhere'))).toThrow(
      /the start level .*nowhere.* is not one of the levels/,
    );
  });

  it('refuses two levels with the same id', () => {
    expect(() => GameProjectSchema.parse(project([scene('a'), scene('a')]))).toThrow(
      /two levels share the id/,
    );
  });

  it('refuses a game with no levels at all', () => {
    expect(() => GameProjectSchema.parse(project([]))).toThrow();
  });
});

describe('helpers', () => {
  it('finds the start level, and falls back rather than returning nothing', () => {
    const parsed = GameProjectSchema.parse(project([scene('a'), scene('b')], 'b'));
    expect(startLevel(parsed).sceneId).toBe('b');
    expect(levelById(parsed, 'a')?.sceneId).toBe('a');
    expect(levelById(parsed, 'ghost')).toBeNull();
  });

  it('replaces one level and keeps the order', () => {
    const parsed = GameProjectSchema.parse(project([scene('a'), scene('b'), scene('c')]));
    const edited = withLevel(parsed, scene('b', { name: 'Renamed' }));

    expect(edited.levels.map((level) => level.sceneId)).toEqual(['a', 'b', 'c']);
    expect(edited.levels[1]?.name).toBe('Renamed');
    // The original is untouched, so undo has something to go back to.
    expect(parsed.levels[1]?.name).toBe('b');
  });

  it('round-trips a scene through projectFromScene', () => {
    const level = scene('only');
    expect(GameProjectSchema.parse(projectFromScene(level)).levels[0]).toEqual(level);
  });
});

describe('danglingLevelLinks', () => {
  const linking = (sceneId: string, to: string): Scene =>
    scene(sceneId, {
      graph: {
        variables: [],
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'go', type: 'loadLevel', levelId: to, carryState: true },
        ],
        edges: [{ from: 'start', port: 'then', to: 'go' }],
        layout: {},
      },
    });

  it('finds a door to a level that does not exist', () => {
    const parsed = GameProjectSchema.parse(project([linking('a', 'caves'), scene('b')]));
    expect(danglingLevelLinks(parsed)).toEqual([{ from: 'a', to: 'caves' }]);
  });

  it('says nothing about a door that leads somewhere', () => {
    const parsed = GameProjectSchema.parse(project([linking('a', 'b'), scene('b')]));
    expect(danglingLevelLinks(parsed)).toEqual([]);
  });

  it('ignores a level not chosen yet, which the graph already reports', () => {
    // Two errors for one blank dropdown would mean fixing it clears only half the complaints.
    const parsed = GameProjectSchema.parse(project([linking('a', ''), scene('b')]));
    expect(danglingLevelLinks(parsed)).toEqual([]);
  });
});
