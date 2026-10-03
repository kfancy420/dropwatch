// Shared types for dropwatch.

export type SourceType = "shopify" | "bestbuy" | "page";

export interface WatchItem {
  id: string;
  name: string;
  /** The page a human opens to buy. Always the retailer's own product URL. */
  url: string;
  source: SourceType;
  /** Best Buy SKU (source "bestbuy"). */
  sku?: string;
  /** Shopify variant id to watch; default is "any variant available". */
  variant?: string;
  /** Skip the alert when the listed price is above this (marked-up resellers). */
  maxPrice?: number;
  /** Seconds between checks. Clamped to MIN_INTERVAL_SEC. */
  intervalSec?: number;
  /** Source "page" only: text that means sold out when the page has no schema.org data. */
  soldOutText?: string;
  /**
   * With soldOutText: the page's title when the item was added. A page that no
   * longer mentions it (maintenance, a waiting room) is not read as in stock.
   */
  pageTitle?: string;
}

export interface AlertSettings {
  openBrowser: boolean;
  sound: boolean;
  /** Desktop app only: show a system notification. On unless set to false. */
  desktop?: boolean;
  /** ntfy topic name; pushes to the ntfy phone app subscribed to it. */
  ntfyTopic?: string;
  ntfyServer?: string;
  discordWebhook?: string;
}

export interface Reminder {
  id: string;
  name: string;
  /** Page to open when the reminder fires. */
  url: string;
  /** ISO time. */
  at: string;
  done?: boolean;
}

export interface Config {
  items: WatchItem[];
  reminders?: Reminder[];
  alerts: AlertSettings;
  bestBuyApiKey?: string;
  /** Desktop app only. */
  paused?: boolean;
  onboarded?: boolean;
  trayNoticeShown?: boolean;
}

export type Availability = "in_stock" | "out_of_stock" | "unknown";

export interface CheckResult {
  availability: Availability;
  price?: number;
  title?: string;
  detail?: string;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "manual" },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** A real fetch has one; it lets the answer be read with a size limit. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
    cancel?(): Promise<void>;
  } | null;
}>;

/** Hard floor on how often one item is checked, whatever the config says. */
export const MIN_INTERVAL_SEC = 15;

export const DEFAULT_INTERVAL_SEC: Record<SourceType, number> = {
  shopify: 30,
  bestbuy: 30,
  page: 60,
};
