// Picks the right source for an item.

import { SourceError } from "../http.js";
import { isBestBuy } from "../retailers.js";
import { getAllowed } from "../robots.js";
import type { CheckResult, Config, FetchLike, SourceType, WatchItem } from "../types.js";
import { checkBestBuy } from "./bestbuy.js";
import { checkPage } from "./page.js";
import { checkShopify, parseShopifyProduct, shopifyJsonUrl } from "./shopify.js";

export function checkItem(
  item: WatchItem,
  config: Pick<Config, "bestBuyApiKey">,
  fetchImpl?: FetchLike,
): Promise<CheckResult> {
  switch (item.source) {
    case "shopify":
      return checkShopify(item, fetchImpl);
    case "bestbuy":
      return checkBestBuy(item, config.bestBuyApiKey, fetchImpl);
    case "page":
      return checkPage(item, fetchImpl);
  }
}

/** Works out the source for a URL. A Shopify probe already holds the product JSON, so it is returned too. */
export async function probeSource(
  url: string,
  fetchImpl?: FetchLike,
): Promise<{ source: SourceType; body?: string }> {
  if (isBestBuy(new URL(url).hostname)) return { source: "bestbuy" };

  const jsonUrl = shopifyJsonUrl(url);
  if (jsonUrl) {
    try {
      const body = await getAllowed(jsonUrl, fetchImpl);
      parseShopifyProduct(body);
      return { source: "shopify", body };
    } catch (err) {
      // Not a Shopify shop: fall through. A refusal is final; do not ask again
      // through a different door.
      const notShopify =
        err instanceof SourceError && (err.kind === "bad_response" || err.kind === "not_found");
      if (!notShopify) throw err;
    }
  }
  return { source: "page" };
}

export async function detectSource(url: string, fetchImpl?: FetchLike): Promise<SourceType> {
  return (await probeSource(url, fetchImpl)).source;
}
