// Shopify storefronts publish each product as JSON at /products/<handle>.js.
// Many card shops run on Shopify, so this covers most local game stores.

import { SourceError } from "../http.js";
import { getAllowed } from "../robots.js";
import type { CheckResult, FetchLike, WatchItem } from "../types.js";

interface ShopifyVariant {
  id?: unknown;
  available?: unknown;
  price?: unknown;
}

interface ShopifyProduct {
  title?: unknown;
  available?: unknown;
  price?: unknown;
  variants?: ShopifyVariant[];
}

/** https://shop/collections/x/products/handle?variant=1 -> https://shop/products/handle.js */
export function shopifyJsonUrl(productUrl: string): string | undefined {
  const u = new URL(productUrl);
  const match = u.pathname.match(/\/products\/([^/]+?)(?:\.js|\.json)?\/?$/);
  if (!match) return undefined;
  return `${u.origin}/products/${match[1]}.js`;
}

export function parseShopifyProduct(
  body: string,
  variant?: string,
): CheckResult {
  let product: ShopifyProduct;
  try {
    product = JSON.parse(body) as ShopifyProduct;
  } catch {
    throw new SourceError("bad_response", "the shop did not return product JSON");
  }
  if (!product || !Array.isArray(product.variants)) {
    throw new SourceError("bad_response", "the product JSON has no variants");
  }
  // The answer is the shop's text, so nothing in it is trusted to be the right type.
  const variants = product.variants.filter((v) => v !== null && typeof v === "object");
  const title = typeof product.title === "string" ? product.title.slice(0, 200) : undefined;
  // Shopify .js prices are integer cents.
  const dollars = (cents: unknown) =>
    typeof cents === "number" && Number.isFinite(cents) && cents > 0 ? cents / 100 : undefined;

  // Shops often recreate a variant when they restock, which gives it a new
  // id. When the one being watched is gone, watch the whole product.
  const v = variant ? variants.find((x) => String(x.id) === variant) : undefined;
  if (v) {
    return {
      availability: v.available === true ? "in_stock" : "out_of_stock",
      price: dollars(v.price),
      title,
    };
  }
  const open = variants.filter((x) => x.available === true);
  const available = typeof product.available === "boolean" ? product.available : open.length > 0;
  return {
    availability: available ? "in_stock" : "out_of_stock",
    price: dollars(open[0]?.price ?? product.price),
    title,
  };
}

export async function checkShopify(
  item: WatchItem,
  fetchImpl?: FetchLike,
): Promise<CheckResult> {
  const jsonUrl = shopifyJsonUrl(item.url);
  if (!jsonUrl) {
    throw new SourceError("config", `${item.url} is not a Shopify product URL`);
  }
  return parseShopifyProduct(await getAllowed(jsonUrl, fetchImpl), item.variant);
}
