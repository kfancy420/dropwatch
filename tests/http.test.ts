import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { guardedFetch, isPrivateAddress, PrivateAddressError, publicOnly } from "../src/guard.js";
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
    for (const target of [
      "http://127.0.0.1:8080/admin",
      "http://192.168.1.1/",
      "http://localhost/",
      "http://router.lan/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:192.168.1.1]:8080/",
      "http://[::]/",
      "http://[fe90::1]/",
      "http://0.0.0.0/",
      "http://100.64.0.1/",
      "http://2130706433/",
    ]) {
      const fetchImpl = fakeFetch({ [PAGE]: to(target) });
      await expect(politeGet(PAGE, fetchImpl)).rejects.toMatchObject({ kind: "private" });
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

/** A stand-in for DNS that answers every name with one address. */
function resolver(...addresses: string[]): LookupFunction & { names: string[] } {
  const names: string[] = [];
  const found = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const lookup = ((hostname, options, callback) => {
    names.push(hostname);
    if (options.all) callback(null, found);
    else callback(null, found[0]!.address, found[0]!.family);
  }) as LookupFunction;
  return Object.assign(lookup, { names });
}

describe("the private-address guard", () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("local page");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => void server.close());

  it("knows which addresses are private", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "::1",
      "::",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
      "febf::1",
      "fec0::1",
      "64:ff9b::7f00:1",
      "64:ff9b::192.168.1.1",
      "64:ff9b:1::1",
      "2002:7f00:1::1",
      "2001:0:abcd::1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "172.32.0.1",
      "192.167.1.1",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
      "64:ff9b::8.8.8.8",
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("lets a name through only when every address behind it is public", () => {
    const outcome = (lookup: LookupFunction, all: boolean) => {
      let error: Error | null = new Error("never answered");
      publicOnly(lookup)("shop.test", { all }, (err) => void (error = err));
      return error;
    };
    for (const all of [false, true]) {
      expect(outcome(resolver("93.184.216.34"), all)).toBeNull();
      expect(outcome(resolver("192.168.1.1"), all)).toBeInstanceOf(PrivateAddressError);
      expect(outcome(resolver("::ffff:127.0.0.1"), all)).toBeInstanceOf(PrivateAddressError);
    }
    expect(outcome(resolver("93.184.216.34", "10.0.0.5"), true)).toBeInstanceOf(PrivateAddressError);
  });

  it("refuses a public-looking name that leads to this computer", async () => {
    hits = 0;
    for (const scheme of ["http", "https"]) {
      const lookup = resolver("127.0.0.1");
      await expect(
        politeGet(`${scheme}://shop.test:${port}/item`, guardedFetch({ resolve: lookup })),
      ).rejects.toMatchObject({ kind: "private" });
      expect(lookup.names).toContain("shop.test");
    }
    expect(hits).toBe(0);
  });

  it("refuses a private address even when it is typed in as one", async () => {
    hits = 0;
    for (const url of [
      `http://127.0.0.1:${port}/item`,
      `http://localhost:${port}/item`,
      `http://[::ffff:127.0.0.1]:${port}/item`,
      "http://192.168.1.1/",
      "http://router.lan/",
    ]) {
      await expect(politeGet(url), url).rejects.toMatchObject({ kind: "private" });
      // Asked directly, with nothing in front of it to check the address first.
      await expect(guardedFetch()(url), url).rejects.toThrow();
    }
    expect(hits).toBe(0);
  });

  it("lets the app's own tests reach a pretend shop on this computer, and nothing else private", async () => {
    hits = 0;
    const lookup = resolver("127.0.0.1");
    const testFetch = guardedFetch({ allowLoopback: true, resolve: lookup });
    expect(await politeGet(`http://127.0.0.1:${port}/item`, testFetch)).toBe("local page");
    expect(hits).toBe(1);
    for (const url of ["http://192.168.1.1/", "http://router.lan/", `http://shop.test:${port}/item`]) {
      await expect(politeGet(url, testFetch), url).rejects.toMatchObject({ kind: "private" });
    }
    expect(hits).toBe(1);
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
