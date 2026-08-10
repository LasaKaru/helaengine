---
name: prove-it-in-a-browser
description: "Use when a HelaEngine change claims something visual or behavioural — vegetation sways, a preset changes the image, a graph runs, the player spawns somewhere. Unit tests cannot see a GPU or a frame loop, and this codebase has repeatedly shipped settings that saved and exported perfectly while doing nothing on screen. Gives the test pattern, the traps that make such a test pass vacuously, and the dev API to assert against. Triggers: 'prove it works', 'does it actually render', writing an e2e for a rendering or gameplay feature."
---

# Proving a visual or behavioural claim

## Why this exists

Three separate features in this codebase saved correctly, survived a reload, exported correctly —
and did nothing at all in the viewport. Every environment change, every material override, and both
animation and wind, because nothing in the editor was calling the loader's per-frame tick. The
setting was right, the document was right, and the screen was wrong.

A unit test cannot catch that. It has no GPU, no frame loop, and no editor.

## The shape

```ts
// 1. Establish the control. Without it, "the pixels changed" proves nothing.
expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(false);
const [stillA, stillB] = await twoFrames(page);
expect(stillA.equals(stillB)).toBe(true);

// 2. Prove the subject is on screen. Two frames of empty sky pass step 1 perfectly.
expect(await page.evaluate(() => window.helaengine!.store.getState().scene.objects.length)).toBe(1);

// 3. Turn it on, and assert the loader agrees it is on.
await setWind(page, 2);
expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(true);

// 4. Now the pixels.
const [windyA, windyB] = await twoFrames(page);
expect(windyA.equals(windyB)).toBe(false);
```

## The traps

**The subject is off screen.** The first version of the wind test framed nothing: the still case
passed because the sky does not move, and the windy case failed for the same reason. It reported a
working shader as broken. **Call `setCameraPose` and point at the thing.**

**Asserting on the document.** `scene.environment.wind.strength` being 2 says the store took the
value. It says nothing about the renderer. Assert on a dev-API reading that comes _from the
loader_ — `windActive()`, `scatterCount()`, `postProcessingActive()` — or on pixels.

**A shader that fails to compile does not throw.** `onBeforeCompile` errors log and leave the
material rendering unmoved. Only pixels catch it.

**Comparing PNG bytes as if they were pixels.** `a.equals(b)` answers "are these identical", which
is the right question. A byte-difference _threshold_ is meaningless — say what you actually mean.

## Waiting

Do not sleep a fixed time and screenshot. Either poll a dev-API value:

```ts
await expect
  .poll(async () => page.evaluate(() => window.helaengine!.scatterCount()), { timeout: 20_000 })
  .toBeGreaterThan(0);
```

…or shoot once the canvas has stopped changing between reads (`settledFrame` in `look.spec.ts`).

`test.setTimeout(120_000)` for anything that fetches a model or builds thousands of instances. The
default 30s gets spent on setup and the failure looks like the feature.

## Leaving Play Preview

**Escape pauses, it does not leave** — the game shell owns it once it is up, which is what a player
expects. Quit on the pause menu is the gesture that leaves. Copy `exitWalk` from
`e2e/editor.spec.ts`. Getting this wrong turned a passing suite into five minutes of retries.

## Reading the dev API

`window.helaengine` (`apps/editor/src/devApi.ts`) is the surface. Note `playerPosition()` returns
`{x, y, z}`, **not** a tuple — `position[0]` is `undefined` and the failure reads as a broken
feature.

Add to it rather than driving fiddly UI: a right-click context menu over a WebGL canvas needs a
synthetic click at exactly the pixel a raycast happens to hit, which tests the browser's
hit-testing rather than your feature. `playFrom()` exists for that reason.

## Before you trust a green test

Break the thing deliberately and confirm the test goes red. Several tests here were vacuous until
that was done — including one that "verified" a path-traversal guard and passed with the guard
deleted.
