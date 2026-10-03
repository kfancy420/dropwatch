import { describe, expect, it } from "vitest";

import { SourceError } from "../src/http.js";
import { intervalMs, Monitor, type MonitorDeps, type SavedItemState } from "../src/monitor.js";
import type { CheckResult, WatchItem } from "../src/types.js";

const item = (over: Partial<WatchItem> = {}): WatchItem => ({
  id: "etb",
  name: "ETB",
  url: "https://shop.test/products/etb",
  source: "shopify",
  ...over,
});

/** Fake clock: sleep advances time instantly. Results are served in order. */
function harness(
  items: WatchItem[],
  script: Array<CheckResult | Error>,
  saved?: Record<string, SavedItemState>,
) {
  let now = 0;
  const alerts: string[] = [];
  const logs: string[] = [];
  const checkTimes: number[] = [];
  const deps: MonitorDeps = {
    check: async () => {
      checkTimes.push(now);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
    alert: async (i) => void alerts.push(i.id),
    log: (line) => void logs.push(line),
    now: () => now,
    sleep: async (ms) => void (now += ms),
    random: () => 0.5,
  };
  const monitor = new Monitor(items, deps, saved);
  const step = async () => {
    const wait = await monitor.tick();
    if (wait !== Infinity) now += wait;
    return wait;
  };
  const advance = (ms: number) => void (now += ms);
  return { monitor, step, advance, alerts, logs, checkTimes, time: () => now };
}

const out: CheckResult = { availability: "out_of_stock" };
const inStock: CheckResult = { availability: "in_stock", price: 49.99 };

describe("Monitor", () => {
  it("alerts once when an item comes into stock, and again after it sells out and returns", async () => {
    const h = harness([item()], [out, inStock, inStock, out, inStock]);
    for (let i = 0; i < 5; i++) await h.step();
    expect(h.alerts).toEqual(["etb", "etb"]);
  });

  it("alerts on the first check when the item is already in stock", async () => {
    const h = harness([item()], [inStock]);
    await h.step();
    expect(h.alerts).toEqual(["etb"]);
  });

  it("does not alert above the max price, and alerts when the price comes down", async () => {
    const h = harness(
      [item({ maxPrice: 60 })],
      [{ availability: "in_stock", price: 120 }, { availability: "in_stock", price: 55 }],
    );
    await h.step();
    expect(h.alerts).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/above your max/);
    await h.step();
    expect(h.alerts).toEqual(["etb"]);
  });

  it("waits the item interval between checks", async () => {
    const h = harness([item({ intervalSec: 40 })], [out, out]);
    await h.step();
    await h.step();
    expect(h.checkTimes).toEqual([0, 40_000]);
  });

  it("clamps intervals to the floor", () => {
    expect(intervalMs(item({ intervalSec: 1 }))).toBe(15_000);
    expect(intervalMs(item())).toBe(30_000);
  });

  it("backs off further on each rate limit and honors Retry-After", async () => {
    const limited = new SourceError("rate_limited", "slow down");
    const h = harness(
      [item()],
      [limited, limited, new SourceError("rate_limited", "slow down", 600), out],
    );
    for (let i = 0; i < 4; i++) await h.step();
    expect(h.checkTimes).toEqual([0, 60_000, 180_000, 780_000]);
  });

  it("stops watching a site that keeps refusing, and tells the user why", async () => {
    const blocked = new SourceError("blocked", "shop.test refused the request (403)");
    const h = harness([item()], [blocked, blocked, blocked]);
    await h.step();
    await h.step();
    expect(await h.step()).toBe(Infinity);
    expect(h.monitor.activeCount()).toBe(0);
    expect(h.logs.at(-1)).toMatch(/stopped watching.*notify-me/);
  });

  it("stops at once when robots.txt disallows the page", async () => {
    const h = harness([item()], [new SourceError("robots", "disallowed by robots.txt")]);
    expect(await h.step()).toBe(Infinity);
    expect(h.monitor.activeCount()).toBe(0);
  });

  it("keeps its schedule when an alert channel throws", async () => {
    let now = 0;
    const logs: string[] = [];
    const monitor = new Monitor([item()], {
      check: async () => inStock,
      alert: async () => {
        throw new Error("disk full");
      },
      log: (line) => void logs.push(line),
      now: () => now,
      sleep: async (ms) => void (now += ms),
      random: () => 0.5,
    });
    expect(await monitor.tick()).toBe(30_000);
    expect(logs.at(-1)).toBe("alert failed: disk full");
  });

  it("spaces requests to the same host", async () => {
    const h = harness(
      [item(), item({ id: "tin", url: "https://shop.test/products/tin" })],
      [out, out],
    );
    await h.step();
    expect(h.checkTimes).toEqual([0, 3000]);
  });
});

