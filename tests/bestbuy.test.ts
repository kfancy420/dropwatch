import { describe, expect, it } from "vitest";

import { restrictedRetailer } from "../src/retailers.js";
import { bestBuySku, checkBestBuy, parseBestBuyProduct } from "../src/sources/bestbuy.js";
import type { WatchItem } from "../src/types.js";
import { fakeFetch } from "./helpers.js";

const item: WatchItem = {
  id: "etb",
  name: "ETB",
  url: "https://www.bestbuy.com/site/pokemon-etb/6606082.p?skuId=6606082",
  source: "bestbuy",
};
const apiUrl =
  "https://api.bestbuy.com/v1/products/6606082.json?show=sku,name,salePrice,onlineAvailability,orderable&apiKey=SECRET";

describe("best buy", () => {
  it("finds the SKU in each URL shape", () => {
    expect(bestBuySku(item.url)).toBe("6606082");
    expect(bestBuySku("https://www.bestbuy.com/site/pokemon-etb/6606082.p")).toBe("6606082");
    expect(bestBuySku("https://www.bestbuy.com/product/pokemon-etb/J3ZYG2/sku/6606082")).toBe(
      "6606082",
    );
    expect(bestBuySku("https://www.bestbuy.com/site/promo/pokemon")).toBeUndefined();
  });

  it("maps onlineAvailability to stock", () => {
    expect(
      parseBestBuyProduct(
        JSON.stringify({ name: "ETB", salePrice: 49.99, onlineAvailability: true, orderable: "Available" }),
      ),
    ).toEqual({ availability: "in_stock", price: 49.99, title: "ETB", detail: "Available" });
    expect(parseBestBuyProduct(JSON.stringify({ onlineAvailability: false })).availability).toBe(
      "out_of_stock",
    );
    expect(() => parseBestBuyProduct("{}")).toThrow(/onlineAvailability/);
  });

  it("asks for a key when none is saved", async () => {
    await expect(checkBestBuy(item, undefined, fakeFetch({}))).rejects.toMatchObject({
      kind: "config",
    });
  });

  it("calls the official API and never the website", async () => {
    const fetchImpl = fakeFetch({ [apiUrl]: { body: JSON.stringify({ onlineAvailability: true }) } });
    expect((await checkBestBuy(item, "SECRET", fetchImpl)).availability).toBe("in_stock");
    expect(fetchImpl.calls).toEqual([apiUrl]);
  });

  it("keeps the key out of error messages", async () => {
    const err = await checkBestBuy(item, "SECRET", fakeFetch({})).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("SECRET");
  });
});

describe("restricted retailers", () => {
  it("refuses the big retailers and their subdomains, and nothing else", () => {
    expect(restrictedRetailer("www.pokemoncenter.com")?.name).toBe("Pokemon Center");
    expect(restrictedRetailer("target.com")?.name).toBe("Target");
    expect(restrictedRetailer("www.amazon.co.uk")?.name).toBe("Amazon");
    expect(restrictedRetailer("www.bestbuy.com")).toBeUndefined();
    expect(restrictedRetailer("nottarget.com")).toBeUndefined();
    expect(restrictedRetailer("shop.test")).toBeUndefined();
  });
});
