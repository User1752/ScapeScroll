'use strict';

const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers');

// Each entry is [urlPath, expected view container id] — see router.js's
// ROUTER_VIEW_PATHS and ui-view-management.js's setView(), which toggles
// `#view-${view}` visibility. These are read-only navigations only.
const ROUTES = [
  ['/', 'view-discover'],
  ['/library', 'view-library'],
  ['/search', 'view-advanced-search'],
  ['/history', 'view-history'],
  ['/achievements', 'view-achievements'],
];

for (const [path, viewId] of ROUTES) {
  test(`navigating to ${path} shows #${viewId} with no console errors`, async ({ page }) => {
    const getErrors = trackConsoleErrors(page);

    await page.goto(path);
    await expect(page.locator(`#${viewId}`)).not.toHaveClass(/hidden/);

    expect(getErrors(), 'unexpected console/page errors').toEqual([]);
  });
}

test('reload preserves the current view via router.js history sync', async ({ page }) => {
  await page.goto('/library');
  await expect(page.locator('#view-library')).not.toHaveClass(/hidden/);

  await page.reload();
  await expect(page.locator('#view-library')).not.toHaveClass(/hidden/);
});
