import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Engine, explainError, normalizeUrl, UserError, type Notice } from "../app/main/engine.js";
import { clearRobotsCache } from "../src/robots.js";
import { fakeFetch, type Route } from "./helpers.js";

const URL_ETB = "https://shop.test/products/etb";

const product = (available: boolean, price = 4999) =>
  JSON.stringify({
    title: "Elite Trainer Box",
    available,
    price,
    variants: [{ id: 11, title: "Default", available, price }],
  });

let dir: string;

beforeEach(() => {
  clearRobotsCache();
  dir = mkdtempSync(join(tmpdir(), "dropwatch-test-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(routes: Record<string, Route> = {}) {
  let now = Date.parse("2026-11-14T08:00:00Z");
  const opened: string[] = [];
  const notices: Notice[] = [];
  const posts: Array<{ url: string; body: string }> = [];
  let sounds = 0;
  let postStatus = 200;
  const allRoutes: Record<string, Route> = {
    "https://shop.test/robots.txt": { body: "User-agent: *\nDisallow: /cart" },
    [`${URL_ETB}.js`]: { body: product(false) },
    ...routes,
  };
  const fetchImpl = fakeFetch(allRoutes);
  const make = () =>
    new Engine({
      dir,
      openExternal: (url) => void opened.push(url),
      notify: (n) => void notices.push(n),
      playSound: () => void sounds++,
      onState: () => {},
      fetchImpl,
      post: async (url, init) => {
        posts.push({ url, body: init.body });
        return { ok: postStatus < 300, status: postStatus };
      },
      now: () => now,
      random: () => 0.5,
      sleep: async (ms) => void (now += ms),
    });
  return {
    engine: make(),
    restart: make,
    routes: allRoutes,
    fetchImpl,
    opened,
    notices,
    posts,
    sounds: () => sounds,
    advance: (ms: number) => void (now += ms),
    time: () => now,
    failPosts: () => void (postStatus = 500),
  };
}

async function watchEtb(h: ReturnType<typeof harness>, maxPrice?: number) {
  const preview = await h.engine.previewProduct(URL_ETB);
  expect(preview.kind).toBe("ok");
  h.engine.addProduct({ url: URL_ETB, name: "Elite Trainer Box", maxPrice });
}

describe("adding a product", () => {
  it("previews a link, then watches it without asking the store twice", async () => {
    const h = harness();
    expect(await h.engine.previewProduct("shop.test/products/etb")).toMatchObject({
      kind: "ok",
      source: "shopify",
      title: "Elite Trainer Box",
      price: 49.99,
      availability: "out_of_stock",
    });
    h.engine.addProduct({ url: URL_ETB, name: "  Elite   Trainer Box ", maxPrice: 60 });
    const calls = h.fetchImpl.calls.length;
    await h.engine.pulse();
    expect(h.fetchImpl.calls.length).toBe(calls);
    expect(h.engine.view().products[0]).toMatchObject({
      id: "elite-trainer-box",
      name: "Elite Trainer Box",
      status: "out_of_stock",
      maxPrice: 60,
    });
    expect(JSON.parse(readFileSync(join(dir, "dropwatch.json"), "utf8")).items).toHaveLength(1);
  });

  it("refuses stores that ban robots, without contacting them", async () => {
    const h = harness();
    expect(await h.engine.previewProduct("https://www.pokemoncenter.com/product/x")).toMatchObject({
      kind: "restricted",
      name: "Pokemon Center",
    });
    expect(h.fetchImpl.calls).toEqual([]);
  });

  it("refuses those stores when the address is spelled with a trailing dot", async () => {
    const h = harness();
    expect(await h.engine.previewProduct("https://www.target.com./p/x")).toMatchObject({
      kind: "restricted",
      name: "Target",
    });
    expect(h.fetchImpl.calls).toEqual([]);
    expect(normalizeUrl("https://shop.test./products/etb")).toBe(URL_ETB);
    expect(normalizeUrl("https://user:pw@shop.test/products/etb")).toBe(URL_ETB);
  });

  it("refuses a link that redirects into one of those stores", async () => {
    const h = harness({
      "https://shop.test/go/etb": { status: 301, headers: { location: "https://www.walmart.com/ip/1" } },
    });
    const preview = await h.engine.previewProduct("https://shop.test/go/etb");
    expect(preview.kind === "error" && preview.message).toMatch(/doesn't allow automated checks/);
    expect(h.fetchImpl.calls.some((url) => url.includes("walmart"))).toBe(false);
  });

  it("makes a second preview of the same store wait its turn", async () => {
    const h = harness({ "https://shop.test/products/tin.js": { body: product(false) } });
    await h.engine.previewProduct(URL_ETB);
    const before = h.time();
    await h.engine.previewProduct("https://shop.test/products/tin");
    expect(h.time() - before).toBe(3000);
  });

  it("remembers the page title of a product watched by its sold-out phrase", async () => {
    const url = "https://plain.test/item/tin";
    const h = harness({
      [url]: { body: "<title>Mini Tin | Plain Store</title><h1>Mini Tin</h1><p>Sold out</p>" },
    });
    expect(await h.engine.previewProduct(url, "Sold out")).toMatchObject({
      kind: "ok",
      source: "page",
      availability: "out_of_stock",
    });
    h.engine.addProduct({ url, name: "Mini Tin" });
    expect(JSON.parse(readFileSync(join(dir, "dropwatch.json"), "utf8")).items[0]).toMatchObject({
      soldOutText: "Sold out",
      pageTitle: "Mini Tin | Plain Store",
    });

    // The store swaps the page for a waiting room: no phrase, but no product either.
    h.routes[url] = { body: "<title>You are in line</title><p>Thanks for waiting.</p>" };
    h.advance(120_000);
    await h.engine.pulse();
    expect(h.opened).toEqual([]);
    expect(h.engine.view().products[0]?.status).toBe("unknown");
  });

  it("explains a store that turns the check away", async () => {
    const h = harness({ "https://shop.test/products/etb.js": { status: 403 } });
    const preview = await h.engine.previewProduct(URL_ETB);
    expect(preview).toMatchObject({ kind: "error" });
    expect(preview.kind === "error" && preview.message).toMatch(/turns away automated checks/);
  });

  it("will not add a link it has not checked, or the same link twice", async () => {
    const h = harness();
    expect(() => h.engine.addProduct({ url: URL_ETB, name: "ETB" })).toThrow(UserError);
    await watchEtb(h);
    expect(await h.engine.previewProduct(URL_ETB)).toMatchObject({
      kind: "error",
      message: "You're already watching this product.",
    });
  });

  it("watches the selected option when the link names one", async () => {
    const h = harness();
    await h.engine.previewProduct(`${URL_ETB}?variant=11`);
    h.engine.addProduct({ url: `${URL_ETB}?variant=11`, name: "ETB" });
    expect(JSON.parse(readFileSync(join(dir, "dropwatch.json"), "utf8")).items[0].variant).toBe("11");
  });

  it("reads a web link the way people paste it", () => {
    expect(normalizeUrl("  shop.test/products/etb#reviews ")).toBe("https://shop.test/products/etb");
    expect(normalizeUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeUrl("file:///c:/x")).toBeUndefined();
    expect(normalizeUrl("not a link")).toBeUndefined();
    expect(normalizeUrl("localhost")).toBeUndefined();
  });
});

describe("watching", () => {
  it("opens the page, sounds the alarm, notifies and pushes when stock arrives", async () => {
    const h = harness();
    await watchEtb(h);
    h.engine.newNtfyTopic();
    h.routes[`${URL_ETB}.js`] = { body: product(true) };
    h.advance(31_000);
    await h.engine.pulse();

    expect(h.opened).toEqual([URL_ETB]);
    expect(h.sounds()).toBe(1);
    expect(h.notices[0]).toMatchObject({ title: "In stock: Elite Trainer Box", url: URL_ETB });
    expect(h.posts).toHaveLength(1);
    expect(JSON.parse(h.posts[0]!.body)).toMatchObject({
      topic: h.engine.view().alerts.ntfyTopic,
      title: "IN STOCK: Elite Trainer Box at $49.99",
      click: URL_ETB,
    });
    expect(h.engine.view().activity[0]).toMatchObject({ kind: "in_stock" });
  });

  it("stays quiet when the price is above the limit", async () => {
    const h = harness();
    await watchEtb(h, 40);
    h.routes[`${URL_ETB}.js`] = { body: product(true) };
    h.advance(31_000);
    await h.engine.pulse();
    expect(h.opened).toEqual([]);
    expect(h.engine.view().products[0]?.status).toBe("in_stock_over_max");
    expect(h.engine.view().activity[0]).toMatchObject({ kind: "over_max" });
  });

  it("does not check anything while paused", async () => {
    const h = harness();
    await watchEtb(h);
    h.engine.setPaused(true);
    const calls = h.fetchImpl.calls.length;
    h.advance(120_000);
    await h.engine.pulse();
    expect(h.fetchImpl.calls.length).toBe(calls);
  });

  it("logs a run of failures once and describes the problem plainly", async () => {
    const h = harness();
    await watchEtb(h);
    h.routes[`${URL_ETB}.js`] = { status: 429 };
    for (let i = 0; i < 3; i++) {
      h.advance(20 * 60_000);
      await h.engine.pulse();
    }
    const problems = h.engine.view().activity.filter((a) => a.kind === "problem");
    expect(problems).toHaveLength(1);
    expect(h.engine.view().products[0]?.problem).toBe("shop.test asked Dropwatch to slow down.");
  });

  it("keeps the watchlist across a restart", async () => {
    const h = harness();
    await watchEtb(h);
    expect(h.restart().view().products.map((p) => p.name)).toEqual(["Elite Trainer Box"]);
  });

  it("does not ask a store again after a restart while the store's refusal stands", async () => {
    const h = harness();
    await watchEtb(h);
    h.routes[`${URL_ETB}.js`] = { status: 403 };
    for (let i = 0; i < 3; i++) {
      h.advance(20 * 60_000);
      await h.engine.pulse();
    }
    expect(h.engine.view().products[0]?.stopped).toBe(true);
    h.engine.flush();

    const calls = h.fetchImpl.calls.length;
    const again = h.restart();
    expect(again.view().products[0]).toMatchObject({ stopped: true });
    expect(again.view().products[0]?.problem).toMatch(/turns away automated checks/);
    await again.pulse();
    expect(h.fetchImpl.calls.length).toBe(calls);
    expect(again.checkNow("elite-trainer-box")).toBe("waiting");
  });

  it("stops a saved link to a store that bans robots, without contacting it", async () => {
    writeFileSync(
      join(dir, "dropwatch.json"),
      JSON.stringify({
        items: [{ id: "x", name: "Hand-added", url: "https://www.target.com./p/x", source: "page" }],
        alerts: {},
      }),
      "utf8",
    );
    const h = harness();
    await h.engine.pulse();
    expect(h.fetchImpl.calls).toEqual([]);
    expect(h.engine.view().products[0]).toMatchObject({ stopped: true, url: "https://www.target.com/p/x" });
    expect(h.engine.view().products[0]?.problem).toMatch(/doesn't allow automated checks/);
  });

  it("retries Best Buy products at once when the key is changed", async () => {
    const url = "https://www.bestbuy.com/site/pokemon-etb/6606082.p";
    const key = "abcdefgh12345678";
    writeFileSync(
      join(dir, "dropwatch.json"),
      JSON.stringify({ items: [{ id: "bb", name: "ETB", url, source: "bestbuy", sku: "6606082" }], alerts: {} }),
      "utf8",
    );
    const h = harness({
      [`https://api.bestbuy.com/v1/products/6606082.json?show=sku,name,salePrice,onlineAvailability,orderable&apiKey=${key}`]:
        { body: JSON.stringify({ onlineAvailability: false }) },
    });
    await h.engine.pulse();
    expect(h.engine.view().products[0]).toMatchObject({ stopped: true });
    expect(h.engine.view().products[0]?.problem).toMatch(/Best Buy needs a key/);

    h.engine.setBestBuyKey(key);
    await h.engine.pulse();
    expect(h.engine.view().products[0]).toMatchObject({ stopped: false, status: "out_of_stock" });
    expect(h.fetchImpl.calls.every((call) => call.startsWith("https://api.bestbuy.com/"))).toBe(true);
  });

  it("leaves out saved entries it cannot understand, and keeps a copy of the list", () => {
    const saved = JSON.stringify({
      items: [
        { id: "etb", name: "ETB", url: URL_ETB, source: "shopify", maxPrice: "cheap" },
        { id: "etb", name: "Same id again", url: URL_ETB, source: "shopify" },
        { id: "bad", name: { not: "text" }, url: URL_ETB, source: "shopify" },
        null,
      ],
      reminders: [{ id: "r", name: "Drop", url: "javascript:alert(1)", at: "2027-01-01T00:00:00Z" }],
      alerts: "loud",
    });
    writeFileSync(join(dir, "dropwatch.json"), saved, "utf8");
    const h = harness();
    expect(h.engine.view().products).toHaveLength(1);
    expect(h.engine.view().products[0]?.maxPrice).toBeUndefined();
    expect(h.engine.view().reminders).toEqual([]);
    expect(h.engine.view().alerts).toMatchObject({ openBrowser: true, sound: true });
    expect(readFileSync(join(dir, "dropwatch.json.bak"), "utf8")).toBe(saved);
    expect(h.engine.view().activity[0]?.text).toMatch(/^4 saved entries could not be understood/);
  });

  it("leaves a watchlist it could not open alone instead of replacing it", () => {
    // A folder where the file should be: it exists, and it cannot be read.
    mkdirSync(join(dir, "dropwatch.json"));
    const h = harness();
    expect(h.engine.view().products).toEqual([]);
    expect(h.engine.view().activity[0]?.text).toMatch(/would not open/);
    h.engine.completeOnboarding();
    h.engine.newNtfyTopic();
    expect(statSync(join(dir, "dropwatch.json")).isDirectory()).toBe(true);
    expect(readdirSync(dir).some((f) => f.includes("unreadable"))).toBe(false);
  });

  it("starts clean and keeps the old file when the watchlist is unreadable", () => {
    writeFileSync(join(dir, "dropwatch.json"), "{oops", "utf8");
    const h = harness();
    expect(h.engine.view().products).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith("dropwatch.json.unreadable-"))).toBe(true);
    expect(existsSync(join(dir, "dropwatch.json"))).toBe(false);
  });
});

describe("explaining a refused address", () => {
  it("says a number address is not a shop's name, and a private name is inside the network", () => {
    for (const host of ["93.184.216.34", "93.184.216.34:8080", "[2606:4700::1111]"]) {
      expect(explainError("private", host), host).toMatch(/only opens shops by their web name/);
    }
    expect(explainError("private", "router.lan")).toMatch(/inside your own network/);
  });
});

describe("reminders and alert settings", () => {
  it("fires a reminder at its time, once", async () => {
    const h = harness();
    const at = new Date(Date.parse("2026-11-14T08:05:00Z")).toISOString();
    h.engine.addReminder({ name: "Pokemon Center drop", url: "pokemoncenter.com", at });
    await h.engine.pulse();
    expect(h.opened).toEqual([]);
    h.advance(5 * 60_000 + 1000);
    await h.engine.pulse();
    await h.engine.pulse();
    expect(h.opened).toEqual(["https://pokemoncenter.com/"]);
    expect(h.notices[0]?.title).toBe("Drop time: Pokemon Center drop");
    expect(h.engine.view().reminders[0]?.done).toBe(true);
  });

  it("fires a reminder even when the list cannot be saved, and says so once", async () => {
    const h = harness();
    h.engine.addReminder({ name: "Drop", url: "https://www.target.com/", at: "2026-11-14T08:05:00Z" });
    // A folder in the way of the file the list is written through.
    mkdirSync(join(dir, "dropwatch.json.tmp"));
    h.advance(5 * 60_000 + 1000);
    await h.engine.pulse();
    await h.engine.pulse();
    expect(h.opened).toEqual(["https://www.target.com/"]);
    expect(h.sounds()).toBe(1);
    const problems = h.engine.view().activity.filter((a) => a.kind === "problem");
    expect(problems.map((p) => p.text)).toEqual([
      "Your changes could not be saved to this computer. Dropwatch will keep trying.",
    ]);

    rmSync(join(dir, "dropwatch.json.tmp"), { recursive: true });
    h.advance(31_000);
    await h.engine.pulse();
    expect(JSON.parse(readFileSync(join(dir, "dropwatch.json"), "utf8")).reminders[0].done).toBe(true);
  });

  it("writes the activity log on the next try when a write fails", () => {
    const h = harness();
    const saved = () => readFileSync(join(dir, "activity.json"), "utf8");
    h.engine.setPaused(true);
    // A folder in the way of the file the log is written through.
    mkdirSync(join(dir, "activity.json.tmp"));
    h.engine.flush();
    expect(existsSync(join(dir, "activity.json"))).toBe(false);

    rmSync(join(dir, "activity.json.tmp"), { recursive: true });
    // The same call the app makes when Windows signs out.
    h.engine.close();
    expect(saved()).toContain("Paused watching.");
  });

  it("reports a reminder it was not running for instead of firing it late", async () => {
    const h = harness();
    h.engine.addReminder({
      name: "Drop",
      url: "https://www.target.com/",
      at: "2026-11-14T08:05:00Z",
    });
    h.advance(2 * 60 * 60_000);
    await h.engine.pulse();
    expect(h.opened).toEqual([]);
    expect(h.engine.view().activity[0]?.text).toMatch(/^Missed this reminder/);
  });

  it("rejects a reminder in the past and a link that is not a web link", () => {
    const h = harness();
    expect(() =>
      h.engine.addReminder({ name: "x", url: "https://a.test/", at: "2020-01-01T00:00:00Z" }),
    ).toThrow(/already passed/);
    expect(() =>
      h.engine.addReminder({ name: "x", url: "javascript:1", at: "2027-01-01T00:00:00Z" }),
    ).toThrow(UserError);
  });

  it("reports which test alerts went out and which failed", async () => {
    const h = harness();
    h.engine.newNtfyTopic();
    expect(h.engine.view().alerts.ntfyTopic).toMatch(/^dropwatch-[a-z2-9]{10}$/);
    expect(await h.engine.testAlert()).toEqual({
      sent: ["alarm sound", "desktop notification", "phone"],
      failures: [],
    });
    h.failPosts();
    const failed = await h.engine.testAlert();
    expect(failed.sent).toEqual(["alarm sound", "desktop notification"]);
    expect(failed.failures).toEqual(["Phone alert failed: answered 500"]);
    expect(h.opened).toEqual([]);
  });

  it("accepts only real Discord webhook links", () => {
    const h = harness();
    expect(() => h.engine.updateAlerts({ discordWebhook: "https://evil.test/hook" })).toThrow(UserError);
    h.engine.updateAlerts({ discordWebhook: "https://discord.com/api/webhooks/123/abc-DEF_1" });
    expect(h.engine.view().alerts.discordWebhook).toBeDefined();
    h.engine.updateAlerts({ discordWebhook: "" });
    expect(h.engine.view().alerts.discordWebhook).toBeUndefined();
  });
});
