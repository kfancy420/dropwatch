// Large retailers dropwatch refuses to poll. Target, Walmart, Best Buy and
// Pokemon Center ban robots and scraping in their terms of use; the rest run
// bot protection. Getting around those rules is what scalper bots do, and this
// tool does not. Best Buy is absent from this list because it offers an
// official API (sources/bestbuy.ts).

export interface RestrictedRetailer {
  name: string;
  instead: string;
}

const RESTRICTED: Array<{ host: RegExp } & RestrictedRetailer> = [
  {
    host: /(^|\.)pokemoncenter\.com$/i,
    name: "Pokemon Center",
    instead:
      "big drops go through a waiting room that is reported to hand out places at random, so arriving seconds early does not help. Sign in beforehand, open the site before the drop, stay in one tab and wait your turn.",
  },
  {
    host: /(^|\.)target\.com$/i,
    name: "Target",
    instead:
      "ask your local store which day trading cards are stocked, and turn on a back-in-stock notification if the product page offers one.",
  },
  {
    host: /(^|\.)walmart\.com$/i,
    name: "Walmart",
    instead:
      "turn on an in-stock alert if the product page offers one, and buy only listings sold and shipped by Walmart.",
  },
  {
    host: /(^|\.)gamestop\.com$/i,
    name: "GameStop",
    instead: "ask your local store about release-day stock; stores get most of it.",
  },
  {
    // Includes Amazon's short links, which lead straight to a product page.
    host: /(^|\.)(amazon\.[a-z.]+|amzn\.[a-z]+|a\.co)$/i,
    name: "Amazon",
    instead: "buy only listings shipped and sold by Amazon; third-party listings carry a counterfeit risk.",
  },
  {
    host: /(^|\.)costco\.com$/i,
    name: "Costco",
    instead: "check your local warehouse; most trading-card stock is sold in store.",
  },
  {
    host: /(^|\.)samsclub\.com$/i,
    name: "Sam's Club",
    instead: "check your local club; most trading-card stock is sold in store.",
  },
];

/** "WWW.Shop.com." and "www.shop.com" are the same host. */
export function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

export function restrictedRetailer(hostname: string): RestrictedRetailer | undefined {
  const host = bareHost(hostname);
  return RESTRICTED.find((r) => r.host.test(host));
}

const BEST_BUY = /(^|\.)bestbuy\.com$/;

export function isBestBuy(hostname: string): boolean {
  return BEST_BUY.test(bareHost(hostname));
}

/**
 * The name of the retailer when dropwatch must not send a request to this
 * host at all. Every fetch asks, so a redirect or a hand-edited watchlist
 * cannot get around the list. Best Buy's pages are refused; its API is not.
 */
export function refusedHost(hostname: string): string | undefined {
  const host = bareHost(hostname);
  if (isBestBuy(host) && host !== "api.bestbuy.com") return "Best Buy";
  return restrictedRetailer(host)?.name;
}
