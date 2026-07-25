# @helaengine/editor — placeholder

Scaffolded in **Sprint 3** (React + Vite + react-three-fiber + Zustand).

Nothing lives here yet on purpose. The Sprint 1–2 goal is to prove the engine renders a scene
document with no UI framework involved, so the editor stays empty until that is true.

When this app is built, the rule from `eslint.config.js` still holds in the other direction: the
editor may import `@helaengine/engine`, but the engine may never import the editor. The editor is a
tool that produces `scene.json`; the engine is what consumes it, both here and inside every
exported project.
