import { useEffect, useState } from 'react';
import { BrandMark } from './BrandMark';
import { useProjectStore } from '../store/projectStore';
import { isHelaFilename } from '../storage/localFile';
import { TEMPLATES } from '@helaengine/templates';
import { AccountBar } from './AccountBar';

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
  const projectsStatus = useProjectStore((state) => state.projectsStatus);
  const projectsError = useProjectStore((state) => state.projectsError);
  const loadError = useProjectStore((state) => state.loadError);
  const refreshProjects = useProjectStore((state) => state.refreshProjects);
  const createFromTemplate = useProjectStore((state) => state.createFromTemplate);
  const openFromFile = useProjectStore((state) => state.openFromFile);
  const importFile = useProjectStore((state) => state.importFile);
  const [dragging, setDragging] = useState(false);
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
      <AccountBar />
      <header className="projects-header">
        <div className="brand">
          <BrandMark size={20} />
          <span className="brand-name">HelaEngine</span>
        </div>
        <p className="projects-tagline">
          Projects live in this browser, and sync to your account when you sign in.
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

      <section aria-label="Open a project file">
        <h2>Open a file</h2>
        <div
          className={`file-drop${dragging ? ' over' : ''}`}
          data-testid="project-file-drop"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = Array.from(event.dataTransfer.files).find((candidate) =>
              isHelaFilename(candidate.name),
            );
            // Silently ignoring a dropped PNG is friendlier than an error: the drop zone is on a
            // screen people are dragging things around on, and not every drop is an attempt.
            if (file) void run(async () => importFile(new Uint8Array(await file.arrayBuffer())));
          }}
        >
          <p>
            Drop a <code>.hela</code> project here
          </p>
          <button type="button" disabled={busy} onClick={() => void run(() => openFromFile())}>
            Choose a file…
          </button>
          <p className="panel-hint">
            A <code>.hela</code> file is the whole project in one file — scene, custom models and
            all. Keep it anywhere: a folder that syncs, a shared drive, a git repository.
          </p>
        </div>
      </section>

      <section aria-label="Your projects">
        <h2>Your projects</h2>
        {/*
          Three states, not two. `projects: []` used to mean both "you have none" and "we have not
          looked yet", so a signed-in user with a dozen projects was told "Nothing saved yet" for
          the length of the fetch — the product telling somebody their work is gone.

          The failure case gets a retry rather than only a sentence: a project list that fails to
          load is usually a network blip, and the alternative is asking the user to reload the page
          and lose whatever else they were doing.
        */}
        {projectsStatus === 'loading' ? (
          <p className="panel-hint" role="status">
            <span className="spinner spinner-inline" aria-hidden="true" />
            Loading your projects…
          </p>
        ) : projectsStatus === 'error' ? (
          <div className="projects-error" role="alert">
            <p>Could not load your projects. {projectsError}</p>
            <button type="button" onClick={() => void refreshProjects()}>
              Try again
            </button>
          </div>
        ) : projects.length === 0 ? (
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
