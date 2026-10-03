import { describe, expect, it } from "vitest";

import { alertText, openInBrowser, sendAlerts, type AlertDeps } from "../src/alerts.js";
import type { WatchItem } from "../src/types.js";

const item: WatchItem = {
  id: "etb",
  name: "Pokémon ETB",
  url: "https://shop.test/products/etb?a=1&b=2",
  source: "shopify",
};

function deps(platform: NodeJS.Platform = "win32", failPosts = false) {
  const spawned: Array<[string, string[]]> = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  const logs: string[] = [];
  const d: AlertDeps = {
    post: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return failPosts ? { ok: false, status: 500 } : { ok: true, status: 200 };
    },
    spawn: (command, args) => void spawned.push([command, args]),
    log: (line) => void logs.push(line),
    platform,
    bell: () => {},
  };
  return { d, spawned, posts, logs };
}

describe("alerts", () => {
  it("opens the product URL without going through a shell", () => {
    const { d, spawned } = deps("win32");
    openInBrowser(item.url, d);
    expect(spawned).toEqual([["rundll32", ["url.dll,FileProtocolHandler", item.url]]]);
  });

  it("refuses to open anything that is not a web address", () => {
    const { d, spawned } = deps();
    openInBrowser("file:///C:/Windows/System32/calc.exe", d);
    openInBrowser("not a url", d);
    expect(spawned).toEqual([]);
  });

  it("sends every configured channel", async () => {
    const { d, spawned, posts } = deps("darwin");
    await sendAlerts(
      {
        openBrowser: true,
        sound: true,
        ntfyTopic: "my-topic",
        discordWebhook: "https://discord.com/api/webhooks/1/abc",
      },
      { text: alertText(item, { availability: "in_stock", price: 49.99 }), url: item.url },
      d,
    );
    expect(spawned.map(([c]) => c)).toEqual(["open", "afplay"]);
    expect(posts[0]).toEqual({
      url: "https://ntfy.sh",
      body: {
        topic: "my-topic",
        title: "IN STOCK: Pokémon ETB at $49.99",
        message: item.url,
        priority: 5,
        click: item.url,
        tags: ["rotating_light"],
      },
    });
    expect(posts[1]?.body).toEqual({
      content: `IN STOCK: Pokémon ETB at $49.99\n${item.url}`,
      // A product name comes from a web page; it must not be able to ping a channel.
      allowed_mentions: { parse: [] },
    });
  });

  it("still opens the browser when a push fails, and reports the failure", async () => {
    const { d, spawned, logs } = deps("win32", true);
    await sendAlerts(
      { openBrowser: true, sound: false, ntfyTopic: "my-topic" },
      { text: alertText(item, { availability: "in_stock" }), url: item.url },
      d,
    );
    expect(spawned).toHaveLength(1);
    expect(logs).toEqual(["ntfy alert failed: answered 500"]);
  });
});