describe("Monitor with a changing watchlist", () => {
  const tin = item({ id: "tin", url: "https://other.test/products/tin" });

  it("checks a newly added item at once and forgets a removed one", async () => {
    const h = harness([item()], [out, out]);
    await h.monitor.tick();
    h.monitor.setItems([item(), tin]);
    await h.monitor.tick();
    expect(h.checkTimes).toHaveLength(2);
    h.monitor.setItems([tin]);
    expect(h.monitor.snapshot().map((s) => s.id)).toEqual(["tin"]);
  });

  it("reports status, price and problems in the snapshot", async () => {
    const h = harness([item()], [inStock, new SourceError("rate_limited", "slow down")]);
    await h.step();
    expect(h.monitor.snapshot()[0]).toMatchObject({ status: "buyable", price: 49.99, stopped: false });
    await h.step();
    expect(h.monitor.snapshot()[0]).toMatchObject({ status: "buyable", error: "slow down" });
  });

  it("restarts a stopped item on request, but ignores rapid repeat requests", async () => {
    const h = harness([item()], [new SourceError("robots", "disallowed"), out]);
    await h.monitor.tick();
    expect(h.monitor.snapshot()[0]?.stopped).toBe(true);
    h.advance(14_000);
    expect(h.monitor.checkNow("etb")).toBe("too_soon");
    expect(h.monitor.snapshot()[0]?.stopped).toBe(true);
    h.advance(1000);
    expect(h.monitor.checkNow("etb")).toBe("queued");
    await h.monitor.tick();
    expect(h.monitor.snapshot()[0]).toMatchObject({ stopped: false, status: "out_of_stock" });
  });

  it("does not let a request by hand shorten a wait the site asked for", async () => {
    const h = harness([item()], [new SourceError("rate_limited", "slow down", 600), out]);
    await h.monitor.tick();
    h.advance(60_000);
    expect(h.monitor.checkNow("etb")).toBe("waiting");
    await h.monitor.tick();
    expect(h.checkTimes).toEqual([0]);
    h.advance(540_000);
    expect(h.monitor.checkNow("etb")).toBe("queued");
    await h.monitor.tick();
    expect(h.checkTimes).toEqual([0, 600_000]);
  });

  it("makes a refusing site wait 15 minutes for a retry, and stops again on the next refusal", async () => {
    const blocked = new SourceError("blocked", "refused (403)");
    const h = harness([item()], [blocked, blocked, blocked, blocked]);
    for (let i = 0; i < 3; i++) await h.step();
    expect(h.monitor.snapshot()[0]?.stopped).toBe(true);
    const stoppedAt = h.time();

    h.advance(60_000);
    expect(h.monitor.checkNow("etb")).toBe("waiting");
    expect(h.monitor.snapshot()[0]?.stopped).toBe(true);

    h.advance(14 * 60_000);
    expect(h.monitor.checkNow("etb")).toBe("queued");
    await h.monitor.tick();
    expect(h.checkTimes.at(-1)).toBe(stoppedAt + 15 * 60_000);
    expect(h.checkTimes).toHaveLength(4);
    expect(h.monitor.snapshot()[0]?.stopped).toBe(true);
  });

  it("remembers across a restart what a site refused", async () => {
    const blocked = new SourceError("blocked", "refused (403)");
    const first = harness([item()], [blocked, blocked, blocked]);
    for (let i = 0; i < 3; i++) await first.step();
    const saved = first.monitor.troubled();
    expect(saved.etb).toMatchObject({ stopped: true, failures: 3, errorKind: "blocked" });

    const second = harness([item()], [out], saved);
    expect(await second.monitor.tick()).toBe(Infinity);
    expect(second.checkTimes).toEqual([]);
    expect(second.monitor.snapshot()[0]).toMatchObject({ stopped: true, errorKind: "blocked" });
  });

  it("keeps a slow-down wait across a restart, and forgets items that are fine", async () => {
    const first = harness(
      [item(), item({ id: "tin", url: "https://other.test/products/tin" })],
      [new SourceError("rate_limited", "slow down", 600), out],
    );
    await first.monitor.tick();
    const saved = first.monitor.troubled();
    expect(Object.keys(saved)).toEqual(["etb"]);

    const second = harness([item()], [out], saved);
    await second.monitor.tick();
    expect(second.checkTimes).toEqual([]);
    second.advance(600_000);
    await second.monitor.tick();
    expect(second.checkTimes).toEqual([600_000]);
  });

  it("makes a preview wait its turn behind a check of the same store", async () => {
    const h = harness([item()], [out]);
    await h.monitor.tick();
    await h.monitor.reserveHost("shop.test");
    expect(h.time()).toBe(3000);
    await h.monitor.reserveHost("other.test");
    expect(h.time()).toBe(3000);
  });

  it("starts a product afresh when its cause of trouble was fixed", async () => {
    const h = harness([item()], [new SourceError("config", "no key"), out]);
    await h.monitor.tick();
    expect(h.monitor.snapshot()[0]?.stopped).toBe(true);
    h.monitor.restart(["etb"]);
    await h.monitor.tick();
    expect(h.monitor.snapshot()[0]).toMatchObject({ stopped: false, status: "out_of_stock" });
  });

  it("takes a known result for a new item without fetching or alerting", async () => {
    const h = harness([item()], [out]);
    h.monitor.prime("etb", inStock);
    expect(await h.monitor.tick()).toBe(30_000);
    expect(h.checkTimes).toEqual([]);
    expect(h.alerts).toEqual([]);
    expect(h.monitor.snapshot()[0]).toMatchObject({ status: "buyable", price: 49.99 });
  });
});
