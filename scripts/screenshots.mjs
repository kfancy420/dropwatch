// Takes the pictures the README shows, from the real app.
// Usage: pnpm app:build && pnpm screenshots
// The app watches three pretend shops on this computer. Their addresses are
// swapped for made-up shop names just before each picture is taken.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron } from "playwright-core";

const out = resolve(".github/screenshots");
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "dropwatch-shots-"));

// ---- Three pretend shops, one product each ----
const SHOPS = [
  { host: "cardcorner.example", handle: "prismatic-evolutions-elite-trainer-box", title: "Prismatic Evolutions Elite Trainer Box", price: 5499, limit: "60" },
  { host: "towertcg.example", handle: "surging-sparks-booster-bundle", title: "Surging Sparks Booster Bundle", price: 2694 },
  { host: "gamehaven.example", handle: "151-ultra-premium-collection", title: "151 Ultra-Premium Collection", price: 11999, limit: "130" },
];
for (const shop of SHOPS) {
  shop.available = false;
  shop.server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.end("User-agent: *\nDisallow: /cart\n");
    } else if (req.url === `/products/${shop.handle}.js`) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          title: shop.title,
          available: shop.available,
          price: shop.price,
          variants: [{ id: 1, title: "Default", available: shop.available, price: shop.price }],
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise((done) => shop.server.listen(0, "127.0.0.1", done));
  shop.local = `127.0.0.1:${shop.server.address().port}`;
}

const env = {
  ...process.env,
  DROPWATCH_DATA_DIR: dataDir,
  DROPWATCH_ALLOW_LOOPBACK: "1",
  DROPWATCH_WINDOW_POS: process.env.DROPWATCH_WINDOW_POS ?? "4040,100",
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ["."], env });
const page = await app.firstWindow();
page.setDefaultTimeout(10000);
const button = (name) => page.getByRole("button", { name, exact: true });
const nav = (name) => page.getByRole("navigation").getByRole("button", { name });
const toggle = (name) => page.getByRole("switch", { name });
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
const resize = (width, height) =>
  app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);

/** The app's helper processes let go of the folder a moment after it ends, and rmSync does not wait for them. */
async function removeFolder(dir) {
  for (let attempt = 1; ; attempt++) {
    try {
      return rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if (attempt === 120) throw err;
      await new Promise((done) => setTimeout(done, 250));
    }
  }
}

/** Shows the app's current state with the made-up shop names in place of the local addresses. */
async function showDemoState() {
  const state = (await page.evaluate(() => window.dropwatch.call("getState"))).value;
  let text = JSON.stringify(state);
  for (const shop of SHOPS) {
    text = text.replaceAll(`http://${shop.local}`, `https://${shop.host}`).replaceAll(shop.local, shop.host);
  }
  const demo = JSON.parse(text);
  const now = Date.now();
  demo.paused = false;
  demo.activity = demo.activity.filter((entry) => entry.text !== "Paused watching.");
  demo.products.forEach((product, i) => {
    product.checkedAt = now - (4 + i * 7) * 1000;
    product.nextAt = now + (26 - i * 7) * 1000;
    product.checking = false;
  });
  await app.evaluate(
    ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send("dropwatch:state", value),
    demo,
  );
}

try {
  // ---- Setup: how it alerts you ----
  await page.getByRole("heading", { name: "Know the minute it's back in stock" }).waitFor();
  await button("Set it up").click();
  await button("Set up phone alerts").click();
  await page.locator(".topic code").waitFor();
  await resize(1040, 860);
  await shot("setup");
  await resize(1040, 720);

  // Nothing should open, ring or reach a phone while the pictures are taken.
  await button("Turn off phone alerts").click();
  await toggle("Open the product page in my browser").click();
  await toggle("Play an alarm sound").click();
  await toggle("Show a notification on this computer").click();
  await button("Continue").click();

  // ---- Three products ----
  for (const [i, shop] of SHOPS.entries()) {
    if (i > 0) await button("Add a product").click();
    await page.getByLabel("Product link").fill(`http://${shop.local}/products/${shop.handle}`);
    await button("Check link").click();
    await page.getByText("Sold out right now").waitFor();
    if (shop.limit) await page.getByLabel(/Only alert me at or below/).fill(shop.limit);
    await button("Watch this product").click();
    await page.locator(".row__name", { hasText: shop.title }).waitFor();
  }

  // ---- Stock arrives at the first shop ----
  SHOPS[0].available = true;
  await page.locator(".row--live .row__name", { hasText: SHOPS[0].title }).waitFor({ timeout: 60000 });
  await button("Pause watching").click();
  await page.getByText("Watching is paused. Nothing is being checked.").waitFor();

  await showDemoState();
  await page.getByText("Watching 3 products").waitFor();
  await shot("watchlist");

  await page.emulateMedia({ colorScheme: "dark" });
  await nav("Activity").click();
  await showDemoState();
  await shot("activity-dark");
} finally {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  for (const shop of SHOPS) shop.server.close();
  await removeFolder(dataDir);
}
