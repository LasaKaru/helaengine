import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Sprint 37 — the accessibility pass, as a test rather than a claim.
 *
 * The sprint plan asks for "a full accessibility/UX pass over the core editor flows … not full WCAG
 * compliance necessarily, but no glaring usability barriers". A pass performed once by reading the
 * markup is a pass that decays the following week, so it is written as a scan that runs in CI and
 * fails a build — the same argument as the bundle budget and the cache headers.
 *
 * **What axe can and cannot answer.** Automated rules catch roughly a third of WCAG issues: missing
 * names, broken roles, insufficient contrast, form fields with no label. They cannot tell you
 * whether the tab order makes sense, whether a live region announces at a useful moment, or whether
 * a 3D viewport is usable without a mouse. So the scan is paired with keyboard traversals that
 * assert the things a scanner is blind to, and the gaps neither one covers are written down at the
 * bottom of this file rather than left to be discovered by a user.
 *
 * The rule set is `wcag2a` and `wcag2aa`, which is the level the plan implies. `color-contrast` is
 * included deliberately: it is the rule most likely to be disabled for convenience, and the one a
 * dark-theme product most often gets wrong.
 */

const RULES = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Runs axe and fails with something a person can act on.
 *
 * The default failure prints a JSON blob. What a developer needs is the rule, the impact, and the
 * selector of the element — so that is what this formats, and nothing else.
 */
async function scan(page: Page, where: string, exclude: string[] = []): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(RULES);
  for (const selector of exclude) builder = builder.exclude(selector);

  const results = await builder.analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );

  const described = serious.map((violation) => {
    const targets = violation.nodes
      .slice(0, 4)
      .map((node) => `        ${[node.target].flat(2).join(' ')}`)
      .join('\n');
    return `  [${violation.impact}] ${violation.id}: ${violation.help}\n${targets}`;
  });

  expect(described, `accessibility violations on ${where}`).toEqual([]);
}

/** Opens a project, the way every editor test does. */
async function openEditor(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('helaengine');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
  );
  await page.reload();
  await page.getByRole('button', { name: /Forest clearing/ }).click();
  // The editor's own chrome, not `role="banner"` — the projects screen has one of those too.
  await expect(page.locator('header.topbar')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Project name')).toBeVisible({ timeout: 30_000 });
}

test.describe('accessibility', () => {
  test('the projects screen has no serious violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Start something' })).toBeVisible();
    await scan(page, 'the projects screen');
  });

  test('the editor has no serious violations', async ({ page }) => {
    test.setTimeout(120_000);
    await openEditor(page);

    // The canvas is excluded, and this is the one exclusion worth arguing for: a WebGL viewport is
    // a bitmap, and no amount of markup makes a rendered 3D scene readable to a screen reader. What
    // has to be accessible is every *control* that acts on it — the scene tree, the inspector, the
    // toolbar — and those are all in scope below.
    await scan(page, 'the editor', ['canvas']);
  });

  test('the inspector has no serious violations with an object selected', async ({ page }) => {
    test.setTimeout(120_000);
    await openEditor(page);

    // A panel full of disabled placeholders is not the panel users see. Selecting an object is what
    // renders the transform fields, the behaviour list and the physics controls — which is where
    // form-labelling problems actually live.
    await page.evaluate(() => {
      const id = window.helaengine!.addObject('tree_pine_01', [0, 0, 0]);
      window.helaengine!.store.getState().select([id]);
    });
    await expect(page.getByRole('heading', { name: /Properties/i })).toBeVisible();

    await scan(page, 'the inspector', ['canvas']);
  });

  test('every focusable control shows a visible focus ring', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Start something' })).toBeVisible();

    /**
     * Focus is the thing a scanner cannot check and a keyboard user cannot do without.
     *
     * axe has no rule for "the focus indicator is visible", because whether a ring is perceivable is
     * a rendering question rather than a markup one. So this focuses each control in turn and
     * compares the computed style against the same element unfocused — any difference in outline,
     * box-shadow or border is accepted, because the design is free to indicate focus however it
     * likes, and *no* difference is the failure.
     */
    const controls = await page.locator('button, a[href], input, select, textarea').all();
    expect(controls.length).toBeGreaterThan(3);

    const unmarked: string[] = [];
    for (const control of controls.slice(0, 25)) {
      if (!(await control.isVisible())) continue;

      const before = await control.evaluate((node) => {
        const style = getComputedStyle(node);
        return `${style.outline}|${style.boxShadow}|${style.borderColor}|${style.backgroundColor}`;
      });
      await control.focus();
      const after = await control.evaluate((node) => {
        const style = getComputedStyle(node);
        return `${style.outline}|${style.boxShadow}|${style.borderColor}|${style.backgroundColor}`;
      });

      if (before === after) {
        unmarked.push(
          await control.evaluate(
            (node) =>
              `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''} "${(node.textContent ?? '').trim().slice(0, 30)}"`,
          ),
        );
      }
    }

    expect(unmarked, 'controls that look identical focused and unfocused').toEqual([]);
  });

  test('a project can be opened with the keyboard alone', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase('helaengine');
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Start something' })).toBeVisible();

    /**
     * The first thing a new user does, done without a mouse.
     *
     * Tabbing until the template button has focus rather than calling `.focus()` on it: the point is
     * that it is *reachable* in the tab order, which `.focus()` would prove nothing about. The bound
     * is generous but finite — a control that needs sixty tabs is technically reachable and
     * practically not.
     */
    const target = page.getByRole('button', { name: /Empty field/ });
    let reached = false;
    for (let press = 0; press < 40 && !reached; press += 1) {
      await page.keyboard.press('Tab');
      reached = await target.evaluate((node) => node === document.activeElement);
    }

    expect(reached, 'the first template is reachable by tabbing').toBe(true);

    await page.keyboard.press('Enter');
    await expect(page.locator('header.topbar')).toBeVisible({ timeout: 30_000 });
  });
});

/**
 * What this does not cover, so nobody mistakes a green run for compliance.
 *
 * - **The viewport itself.** Placing and moving objects is a pointer gesture on a WebGL canvas.
 *   There is no keyboard path to "put a tree here", and building one is a feature, not a fix.
 * - **Screen-reader announcement.** The scan checks that names and roles exist, not that a live
 *   region fires at a useful moment or that focus lands sensibly after a panel opens. That needs a
 *   real screen reader and a person listening.
 * - **The play shell and exported games.** Out of scope here; an exported project is its own
 *   artefact with its own UI, and it deserves its own pass.
 * - **Moderate and minor violations.** Only `serious` and `critical` fail a build. The others are
 *   worth reading and not worth blocking a release over, which is a judgement, not a standard.
 * - **Reduced motion, zoom to 200%, and touch targets.** Unchecked.
 */
