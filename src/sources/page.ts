// Generic product page. Reads the schema.org Product data that shops embed for
// search engines (JSON-LD), which states availability in a machine-readable
// way. Falls back to a "sold out" phrase the user supplies.
//
// The page is someone else's text and may be hostile, so it is scanned with
// plain index searches: no pattern here can be made to run slowly.

import { getAllowed } from "../robots.js";
import type { Availability, CheckResult, FetchLike, WatchItem } from "../types.js";

// A pre-order opening is a drop too, so it counts as buyable.
const IN_STOCK = /InStock|LimitedAvailability|OnlineOnly|InStoreOnly|PreOrder|PreSale|BackOrder/i;
const NOT_IN_STOCK = /OutOfStock|SoldOut|Discontinued/i;
const JSON_LD_TYPE = /\btype\s*=\s*["']?application\/ld\+json/i;
/** Tags whose contents a visitor never sees. */
const UNSEEN = ["script", "style", "template"];
const TITLE_LIMIT = 200;

interface Offer {
  availability?: unknown;
  price?: unknown;
  lowPrice?: unknown;
  offers?: unknown;
}

function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    yield obj;
    // Products sit under @graph, or as the variants of a ProductGroup.
    for (const key of ["@graph", "hasVariant", "mainEntity"]) {
      if (obj[key]) yield* walk(obj[key]);
    }
  }
}

function hasType(obj: Record<string, unknown>, wanted: string): boolean {
  const type = obj["@type"];
  return Array.isArray(type) ? type.includes(wanted) : type === wanted;
}

function flattenOffers(offers: unknown): Offer[] {
  const out: Offer[] = [];
  for (const offer of walk(offers)) {
    out.push(offer as Offer);
    if ((offer as Offer).offers) out.push(...flattenOffers((offer as Offer).offers));
  }
  return out;
}

/** The contents of every <script type="application/ld+json"> on the page. */
function* jsonLdBlocks(html: string, lower: string): Generator<string> {
  let from = 0;
  for (;;) {
    const open = lower.indexOf("<script", from);
    if (open < 0) return;
    const openEnd = html.indexOf(">", open);
    if (openEnd < 0) return;
    const close = lower.indexOf("</script", openEnd);
    if (close < 0) return;
    if (JSON_LD_TYPE.test(html.slice(open, openEnd))) yield html.slice(openEnd + 1, close);
    from = close + 1;
  }
}

/** Lower-cases A to Z only, so every index into the result is an index into the original. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** The words a visitor would see: no tags, scripts, styles or comments. Lower case. */
export function visibleText(html: string, lower = asciiLower(html)): string {
  const parts: string[] = [];
  let from = 0;
  while (from < html.length) {
    const open = html.indexOf("<", from);
    if (open < 0) {
      parts.push(html.slice(from));
      break;
    }
    parts.push(html.slice(from, open));
    if (lower.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) break;
      from = end + 3;
      continue;
    }
    const openEnd = html.indexOf(">", open);
    if (openEnd < 0) break;
    const unseen = UNSEEN.find((tag) => lower.startsWith(tag, open + 1) && !/[a-z0-9-]/.test(lower[open + 1 + tag.length] ?? ""));
    if (!unseen) {
      from = openEnd + 1;
      continue;
    }
    const close = lower.indexOf(`</${unseen}`, openEnd);
    if (close < 0) break;
    const closeEnd = html.indexOf(">", close);
    if (closeEnd < 0) break;
    from = closeEnd + 1;
  }
  return decodeEntities(parts.join(" ")).replace(/\s+/g, " ").trim().toLowerCase();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|#38);/gi, "&")
    .replace(/&(quot|#34);/gi, '"')
    .replace(/&(#39|#x27|apos);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&(nbsp|#160);/gi, " ");
}

function pageTitle(html: string, lower: string): string | undefined {
  const open = lower.indexOf("<title");
  if (open < 0) return undefined;
  const openEnd = html.indexOf(">", open);
  const close = openEnd < 0 ? -1 : lower.indexOf("</title", openEnd);
  if (close < 0) return undefined;
  const title = decodeEntities(html.slice(openEnd + 1, close)).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, TITLE_LIMIT) : undefined;
}

function words(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].slice(0, 16);
}

/** True when most of the words of the title seen at add time are still on the page. */
function stillTheProductPage(text: string, expected: string): boolean {
  const wanted = words(expected);
  if (wanted.length === 0) return true;
  const present = new Set(text.split(/[^\p{L}\p{N}]+/u));
  const found = wanted.filter((w) => present.has(w)).length;
  return found / wanted.length >= 0.6;
}

export function parseProductPage(html: string, soldOutText?: string, expectedTitle?: string): CheckResult {
  const lower = asciiLower(html);
  // Every offer of every product on the page: a page can list several
  // variants, and one of them in stock is enough.
  const stated: Offer[] = [];
  let title: string | undefined;
  for (const block of jsonLdBlocks(html, lower)) {
    let data: unknown;
    try {
      data = JSON.parse(block);
    } catch {
      continue;
    }
    for (const obj of walk(data)) {
      const product = hasType(obj, "Product");
      if (!product && !hasType(obj, "ProductGroup")) continue;
      if (typeof obj.name === "string") title ??= obj.name.slice(0, TITLE_LIMIT);
      if (!product) continue;
      stated.push(...flattenOffers(obj.offers).filter((o) => typeof o.availability === "string"));
    }
  }
  if (stated.length > 0) {
    const open = stated.find((o) => IN_STOCK.test(o.availability as string));
    let availability: Availability = "unknown";
    if (open) availability = "in_stock";
    else if (stated.every((o) => NOT_IN_STOCK.test(o.availability as string))) {
      availability = "out_of_stock";
    }
    const price = Number((open ?? stated[0])?.price ?? (open ?? stated[0])?.lowPrice);
    return {
      availability,
      price: Number.isFinite(price) && price > 0 ? price : undefined,
      title,
      detail:
        availability === "unknown"
          ? `page states availability "${String(stated[0]?.availability).slice(0, 80)}"`
          : undefined,
    };
  }
  if (soldOutText) {
    const text = visibleText(html, lower);
    title = pageTitle(html, lower);
    // A maintenance page or a waiting room has no sold-out phrase either.
    // Without the product on the page, its absence means nothing.
    if (expectedTitle && !stillTheProductPage(text, expectedTitle)) {
      return {
        availability: "unknown",
        title,
        detail: "the page no longer looks like the product page",
      };
    }
    const phrase = soldOutText.toLowerCase().replace(/\s+/g, " ").trim();
    return {
      availability: text.includes(phrase) ? "out_of_stock" : "in_stock",
      title,
      detail: `based on the phrase "${soldOutText}"`,
    };
  }
  return {
    availability: "unknown",
    title: pageTitle(html, lower),
    detail: "the page has no machine-readable stock data; set a sold-out phrase with --sold-out-text",
  };
}

export async function checkPage(
  item: WatchItem,
  fetchImpl?: FetchLike,
): Promise<CheckResult> {
  const html = await getAllowed(item.url, fetchImpl, "text/html");
  return parseProductPage(html, item.soldOutText, item.pageTitle);
}
