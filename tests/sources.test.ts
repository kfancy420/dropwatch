import { beforeEach, describe, expect, it } from "vitest";

import { clearRobotsCache } from "../src/robots.js";
import { parseProductPage } from "../src/sources/page.js";
import { checkShopify, parseShopifyProduct, shopifyJsonUrl } from "../src/sources/shopify.js";
import type { WatchItem } from "../src/types.js";
import { fakeFetch } from "./helpers.js";

const product = (available: boolean) =>
  JSON.stringify({
    title: "Elite Trainer Box",
    available,
    price: 4999,
    variants: [
      { id: 11, title: "Default", available, price: 4999 },
      { id: 22, title: "Case", available: false, price: 49999 },
    ],
  });

describe("shopify", () => {
  beforeEach(() => clearRobotsCache());

  it("builds the .js URL from any product URL shape", () => {
    expect(shopifyJsonUrl("https://shop.test/products/etb")).toBe(
      "https://shop.test/products/etb.js",
    );
    expect(
      shopifyJsonUrl("https://shop.test/collections/pokemon/products/etb?variant=11"),
    ).toBe("https://shop.test/products/etb.js");
    expect(shopifyJsonUrl("https://shop.test/pages/about")).toBeUndefined();
  });

  it("reports stock and converts cents to dollars", () => {
    expect(parseShopifyProduct(product(true))).toEqual({
      availability: "in_stock",
      price: 49.99,
      title: "Elite Trainer Box",
    });
    expect(parseShopifyProduct(product(false)).availability).toBe("out_of_stock");
  });

  it("watches one variant when asked", () => {
    expect(parseShopifyProduct(product(true), "22").availability).toBe("out_of_stock");
  });

  it("watches every option when the one it was given is gone from the shop", () => {
    expect(parseShopifyProduct(product(true), "99").availability).toBe("in_stock");
  });

  it("ignores fields that are not what a shop should send", () => {
    const odd = JSON.stringify({ title: { evil: true }, available: true, price: "free", variants: [null, 7] });
    expect(parseShopifyProduct(odd)).toEqual({ availability: "in_stock", price: undefined, title: undefined });
  });

  it("rejects a body that is not product JSON", () => {
    expect(() => parseShopifyProduct("<html>")).toThrow(/product JSON/);
  });

  it("checks robots.txt before fetching the product", async () => {
    const item: WatchItem = {
      id: "etb",
      name: "ETB",
      url: "https://shop.test/products/etb",
      source: "shopify",
    };
    const fetchImpl = fakeFetch({
      "https://shop.test/robots.txt": { body: "User-agent: *\nDisallow: /cart" },
      "https://shop.test/products/etb.js": { body: product(true) },
    });
    expect((await checkShopify(item, fetchImpl)).availability).toBe("in_stock");
    expect(fetchImpl.calls).toEqual([
      "https://shop.test/robots.txt",
      "https://shop.test/products/etb.js",
    ]);
  });
});

const ld = (data: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head></html>`;

describe("generic page", () => {
  it("reads schema.org availability from JSON-LD", () => {
    const html = ld({
      "@type": "Product",
      name: "Booster Bundle",
      offers: { "@type": "Offer", availability: "https://schema.org/InStock", price: "26.94" },
    });
    expect(parseProductPage(html)).toMatchObject({
      availability: "in_stock",
      price: 26.94,
      title: "Booster Bundle",
    });
  });

  it("reports out of stock only when every offer says so", () => {
    const offers = (a: string, b: string) =>
      ld({
        "@graph": [
          { "@type": "WebPage" },
          {
            "@type": ["Product"],
            name: "Tin",
            offers: [
              { availability: `http://schema.org/${a}`, price: 20 },
              { availability: `http://schema.org/${b}`, price: 25 },
            ],
          },
        ],
      });
    expect(parseProductPage(offers("OutOfStock", "OutOfStock")).availability).toBe("out_of_stock");
    expect(parseProductPage(offers("OutOfStock", "InStock"))).toMatchObject({
      availability: "in_stock",
      price: 25,
    });
  });

  it("reads the variants of a ProductGroup, where any variant in stock counts", () => {
    const html = ld({
      "@type": "ProductGroup",
      name: "Booster Pack",
      hasVariant: [
        { "@type": "Product", name: "Booster Pack - Single", offers: { availability: "http://schema.org/OutOfStock", price: "5.00" } },
        { "@type": "Product", name: "Booster Pack - Box", offers: { availability: "http://schema.org/InStock", price: "115.99" } },
      ],
    });
    expect(parseProductPage(html)).toMatchObject({
      availability: "in_stock",
      price: 115.99,
      title: "Booster Pack",
    });
  });

  it("looks inside AggregateOffer and treats pre-order as buyable", () => {
    const html = ld({
      "@type": "Product",
      offers: { "@type": "AggregateOffer", offers: [{ availability: "PreOrder", price: 55 }] },
    });
    expect(parseProductPage(html).availability).toBe("in_stock");
  });

  it("falls back to the sold-out phrase, then to unknown", () => {
    expect(parseProductPage("<p>SOLD OUT</p>", "sold out").availability).toBe("out_of_stock");
    expect(parseProductPage("<button>Add to cart</button>", "sold out").availability).toBe(
      "in_stock",
    );
    expect(parseProductPage("<p>hello</p>").availability).toBe("unknown");
  });

  it("looks for the sold-out phrase only in words a visitor can see", () => {
    const hidden = `<title>Mini Tin</title><script>var labels = { soldOut: "Sold out" };</script>
      <style>.sold-out { color: red }</style><!-- sold out --><button>Add to cart</button>`;
    expect(parseProductPage(hidden, "sold out").availability).toBe("in_stock");
    const shown = `<title>Mini Tin</title><button disabled>Sold&nbsp;out</button>`;
    expect(parseProductPage(shown, "sold out").availability).toBe("out_of_stock");
  });

  it("does not read a maintenance page or a waiting room as in stock", () => {
    const title = "Mini Tin | Pretend Store";
    const product = `<title>${title}</title><h1>Mini Tin</h1><button>Add to cart</button>`;
    expect(parseProductPage(product, "sold out", title)).toMatchObject({ availability: "in_stock", title });
    const queue = "<title>You are in line</title><p>Thanks for waiting. Pretend Store is busy.</p>";
    expect(parseProductPage(queue, "sold out", title)).toMatchObject({
      availability: "unknown",
      detail: "the page no longer looks like the product page",
    });
  });

  it("reads a large hostile page quickly", () => {
    const html = "<script".repeat(200_000) + "<!--".repeat(200_000) + "<title".repeat(200_000);
    const started = performance.now();
    expect(parseProductPage(html, "sold out").availability).toBe("in_stock");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("skips malformed JSON-LD blocks", () => {
    const html = `<script type="application/ld+json">{oops</script>${ld({
      "@type": "Product",
      offers: { availability: "OutOfStock" },
    })}`;
    expect(parseProductPage(html).availability).toBe("out_of_stock");
  });
});
