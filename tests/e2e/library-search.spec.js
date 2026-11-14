'use strict';

const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers');

// Regression test for the debounce fix on #librarySearchInput (was calling
// renderLibrary() — a full grid rebuild — on every keystroke). This only
// asserts the search narrows the grid down; it doesn't assert on exact
// titles/counts since that depends on whatever library the developer
// running this actually has.
test('library search filters the grid without erroring', async ({ page }) => {
  const getErrors = trackConsoleErrors(page);

  await page.goto('/library');
  const cards = page.locator('#library .library-card');
  const searchInput = page.locator('#librarySearchInput');

  await expect(searchInput).toBeVisible();
  // The grid populates asynchronously after the initial /api/library fetch —
  // wait for at least one real card instead of racing a bare .count() against
  // that fetch, which would otherwise read 0 before it resolves.
  await expect(cards.first()).toBeVisible({ timeout: 10_000 }).catch(() => {});
  const initialCount = await cards.count();
  test.skip(initialCount === 0, 'library is empty on this instance — nothing to filter');

  // A query unlikely to match anything real narrows the grid to zero cards
  // (a "no manga found" placeholder takes their place) — proves the
  // debounced handler actually re-renders (Playwright's expect().toHaveCount()
  // polls, so this also confirms the 200ms debounce doesn't just... never fire).
  await searchInput.fill('zzzznonexistentquery9999');
  await expect(cards).toHaveCount(0);

  await searchInput.fill('');
  await expect(cards).toHaveCount(initialCount);

  expect(getErrors(), 'unexpected console/page errors').toEqual([]);
});
