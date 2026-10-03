// Drives the real app through every screen against a local pretend store.
// Usage: pnpm app:build && pnpm e2e [screenshot-folder]
// Set DROPWATCH_EXE to test a packaged build instead of the dev build.
// Alerts that would open a browser tab or play the alarm are switched off
// early in the run.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron } from "playwright-core";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "dropwatch-e2e-shots"));
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "dropwatch-e2e-"));

// ---- The pretend store ----
let inStock = false;
const hits = [];
const server = createServer((req, res) => {
  hits.push({ url: req.url, agent: req.headers["user-agent"] ?? "" });
  if (req.url === "/robots.txt") {
    res.end("User-agent: *\nDisallow: /cart\n");
  } else if (req.url === "/products/elite-trainer-box.js") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        title: "Prismatic Evolutions Elite Trainer Box",
        available: inStock,
        price: 5499,
        variants: [{ id: 1, title: "Default", available: inStock, price: 5499 }],
      }),
    );
  } else if (req.url === "/item/booster-bundle") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Surging Sparks Booster Bundle",
        offers: { "@type": "Offer", availability: "https://schema.org/OutOfStock", price: "26.94" },
      })}</script></head><body>Booster Bundle</body></html>`,
    );
  } else if (req.url === "/item/plain") {
    res.setHeader("Content-Type", "text/html");
    res.end("<html><head><title>Mini Tin | Pretend Store</title></head><body><h1>Mini Tin</h1><p>Sold out</p></body></html>");
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const store = `http://127.0.0.1:${server.address().port}`;

