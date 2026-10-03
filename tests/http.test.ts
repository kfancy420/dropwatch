import { beforeEach, describe, expect, it } from "vitest";

import { politeGet } from "../src/http.js";
import { refusedHost, restrictedRetailer } from "../src/retailers.js";
import { clearRobotsCache, getAllowed } from "../src/robots.js";
import { fakeFetch } from "./helpers.js";

const PAGE = "https://shop.test/products/etb";
const to = (location: string) => ({ status: 302, headers: { location } });

describe("politeGet", () => {
  it("follows a redirect and returns the page it leads to", async () => {
    const fetchImpl = fakeFetch({
      [PAGE]: to("/products/etb-2"),
      "https://shop.test/products/etb-2": { body: "moved here" },
    });
    expect(await politeGet(PAGE, fetchImpl)).toBe("moved here");
  });

  it("will not follow a redirect into a store that bans robots", async () => {
    const fetchImpl = fakeFetch({ [PAGE]: to("https://www.target.com/p/etb") });
    await expect(politeGet(PAGE, fetchImpl)).rejects.toMatchObject({ kind: "restricted" });
    expect(fetchImpl.calls).toEqual([PAGE]);
  });

  it("refuses those stores however the address is spelled, without contacting them", async () => {
    const fetchImpl = fakeFetch({});
    for (const url of [
      "https://www.target.com/p/etb",
      "https://www.target.com./p/etb",
      "https://WWW.Walmart.com/ip/1",
      "https://a.co/d/abc",
      "https://www.bestbuy.com/site/etb/1.p",
    ]) {
      await expect(politeGet(url, fetchImpl)).rejects.toMatchObject({ kind: "restricted" });
    }
    expect(fetchImpl.calls).toEqual([]);
  });

  it("allows Best Buy's API and nothing else of Best Buy", () => {
    expect(refusedHost("api.bestbuy.com")).toBeUndefined();
    expect(refusedHost("www.bestbuy.com")).toBe("Best Buy");
    expect(refusedHost("shop.test")).toBeUndefined();
    expect(restrictedRetailer("www.pokemoncenter.com.")?.name).toBe("Pokemon Center");
  });

  it("will not be sent from the internet to this computer or the home network", async () => {
    for (const target of ["http://127.0.0.1:8080/admin", "http://192.168.1.1/", "http://localhost/"]) {
      const fetchImpl = fakeFetch({ [PAGE]: to(target) });
      await expect(politeGet(PAGE, fetchImpl)).rejects.toMatchObject({ kind: "bad_response" });
      expect(fetchImpl.calls).toEqual([PAGE]);
    }
  });

  it("gives up on a redirect loop", async () => {
    const fetchImpl = fakeFetch({ [PAGE]: to(PAGE) });
    await expect(politeGet(PAGE, fetchImpl)).rejects.toThrow(/redirects too many times/);
    expect(fetchImpl.calls).toHaveLength(6);
  });

  it("stops reading an answer that is far too large", async () => {
    const body = "x".repeat(5000);
    for (const chunked of [false, true]) {
      const fetchImpl = fakeFetch({ [PAGE]: { body, chunked } });
      await expect(politeGet(PAGE, fetchImpl, { maxBytes: 1000 })).rejects.toMatchObject({
        kind: "bad_response",
      });
      expect(await politeGet(PAGE, fetchImpl, { maxBytes: 1000, truncate: true })).toBe(
        body.slice(0, 1000),
      );
      expect(await politeGet(PAGE, fetchImpl)).toBe(body);
    }
  });

  it("reads Retry-After as seconds or as a date", async () => {
    const seconds = fakeFetch({ [PAGE]: { status: 429, headers: { "retry-after": "120" } } });
    await expect(politeGet(PAGE, seconds)).rejects.toMatchObject({ retryAfterSec: 120 });

    const date = new Date(Date.now() + 10 * 60_000).toUTCString();
    const dated = fakeFetch({ [PAGE]: { status: 429, headers: { "retry-after": date } } });
    const err = (await politeGet(PAGE, dated).catch((e: unknown) => e)) as { retryAfterSec?: number };
    expect(err.retryAfterSec).toBeGreaterThan(590);
    expect(err.retryAfterSec).toBeLessThanOrEqual(600);
  });
});

describe("getAllowed", () => {
  beforeEach(() => clearRobotsCache());

  it("checks the robots.txt of every address a redirect leads to", async () => {
    const fetchImpl = fakeFetch({
      "https://shop.test/robots.txt": { body: "" },
      [PAGE]: to("https://other.test/private/etb"),
      "https://other.test/robots.txt": { body: "User-agent: *\nDisallow: /private" },
      "https://other.test/private/etb": { body: "secret" },
    });
    await expect(getAllowed(PAGE, fetchImpl)).rejects.toMatchObject({ kind: "robots" });
    expect(fetchImpl.calls).not.toContain("https://other.test/private/etb");
  });
});
