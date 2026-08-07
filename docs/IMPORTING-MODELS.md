# Using your own models

Drop a `.glb` on the **Import models** panel and it joins the asset library: draggable into the
world, animatable, and included in your export. No account, no server, no build step.

---

## The three ways a custom model can arrive

They are genuinely different, and which one you want depends on what you are doing.

|                       | Needs                           | Survives a reload                | Shared between machines  |
| --------------------- | ------------------------------- | -------------------------------- | ------------------------ |
| **Import models**     | nothing                         | **yes** — stored in this browser | no                       |
| **My Assets**         | an account and the platform API | yes                              | yes                      |
| Inside a `.hela` file | nothing                         | no — blob URLs die with the tab  | it travels with the file |

The first row is new, and it is the one that fits somebody who unzipped the portable build and
wants to use their own tree. Uploading needs a database and three services running; a `.hela`
import is for opening a project somebody sent you, and its models are deliberately temporary.
Neither answered "I am building a game on my laptop and this is my art."

---

## What happens when you import

The file is **measured before it is stored**, by the same rules the ingest pipeline applies to the
shipped library — and the numbers are verified against it, so the editor and an export never
disagree about a model.

What comes back, and why each is needed before the model is ever loaded:

- **Triangle count** — the budget warning, and the reason a 200,000-triangle hero says so up front.
- **Bounds** — the placeholder box, and the collider.
- **Animation clip names** — the Animation panel's dropdowns. A dropdown that can only be filled
  after downloading a 5 MB character is an empty dropdown when somebody looks at it.
- **Whether it is skinned** — how the loader clones it, and whether it can be batched. Getting this
  wrong makes every copy of a character animate in lockstep, silently.

A file that cannot be parsed is refused **with its own filename in the message**. That is worth
more than it sounds when you have just selected eight files.

Two things it warns about rather than fixing:

- **Authored in centimetres.** A model over 40 units across almost certainly is — every Mixamo
  character arrives 175 units tall. Set the object's scale to 0.01, or re-export in metres. It
  warns rather than rescaling because a model really might be a cathedral.
- **A floating pivot.** If the origin sits above the model's lowest point, it hovers when placed on
  the ground. Fix it at the origin in Blender.

## Attribution

There are Author and Licence fields on the panel, and they are worth filling in. An imported model
is the one most likely to carry a licence somebody has to honour, and an export's `CREDITS.md` is
generated from the manifest — so what you type here is what your game says about where its art came
from. Left blank, it records nothing, which is honest; the alternative is a game that silently
claims everything as its own.

## Formats

**glTF only** — `.glb` or `.gltf`. It is the format the engine loads, the browser can decode without
a plugin, and every tool exports.

FBX, OBJ and Collada have to be converted first. Blender does it in two clicks: File → Import, then
File → Export → **glTF 2.0 (.glb)**. That is also the route for a Mixamo character; see
[`ANIMATION.md`](ANIMATION.md) for the animation-specific parts.

## Limits, and where they come from

- **64 MB per model.** Not an IndexedDB limit — it will hold far more. It is what an _export_ can
  survive: the whole thing is assembled in the browser's memory before the zip is written, and a
  tab that runs out of memory mid-export gives no useful error at all. Refusing at import is kinder
  than discovering it when you try to ship.
- **A warning above 20,000 triangles**, never a refusal. A hero character legitimately wants more
  geometry than a rock, and a hard limit here would be the tool deciding what game you are making.

## Where they live, and what that means

In this browser's IndexedDB, beside your projects. Concretely:

- They **survive a reload and a restart**. This is the whole point of the table.
- They are **per-browser**. A different machine, or a different browser on the same machine, does
  not have them. Use **My Assets** if you want that, or send a `.hela` file.
- **Clearing your browser data deletes them**, exactly as it deletes browser-stored projects. Keep
  the original `.glb` files somewhere; and `Ctrl+Shift+S` writes a `.hela` file that contains every
  custom model the project places.
- Re-importing a file with the same name **replaces** it. Fix a model in Blender, import it again,
  and every object already placed updates — rather than accumulating a second asset nothing points
  at.

## In an export

They ship like any other asset. Their files are written into `assets/models/` and the export's own
manifest is rewritten to match, so the game is self-contained and nothing points back at your
browser.

That last part was a real bug until recently: an uploaded or imported model used to be copied into
the zip under its blob URL, producing a file called `assets/blob:http://localhost/abc-123` and a
manifest still pointing at a URL that no longer existed. The export reported success and every
custom model in the game was a grey box.

---

## What was verified

In a real browser, against the Fox — which is both the test fixture and a shipped asset, so the
browser's measurement can be compared with the pipeline's:

|                          |                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Both agree**           | 576 triangles, `["Survey","Walk","Run"]`, skinned — identical from `inspectModel` in the browser and `pnpm ingest-assets` in Node, read from the generated manifest rather than restated.    |
| **The panel works**      | File chosen through the real file input; "576 triangles, 3 animations, rigged" and the centimetre warning shown back; the entry present in the editor's manifest with the typed attribution. |
| **It is placeable**      | Placed and the loader built the actual model, not a placeholder box — which is what an asset that reached the list but not the resolver produces.                                            |
| **It survives a reload** | Imported, page reloaded, still listed and still placeable as a real model. A `.hela`-imported model cannot do this.                                                                          |

Twelve unit tests cover the storage rules — ids, replacement, attribution, refusals. `inspectModel`
is deliberately **not** unit tested: it decodes a glTF file through `GLTFLoader`, whose textures go
through an `<img>`, and jsdom has no image decoder. Faking one would be testing a fiction, so the
measurement is tested where it actually runs.
