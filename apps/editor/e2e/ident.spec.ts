import { expect, test } from '@playwright/test';

/**
 * The opening ident.
 *
 * Forced on with `?ident`, because it is deliberately skipped for automated browsers: without that
 * every spec in this suite would pay a second and a half and have its first click swallowed by a
 * full-screen cover. The skip is the behaviour under test as much as the ident is.
 */
test.describe('opening ident', () => {
  test('plays once, clears itself, and does not come back', async ({ page }) => {
    await page.goto('/?ident');
    await expect(page.getByTestId('opening-ident')).toBeVisible();

    // It clears on its own. A cover that needs dismissing is a dialog, not an ident.
    await expect(page.getByTestId('opening-ident')).toBeHidden({ timeout: 5000 });

    // Second visit in the same session: gone. Held in sessionStorage rather than state, because
    // state resets on a route change and a splash that reappears when you close a project is a bug
    // that looks like a feature.
    await page.goto('/');
    await expect(page.getByTestId('opening-ident')).toHaveCount(0);
  });

  test('a click gets rid of it immediately', async ({ page }) => {
    await page.goto('/?ident');
    await expect(page.getByTestId('opening-ident')).toBeVisible();

    await page.mouse.click(400, 300);
    // Well inside the full duration: nobody should have to wait out an animation they have seen.
    await expect(page.getByTestId('opening-ident')).toBeHidden({ timeout: 600 });
  });

  test('stays out of the way of an automated browser', async ({ page }) => {
    // The control, and the reason the whole suite still runs at its old speed. Without `?ident`
    // there is no cover at all, so no spec has to know this feature exists.
    await page.goto('/');
    await expect(page.getByTestId('opening-ident')).toHaveCount(0);
  });
});