// ---- Helpers ----
const results = [];
async function step(name, run) {
  try {
    await run();
    results.push(["PASS", name]);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(["FAIL", name]);
    console.log(`FAIL  ${name}\n      ${String(err.message ?? err).split("\n")[0]}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const env = {
  ...process.env,
  DROPWATCH_DATA_DIR: dataDir,
  DROPWATCH_WINDOW_POS: process.env.DROPWATCH_WINDOW_POS ?? "4040,100",
};
delete env.ELECTRON_RUN_AS_NODE;
// DROPWATCH_EXE points the same run at a packaged build, for example
// release/win-unpacked/Dropwatch.exe.
const exe = process.env.DROPWATCH_EXE;
const app = await electron.launch(exe ? { executablePath: resolve(exe), args: [], env } : { args: ["."], env });
const page = await app.firstWindow();
page.setDefaultTimeout(8000);
const errors = [];
page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
page.on("pageerror", (err) => errors.push(err.stack ?? String(err)));
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const button = (name) => page.getByRole("button", { name, exact: true });
// Sidebar buttons can carry a badge ("Watchlist 1 in stock"), so match loosely.
const nav = (name) => page.getByRole("navigation").getByRole("button", { name });
const toggle = (name) => page.getByRole("switch", { name });
const closeDialogs = async () => {
  for (const close of await page.getByRole("button", { name: "Close", exact: true }).all()) {
    await close.click().catch(() => {});
  }
};

try {
  await step("first run shows the welcome step", async () => {
    await page.getByRole("heading", { name: "Know the minute it's back in stock" }).waitFor();
    await shot("01-welcome");
  });

  await step("alert step: toggles, phone setup, test alert", async () => {
    await button("Set it up").click();
    await toggle("Open the product page in my browser").click();
    await toggle("Play an alarm sound").click();
    await button("Set up phone alerts").click();
    await page.locator(".topic code").waitFor();
    const topic = await page.locator(".topic code").innerText();
    expect(/^dropwatch-[a-z2-9]{10}$/.test(topic), `unexpected topic ${topic}`);
    await button("Send a test alert").click();
    await page.getByText(/^Sent: desktop notification and phone\.$/).waitFor({ timeout: 15000 });
    await shot("02-alerts");
  });

  await step("first product: paste a link, preview, watch", async () => {
    await button("Continue").click();
    await page.getByLabel("Product link").fill(`${store}/products/elite-trainer-box`);
    await button("Check link").click();
    await page.getByText("Sold out right now").waitFor();
    const name = await page.getByLabel("Name").inputValue();
    expect(name === "Prismatic Evolutions Elite Trainer Box", `name prefilled as "${name}"`);
    await page.getByLabel(/Only alert me at or below/).fill("60");
    await shot("03-first-product");
    await button("Watch this product").click();
    await page.getByRole("heading", { name: "Watchlist" }).waitFor();
    await page.locator(".row__name", { hasText: "Prismatic Evolutions Elite Trainer Box" }).waitFor();
  });

  await step("add a second product from an ordinary page", async () => {
    await button("Add a product").click();
    await page.getByLabel("Product link").fill(`${store}/item/booster-bundle`);
    await button("Check link").click();
    await page.getByText("Sold out right now").waitFor();
    await button("Watch this product").click();
    await page.locator(".row__name", { hasText: "Surging Sparks Booster Bundle" }).waitFor();
    await shot("04-watchlist");
  });

  await step("a page with no stock data asks for the sold-out words", async () => {
    await button("Add a product").click();
    await page.getByLabel("Product link").fill(`${store}/item/plain`);
    await button("Check link").click();
    await page.getByText("One question about this page").waitFor();
    await page.getByLabel("Sold-out words").fill("Sold out");
    await shot("05-sold-out-words");
    await button("Check again").click();
    await page.getByText("Sold out right now").waitFor();
    await page.getByLabel("Name").fill("Mini Tin");
    await button("Watch this product").click();
    await page.locator(".row__name", { hasText: "Mini Tin" }).waitFor();
  });

  await step("a broken link, a duplicate and a missing page are explained", async () => {
    await button("Add a product").click();
    await page.getByLabel("Product link").fill("not a link");
    await button("Check link").click();
    await page.getByText(/doesn't look like a web link/).waitFor();
    await page.getByLabel("Product link").fill(`${store}/item/booster-bundle`);
    await button("Check link").click();
    await page.getByText("You're already watching this product.").waitFor();
    await page.getByLabel("Product link").fill(`${store}/item/missing`);
    await button("Check link").click();
    await page.getByText(/was not found/).waitFor();
    await shot("06-link-error");
  });

  await step("a big retailer is refused and leads to a reminder", async () => {
    await page.getByLabel("Product link").fill("https://www.pokemoncenter.com/product/100-10019");
    await button("Check link").click();
    await page.getByText("Dropwatch won't check Pokemon Center").waitFor();
    await shot("07-restricted");
    await button("Set a reminder instead").click();
    await page.getByRole("heading", { name: "Add a reminder" }).waitFor();
    const name = await page.getByLabel("What is dropping").inputValue();
    expect(name === "Pokemon Center drop", `name prefilled as "${name}"`);
    const soon = new Date(Date.now() + 80_000);
    const pad = (n) => String(n).padStart(2, "0");
    await page.getByLabel("Date").fill(`${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`);
    await page.getByLabel("Time").fill(`${pad(soon.getHours())}:${pad(soon.getMinutes())}`);
    await page.waitForTimeout(300);
    await shot("08-reminder-form");
    await button("Save reminder").click();
    await page.locator(".row__name", { hasText: "Pokemon Center drop" }).waitFor();
    await shot("09-reminders");
  });

  await step("a past reminder time is rejected", async () => {
    await button("Add a reminder").click();
    await page.getByLabel("What is dropping").fill("Old drop");
    await page.getByLabel("Page to open").fill("target.com");
    await page.getByLabel("Date").fill("2026-01-01");
    await page.getByLabel("Time").fill("08:00");
    await button("Save reminder").click();
    await page.getByText(/already passed/).waitFor();
  });
  await closeDialogs();

  await step("stock arrives: the row lights up and the alert is logged", async () => {
    inStock = true;
    await nav("Watchlist").click();
    await page
      .locator(".row--live .row__name", { hasText: "Prismatic Evolutions Elite Trainer Box" })
      .waitFor({ timeout: 50000 });
    await page.getByText("1 in stock").waitFor();
    await shot("10-in-stock");
    await nav("Activity").click();
    await page.getByText(/^In stock at \$54\.99 on /).waitFor();
    await shot("11-activity");
  });

  await step("edit the price limit: over the limit shows as such", async () => {
    await nav("Watchlist").click();
    const row = page.locator(".row", { hasText: "Prismatic Evolutions Elite Trainer Box" });
    await row.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel(/Only alert me at or below/).fill("abc");
    await button("Save changes").click();
    await page.getByText("Type the price limit as a number, like 49.99.").waitFor();
    await page.getByLabel(/Only alert me at or below/).fill("40");
    await button("Save changes").click();
    await row.getByText("Over your limit").waitFor({ timeout: 50000 });
    await shot("12-over-limit");
  });
  await closeDialogs();

  await step("check now is rate limited with an explanation", async () => {
    const row = page.locator(".row", { hasText: "Prismatic Evolutions Elite Trainer Box" });
    await row.getByRole("button", { name: "Check now" }).click();
    await page.getByText(/waits 15 seconds between checks/).waitFor();
    await page.locator(".toast").waitFor({ state: "detached" });
  });

  await step("stop watching asks first, then removes", async () => {
    const row = page.locator(".row", { hasText: "Mini Tin" });
    await row.getByRole("button", { name: "Stop watching" }).click();
    await page.getByRole("heading", { name: "Stop watching this product?" }).waitFor();
    await page.waitForTimeout(300);
    await shot("13-confirm-remove");
    await page.getByRole("dialog").getByRole("button", { name: "Stop watching" }).click();
    await row.waitFor({ state: "detached" });
  });
  await closeDialogs();

  await step("pause and resume", async () => {
    await button("Pause watching").click();
    await page.getByText("Watching is paused. Nothing is being checked.").waitFor();
    await shot("14-paused");
    await button("Resume watching").click();
    await page.getByText("Watching 2 products").waitFor();
  });

  await step("settings: Discord check, Best Buy key, screenshots", async () => {
    await nav("Settings").click();
    await page.getByLabel("Webhook link").fill("https://example.com/hook");
    await button("Save webhook").click();
    await page.getByText(/That is not a Discord webhook link/).waitFor();
    await page.getByLabel("Best Buy key").fill("short");
    await button("Save key").click();
    await page.getByText(/doesn't look like a Best Buy key/).waitFor();
    await page.locator(".view").evaluate((el) => el.scrollTo(0, 0));
    await shot("15-settings");
    await page.locator("#bestbuy").scrollIntoViewIfNeeded();
    await shot("16-settings-lower");
  });

  await step("guide", async () => {
    await nav("Drop-day guide").click();
    await page.getByRole("heading", { name: "What it will not do" }).waitFor();
    await shot("17-guide");
  });

  await step("the reminder goes off at its time", async () => {
    await nav("Activity").click();
    await page.getByText(/^Reminder went off for /).waitFor({ timeout: 100000 });
    await nav("Reminders").click();
    await page.getByText("Done", { exact: true }).waitFor();
    await shot("18-reminder-done");
  });

  await step("dark theme", async () => {
    // Playwright pins the window to the light scheme unless told otherwise.
    await page.emulateMedia({ colorScheme: "dark" });
    await nav("Watchlist").click();
    await page.waitForTimeout(400);
    await shot("19-dark-watchlist");
    await nav("Settings").click();
    await shot("20-dark-settings");
    await nav("Drop-day guide").click();
    await shot("21-dark-guide");
    await page.emulateMedia({ colorScheme: "light" });
  });

  await step("closing the window keeps the app watching in the tray", async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(500);
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible());
    expect(visible === false, `window visible: ${visible}`);
    const before = hits.length;
    await page.waitForTimeout(65000);
    expect(hits.length > before, "no checks were made while hidden");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  });

  await step("the store only ever saw honest, polite requests", async () => {
    const agents = new Set(hits.map((h) => h.agent));
    expect(agents.size === 1 && [...agents][0].startsWith("dropwatch "), `agents: ${[...agents].join(" | ")}`);
    const product = hits.filter((h) => h.url === "/products/elite-trainer-box.js").length;
    console.log(`      ${hits.length} requests in total, ${product} for the first product`);
  });

  await step("no errors in the window console", async () => {
    expect(errors.length === 0, errors.join(" | "));
  });
} finally {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter(([status]) => status === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
