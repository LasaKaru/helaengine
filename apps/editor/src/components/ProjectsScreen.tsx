import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { TEMPLATES } from '../templates';

function formatWhen(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** The home screen: existing projects, and the template picker for new ones. */
export function ProjectsScreen(): React.JSX.Element {
  const projects = useProjectStore((state) => state.projects);
  const loadError = useProjectStore((state) => state.loadError);
  const refreshProjects = useProjectStore((state) => state.refreshProjects);
  const createFromTemplate = useProjectStore((state) => state.createFromTemplate);
  const open = useProjectStore((state) => state.open);
  const remove = useProjectStore((state) => state.remove);
  const duplicate = useProjectStore((state) => state.duplicate);

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="projects-screen">
      <header className="projects-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">HelaEngine</span>
        </div>
        <p className="projects-tagline">
          Projects live in this browser. Cloud sync arrives in Sprint 29.
        </p>
      </header>

      {loadError && (
        <p className="projects-error" role="alert">
          {loadError}
        </p>
      )}

      <section aria-label="Start a new project">
        <h2>Start something</h2>
        <div className="template-grid">
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="template-card"
              disabled={busy}
              onClick={() => void run(() => createFromTemplate(template.id))}
            >
              <span className="template-name">{template.name}</span>
              <span className="template-description">{template.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Your projects">
        <h2>Your projects</h2>
        {projects.length === 0 ? (
          <p className="panel-hint">
            Nothing saved yet. Pick a template above and it will appear here.
          </p>
        ) : (
          <ul className="project-grid">
            {projects.map((project) => (
              <li key={project.id}>
                <article className="project-card">
                  <button
                    type="button"
                    className="project-open"
                    disabled={busy}
                    onClick={() => void run(() => open(project.id))}
                  >
                    {project.thumbnail ? (
                      <img src={project.thumbnail} alt="" />
                    ) : (
                      <span className="project-thumb-empty" aria-hidden="true" />
                    )}
                    <span className="project-name">{project.name}</span>
                    <span className="project-when">Edited {formatWhen(project.updatedAt)}</span>
                  </button>

                  <div className="project-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => duplicate(project.id))}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete "${project.name}"? This cannot be undone.`)) {
                          void run(() => remove(project.id));
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
