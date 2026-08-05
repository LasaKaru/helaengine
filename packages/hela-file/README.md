# @helaengine/hela-file

The `.hela` project file: one file that holds a whole project.

```
MyLevel.hela   (a zip)
├── hela.json        format version, engine version, what is embedded
├── scene.json       the SceneSchema document
├── thumbnail.png    optional, so a projects list has a picture
├── assets/          custom .glb files this scene actually places
└── ui/              images and videos the shell actually references
```

## Why a container and not a renamed scene.json

A scene document alone is portable right up until somebody uses a model they uploaded or a home
screen image they chose. Then the recipient opens a level full of missing things and the format has
quietly failed at the one job it had.

So the file carries the scene **plus everything it references that the product does not ship with**.

Curated assets are deliberately _not_ embedded: they come with every install, and copying a tree
into every file that places one would turn a 40 KB level into a multi-megabyte one for nothing.

## Built to be committed

A project file people can email is a project file people will put in git. Three decisions follow,
and none of them cost anything:

- **Canonical JSON** — keys sorted, two-space indent. `JSON.stringify` emits insertion order, so
  the same document assembled two different ways otherwise serialises differently and shows up as a
  diff that is not a change.
- **Stored, not deflated** — GLBs arrive Draco-compressed and PNGs are already compressed, so
  deflate buys almost nothing. An uncompressed entry is one git can delta; a deflated one changes
  wholesale when a byte moves.
- **No modification timestamp, and fixed zip entry dates** — the filesystem already knows when a
  file was written. Recording it inside would mean every save differs from the last even when
  nothing changed, which is exactly the noise that stops people committing a file.

The result is asserted rather than asserted-to: `packHelaFile` called twice on an unchanged project
produces byte-identical output, and there is a test that says so.

## Google Drive and GitHub

There is **no Drive integration and no GitHub integration**, and that is a deliberate stopping point
rather than an unfinished one. Both need OAuth credentials — a Google Cloud project with a verified
consent screen, or a registered GitHub App — which are account-level things this repository cannot
provision, and stubbing them would be pretending.

What the file format delivers instead is most of the value without any of that: a `.hela` in a
folder that syncs is backed up by Drive, Dropbox or iCloud already, and `git add MyLevel.hela`
works today — which is why the diffability above is worth the effort rather than a nicety.

If in-editor Drive or GitHub is wanted later, the seam is the same one the rest of this codebase
uses: `buildHelaFile` produces bytes and `importHelaFile` consumes them. A destination is a function
that takes bytes, not a rewrite.
