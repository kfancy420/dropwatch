import { beforeEach, describe, expect, it } from "vitest";

import { SourceError } from "../src/http.js";
import { assertRobotsAllowed, clearRobotsCache, isAllowed } from "../src/robots.js";
import { fakeFetch } from "./helpers.js";

describe("isAllowed", () => {
  it("allows everything when robots.txt is empty", () => {
    expect(isAllowed("", "/products/etb")).toBe(true);
  });

  it("applies the * group", () => {
    const robots = "User-agent: *\nDisallow: /cart\nDisallow: /checkout";
    expect(isAllowed(robots, "/cart")).toBe(false);
    expect(isAllowed(robots, "/products/etb.js")).toBe(true);
  });

  it("prefers the dropwatch group over *", () => {
    const robots = "User-agent: *\nAllow: /\n\nUser-agent: dropwatch\nDisallow: /";
    expect(isAllowed(robots, "/products/etb")).toBe(false);
  });

  it("lets the longest rule win and Allow win ties", () => {
    const robots = "User-agent: *\nDisallow: /products\nAllow: /products/public";
    expect(isAllowed(robots, "/products/public/etb")).toBe(true);
    expect(isAllowed(robots, "/products/private")).toBe(false);
  });

  it("supports * and $ in patterns", () => {
    const robots = "User-agent: *\nDisallow: /*.json$\nDisallow: /*?variant=";
    expect(isAllowed(robots, "/products/etb.json")).toBe(false);
    expect(isAllowed(robots, "/products/etb.js")).toBe(true);
    expect(isAllowed(robots, "/products/etb?variant=1")).toBe(false);
  });

  it("shares rules across stacked user-agent lines", () => {
    const robots = "User-agent: googlebot\nUser-agent: *\nDisallow: /private";
    expect(isAllowed(robots, "/private/x")).toBe(false);
  });

  it("treats an empty Disallow as allow-all", () => {
    expect(isAllowed("User-agent: *\nDisallow:", "/anything")).toBe(true);
  });
});

describe("assertRobotsAllowed", () => {
  beforeEach(() => clearRobotsCache());

  it("throws a robots error for a disallowed path", async () => {
    const fetchImpl = fakeFetch({
      "https://shop.test/robots.txt": { body: "User-agent: *\nDisallow: /products" },
    });
    await expect(
      assertRobotsAllowed("https://shop.test/products/etb", fetchImpl),
    ).rejects.toMatchObject({ kind: "robots" });
  });

  it("treats a missing robots.txt as allowed and caches per origin", async () => {
    const fetchImpl = fakeFetch({});
    await assertRobotsAllowed("https://shop.test/products/a", fetchImpl);
    await assertRobotsAllowed("https://shop.test/products/b", fetchImpl);
    expect(fetchImpl.calls).toEqual(["https://shop.test/robots.txt"]);
  });

  it("does not proceed when robots.txt itself is refused", async () => {
    const fetchImpl = fakeFetch({ "https://shop.test/robots.txt": { status: 403 } });
    await expect(
      assertRobotsAllowed("https://shop.test/products/a", fetchImpl),
    ).rejects.toBeInstanceOf(SourceError);
  });
});
