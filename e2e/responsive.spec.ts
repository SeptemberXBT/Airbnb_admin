import { expect, test } from "@playwright/test";

const viewports = [
  { name: "mobile-360", width: 360, height: 800 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
];

for (const viewport of viewports) {
  test(`calendar fits ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/calendar?range=14");
    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
    await expect(page.getByLabel("14-day property calendar")).toBeVisible();
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow).toBeLessThanOrEqual(1);
    const barsContained = await page.locator(".calendar-event").evaluateAll((bars) => bars.every((bar) => {
      const row = bar.closest(".calendar-property-row");
      if (!row) return false;
      const barBox = bar.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return barBox.top >= rowBox.top && barBox.bottom <= rowBox.bottom;
    }));
    expect(barsContained).toBe(true);

    if (viewport.width <= 760) {
      await expect(page.getByRole("navigation", { name: "Primary navigation" }).last()).toBeVisible();
      await expect(page.locator(".sidebar")).toBeHidden();
    } else {
      await expect(page.locator(".sidebar")).toBeVisible();
      await expect(page.locator(".bottom-nav")).toBeHidden();
    }
    await page.screenshot({ path: `artifacts/screenshots/calendar-${viewport.name}.png`, fullPage: true, caret: "initial" });
  });
}

test("mobile date editing uses a bottom sheet with touch-size controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/calendar?range=14");
  await page.getByRole("button", { name: /^Add entry for Courtyard Studio/ }).last().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.y).toBeGreaterThan(80);
  expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - 844)).toBeLessThanOrEqual(2);
  const saveBox = await dialog.getByRole("button", { name: "Save" }).boundingBox();
  expect(saveBox?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "artifacts/screenshots/calendar-mobile-bottom-sheet.png", caret: "initial" });
});

test("today queue provides large mobile quick actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today's cleaning" })).toBeVisible();
  const ready = page.getByRole("button", { name: "Ready" }).first();
  const readyBox = await ready.boundingBox();
  expect(readyBox?.height).toBeGreaterThanOrEqual(44);
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(pageOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "artifacts/screenshots/today-mobile.png", fullPage: true, caret: "initial" });
});

test("today queue remains dense and readable on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/today");
  await expect(page.locator(".cleaning-card")).toHaveCount(5);
  await page.screenshot({ path: "artifacts/screenshots/today-desktop.png", fullPage: true, caret: "initial" });
});
