// Best Buy publishes an official Products API with a free key
// (developer.bestbuy.com). We use that instead of reading bestbuy.com pages.

import { politeGet, SourceError } from "../http.js";
import type { CheckResult, FetchLike, WatchItem } from "../types.js";

export function bestBuySku(url: string): string | undefined {
  const u = new URL(url);
  return (
    u.searchParams.get("skuId") ??
    u.pathname.match(/\/(\d{6,9})\.p$/)?.[1] ??
    u.pathname.match(/\/sku\/(\d{6,9})/)?.[1] ??
    undefined
  );
}

interface BestBuyProduct {
  name?: string;
  salePrice?: number;
  onlineAvailability?: boolean;
  orderable?: string;
}

export function parseBestBuyProduct(body: string): CheckResult {
  let product: BestBuyProduct;
  try {
    product = JSON.parse(body) as BestBuyProduct;
  } catch {
    throw new SourceError("bad_response", "Best Buy did not return product JSON");
  }
  if (!product || typeof product.onlineAvailability !== "boolean") {
    throw new SourceError("bad_response", "Best Buy's answer has no onlineAvailability field");
  }
  return {
    availability: product.onlineAvailability ? "in_stock" : "out_of_stock",
    price:
      typeof product.salePrice === "number" && Number.isFinite(product.salePrice) && product.salePrice > 0
        ? product.salePrice
        : undefined,
    title: typeof product.name === "string" ? product.name.slice(0, 200) : undefined,
    detail: typeof product.orderable === "string" ? product.orderable.slice(0, 80) : undefined,
  };
}

export async function checkBestBuy(
  item: WatchItem,
  apiKey: string | undefined,
  fetchImpl?: FetchLike,
): Promise<CheckResult> {
  const sku = item.sku ?? bestBuySku(item.url);
  if (!sku) {
    throw new SourceError("config", `could not find a Best Buy SKU in ${item.url}`);
  }
  if (!apiKey) {
    throw new SourceError(
      "config",
      "Best Buy needs a free API key from developer.bestbuy.com; save it with: dropwatch settings --bestbuy-key <key>",
    );
  }
  const url =
    `https://api.bestbuy.com/v1/products/${sku}.json` +
    `?show=sku,name,salePrice,onlineAvailability,orderable&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    return parseBestBuyProduct(await politeGet(url, fetchImpl));
  } catch (err) {
    // Never echo the key back in an error message.
    if (err instanceof SourceError) {
      throw new SourceError(err.kind, err.message.replace(apiKey, "<key>"), err.retryAfterSec);
    }
    throw err;
  }
}
