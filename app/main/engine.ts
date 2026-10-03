// Everything the desktop app does that is not a window: the watchlist, the
// watch loop, reminders, alerts and the activity log. No Electron imports, so
// it runs under the unit tests as it is.

import { randomInt } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { alertText, sendAlerts, type PostLike } from "../../src/alerts.js";
import {
  CONFIG_FILE,
  ConfigCorruptError,
  defaultConfig,
  loadConfig,
  newItemId,
  pause,
  saveConfig,
} from "../../src/config.js";
import { hostOf, SOURCE_ERROR_KINDS, SourceError, type SourceErrorKind } from "../../src/http.js";
import {
  Monitor,
  type CheckNowOutcome,
  type LogKind,
  type SavedItemState,
  type Status,
} from "../../src/monitor.js";
import { splitDue } from "../../src/reminders.js";
import { restrictedRetailer } from "../../src/retailers.js";
import { bestBuySku } from "../../src/sources/bestbuy.js";
import { checkItem, probeSource } from "../../src/sources/index.js";
import { parseShopifyProduct, shopifyJsonUrl } from "../../src/sources/shopify.js";
import type {
  AlertSettings,
  CheckResult,
  Config,
  FetchLike,
  Reminder,
  SourceType,
  WatchItem,
} from "../../src/types.js";
import type {
  ActivityEntry,
  ActivityKind,
  EngineState,
  Methods,
  Preview,
  TestAlertResult,
} from "../shared/types.js";

const ACTIVITY_FILE = "activity.json";
/** Which products a store is refusing, and until when. Kept so a restart does not ask again early. */
const WATCH_STATE_FILE = "watch-state.json";
const SAVE_RETRY_MS = 30_000;
const DISCORD_WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/;
const ACTIVITY_LIMIT = 200;
const DONE_REMINDER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_LIMIT = 120;
/** Letters and digits that are hard to mix up when typed on a phone. */
const TOPIC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export interface Notice {
  title: string;
  body: string;
  url?: string;
}

export interface EngineDeps {
  /** Folder that holds dropwatch.json and activity.json. */
  dir: string;
  openExternal(url: string): void;
  notify(notice: Notice): void;
  playSound(): void;
  /** Called whenever something a window shows has changed. */
  onState(): void;
  fetchImpl?: FetchLike;
  post?: PostLike;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A mistake the person can fix; the message is shown to them as written. */
export class UserError extends Error {}

export function normalizeUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    // "shop.com." is the same place as "shop.com"; keep one spelling of it.
    const host = url.hostname.replace(/\.+$/, "");
    if (!host.includes(".")) return undefined;
    url.hostname = host;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export function explainError(kind: SourceErrorKind, host: string, source?: SourceType): string {
  switch (kind) {
    case "blocked":
      return source === "bestbuy"
        ? "Best Buy did not accept the key. Check it in Settings."
        : `${host} turns away automated checks, so Dropwatch won't watch it. Use the store's own "notify me" button for this one.`;
    case "robots":
      return `${host} asks automated tools to stay off this page, and Dropwatch respects that. Use the store's own "notify me" button for this one.`;
    case "rate_limited":
      return `${host} asked Dropwatch to slow down.`;
    case "not_found":
      return `That page was not found on ${host}. Check the link.`;
    case "network":
      return `Couldn't reach ${host}. Check your internet connection.`;
    case "bad_response":
      return `${host} sent back something Dropwatch couldn't read.`;
    case "restricted":
      return "This link leads to a store that doesn't allow automated checks, so Dropwatch won't watch it. Set a reminder for the drop instead.";
    case "private":
      return `${host} leads to an address inside your own network, so Dropwatch won't open it. On public Wi-Fi, sign in to the network first.`;
    case "config":
      return source === "bestbuy"
        ? "Best Buy needs a key before Dropwatch can check it. Add one in Settings."
        : "Dropwatch can't check this link the way it was saved. Remove it and add it again.";
  }
}

function money(price: number | undefined): string {
  return price !== undefined ? ` at $${price.toFixed(2)}` : "";
}

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
  if (!name) throw new UserError("Give it a name so you can tell it apart.");
  return name;
}

const filled = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A saved product, as far as it can be trusted. The file may have been edited by hand. */
function savedItem(raw: unknown): WatchItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const i = raw as Record<string, unknown>;
  const url = typeof i.url === "string" ? normalizeUrl(i.url) : undefined;
  if (!url || !filled(i.id) || !filled(i.name)) return undefined;
  if (i.source !== "shopify" && i.source !== "bestbuy" && i.source !== "page") return undefined;
  const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const maxPrice = amount(i.maxPrice);
  const intervalSec = amount(i.intervalSec);
  return {
    id: i.id,
    name: i.name.slice(0, NAME_LIMIT),
    url,
    source: i.source,
    ...(filled(i.sku) && { sku: i.sku }),
    ...(filled(i.variant) && { variant: i.variant }),
    ...(maxPrice !== undefined && { maxPrice }),
    ...(intervalSec !== undefined && { intervalSec }),
    ...(filled(i.soldOutText) && { soldOutText: i.soldOutText }),
    ...(filled(i.pageTitle) && { pageTitle: i.pageTitle }),
  };
}

function savedReminder(raw: unknown): Reminder | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" ? normalizeUrl(r.url) : undefined;
  if (!url || !filled(r.id) || !filled(r.name) || !filled(r.at)) return undefined;
  if (Number.isNaN(new Date(r.at).getTime())) return undefined;
  return { id: r.id, name: r.name.slice(0, NAME_LIMIT), url, at: r.at, ...(r.done === true && { done: true }) };
}

function savedAlerts(raw: unknown): AlertSettings {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    openBrowser: a.openBrowser !== false,
    sound: a.sound !== false,
    ...(a.desktop === false && { desktop: false }),
    ...(filled(a.ntfyTopic) && /^[\w-]{1,64}$/.test(a.ntfyTopic) && { ntfyTopic: a.ntfyTopic }),
    ...(filled(a.ntfyServer) && normalizeUrl(a.ntfyServer) && { ntfyServer: a.ntfyServer }),
    ...(filled(a.discordWebhook) && DISCORD_WEBHOOK.test(a.discordWebhook) && { discordWebhook: a.discordWebhook }),
  };
}

function cleanMaxPrice(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1_000_000) {
    throw new UserError("The price limit must be a number above zero.");
  }
  return Math.round(raw * 100) / 100;
}

export class Engine {
  private config: Config;
  private readonly configFile: string;
  private readonly activityFile: string;
  private readonly watchStateFile: string;
  private readonly monitor: Monitor;
  /** What watch-state.json holds, so it is only written when it changes. */
  private writtenWatchState: string;
  /** True when the saved list would not open at start. It is left alone for the whole run. */
  private saveBlocked = false;
  private unsaved = false;
  private lastSaveTryAt = 0;
  private activity: ActivityEntry[] = [];
  private nextActivityId = 1;
  private activityDirty = false;
  private ticking = false;
  private previewing = false;
  private lastPreview?: { url: string; draft: WatchItem; result: CheckResult };
  /** Last status written to the activity log, so only real changes are logged. */
  private readonly lastStatus = new Map<string, Status>();
  private readonly failing = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    mkdirSync(deps.dir, { recursive: true });
    this.configFile = join(deps.dir, CONFIG_FILE);
    this.activityFile = join(deps.dir, ACTIVITY_FILE);
    this.watchStateFile = join(deps.dir, WATCH_STATE_FILE);
    this.loadActivity();
    this.config = this.loadConfigSafely();
    const watchState = this.loadWatchState();
    this.writtenWatchState = JSON.stringify(watchState);
    for (const [id, saved] of Object.entries(watchState)) {
      // Its trouble is already in the activity log from the last run.
      if (saved.failures > 0 && !saved.stopped) this.failing.add(id);
    }

    this.monitor = new Monitor(this.config.items, {
      check: async (item) => {
        const result = await checkItem(item, this.config, deps.fetchImpl);
        this.failing.delete(item.id);
        return result;
      },
      alert: (item, result) => this.alertInStock(item, result),
      log: (line, kind, item) => this.onMonitorLog(line, kind, item),
      now: this.now,
      sleep: deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
      random: deps.random ?? Math.random,
      onChange: () => deps.onState(),
    }, watchState);
  }

  /** One heartbeat: fires due reminders, then checks any product that is due. */
  async pulse(): Promise<void> {
    if (this.unsaved && this.now() - this.lastSaveTryAt >= SAVE_RETRY_MS) this.save();
    this.checkReminders();
    if (this.config.paused || this.ticking) return;
    this.ticking = true;
    try {
      await this.monitor.tick();
    } finally {
      this.ticking = false;
    }
  }

  /** Writes anything still held in memory. Call before the app exits. */
  flush(): void {
    const watchState = JSON.stringify(this.monitor.troubled());
    if (watchState !== this.writtenWatchState) {
      this.writtenWatchState = watchState;
      this.writeQuietly(this.watchStateFile, watchState);
    }
    if (!this.activityDirty) return;
    this.activityDirty = false;
    this.writeQuietly(this.activityFile, JSON.stringify(this.activity));
  }

  /** The last chance to write a list that would not save earlier. Call before the app exits. */
  close(): void {
    if (this.unsaved) this.save();
    this.flush();
  }

  /** For files that are a convenience: losing one must not take the app down. */
  private writeQuietly(file: string, text: string): void {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, file);
    } catch {
      // Nothing to do; the next write may work.
    }
  }

  view(): EngineState {
    const snapshots = new Map(this.monitor.snapshot().map((s) => [s.id, s]));
    return {
      products: this.config.items.map((item) => {
        const snap = snapshots.get(item.id);
        const host = hostOf(item.url);
        return {
          id: item.id,
          name: item.name,
          url: item.url,
          host,
          source: item.source,
          maxPrice: item.maxPrice,
          status: snap?.status,
          price: snap?.price,
          checkedAt: snap?.checkedAt,
          nextAt: snap?.nextAt ?? this.now(),
          problem: snap?.errorKind ? explainError(snap.errorKind, host, item.source) : undefined,
          stopped: snap?.stopped ?? false,
          checking: snap?.checking ?? false,
        };
      }),
      reminders: (this.config.reminders ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        host: hostOf(r.url),
        at: r.at,
        done: r.done === true,
      })),
      alerts: {
        openBrowser: this.config.alerts.openBrowser,
        sound: this.config.alerts.sound,
        desktop: this.config.alerts.desktop !== false,
        ntfyTopic: this.config.alerts.ntfyTopic,
        discordWebhook: this.config.alerts.discordWebhook,
      },
      hasBestBuyKey: Boolean(this.config.bestBuyApiKey),
      paused: this.config.paused === true,
      onboarded: this.config.onboarded === true,
      activity: this.activity,
    };
  }

  get paused(): boolean {
    return this.config.paused === true;
  }

  get watchingCount(): number {
    return this.config.items.length;
  }

  get trayNoticeShown(): boolean {
    return this.config.trayNoticeShown === true;
  }

  markTrayNoticeShown(): void {
    this.config.trayNoticeShown = true;
    this.save();
  }

  async previewProduct(rawUrl: string, soldOutText?: string): Promise<Preview> {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      return {
        kind: "error",
        message:
          "That doesn't look like a web link. Copy the address of the product page from your browser and paste it here.",
      };
    }
    const host = new URL(url).hostname;
    const restricted = restrictedRetailer(host);
    if (restricted) return { kind: "restricted", url, ...restricted };
    if (this.config.items.some((i) => i.url === url)) {
      return { kind: "error", message: "You're already watching this product." };
    }
    if (this.previewing) {
      return { kind: "error", message: "Still checking the last link. Try again in a moment." };
    }

    this.previewing = true;
    let source: SourceType | undefined;
    try {
      // A preview asks the store too, so it waits its turn like any other check.
      await this.monitor.reserveHost(hostOf(url));
      const probe = await probeSource(url, this.deps.fetchImpl);
      source = probe.source;
      const draft: WatchItem = { id: "preview", name: "", url, source };
      let result: CheckResult;

      if (source === "bestbuy") {
        if (!this.config.bestBuyApiKey) return { kind: "needs_key" };
        const sku = bestBuySku(url);
        if (!sku) {
          return {
            kind: "error",
            message:
              "This Best Buy link has no product number in it. Open the product's own page and copy that link.",
          };
        }
        draft.sku = sku;
        result = await checkItem(draft, this.config, this.deps.fetchImpl);
      } else if (source === "shopify" && probe.body !== undefined) {
        // A link copied with one option selected watches that option.
        const variant = new URL(url).searchParams.get("variant") ?? undefined;
        if (variant && /^\d+$/.test(variant)) {
          try {
            result = parseShopifyProduct(probe.body, variant);
            draft.variant = variant;
          } catch {
            result = parseShopifyProduct(probe.body);
          }
        } else {
          result = parseShopifyProduct(probe.body);
        }
      } else {
        const phrase = soldOutText?.trim().slice(0, 80);
        if (phrase) draft.soldOutText = phrase;
        // The probe above already asked this store once.
        if (shopifyJsonUrl(url)) await this.monitor.reserveHost(hostOf(url));
        result = await checkItem(draft, this.config, this.deps.fetchImpl);
        // Remembered so a later maintenance page is not mistaken for the product page.
        if (phrase && result.title) draft.pageTitle = result.title;
      }

      this.lastPreview = { url, draft, result };
      return {
        kind: "ok",
        url,
        host: hostOf(url),
        source,
        title: result.title,
        price: result.price,
        availability: result.availability,
      };
    } catch (err) {
      const kind = err instanceof SourceError ? err.kind : "network";
      return { kind: "error", message: explainError(kind, hostOf(url), source) };
    } finally {
      this.previewing = false;
    }
  }

  addProduct(input: Parameters<Methods["addProduct"]>[0]): void {
    const preview = this.lastPreview;
    if (!preview || preview.url !== input.url) {
      throw new UserError("Check the link first, then add it.");
    }
    if (preview.result.availability === "unknown") {
      throw new UserError("Dropwatch can't tell whether this page is in stock, so it can't watch it yet.");
    }
    if (this.config.items.some((i) => i.url === preview.url)) {
      throw new UserError("You're already watching this product.");
    }
    const name = cleanName(input.name);
    const maxPrice = cleanMaxPrice(input.maxPrice);
    const item: WatchItem = {
      ...preview.draft,
      id: newItemId(name, this.config.items),
      name,
      ...(maxPrice !== undefined && { maxPrice }),
    };
    this.lastPreview = undefined;
    this.config.items = [...this.config.items, item];
    this.save();
    this.monitor.setItems(this.config.items);
    // The preview is seconds old; use it instead of asking the store again.
    this.monitor.prime(item.id, preview.result);
    const status = this.monitor.snapshot().find((s) => s.id === item.id)?.status;
    if (status) this.lastStatus.set(item.id, status);
    this.log("info", name, `Started watching on ${hostOf(item.url)}.`, item.url);
  }

  updateProduct(id: string, patch: Parameters<Methods["updateProduct"]>[1]): void {
    const name = cleanName(patch.name);
    const maxPrice = cleanMaxPrice(patch.maxPrice);
    let found = false;
    this.config.items = this.config.items.map((item) => {
      if (item.id !== id) return item;
      found = true;
      const { maxPrice: _old, ...rest } = item;
      return { ...rest, name, ...(maxPrice !== undefined && { maxPrice }) };
    });
    if (!found) return;
    this.save();
    this.monitor.setItems(this.config.items);
    this.deps.onState();
  }

  removeProduct(id: string): void {
    const item = this.config.items.find((i) => i.id === id);
    if (!item) return;
    this.config.items = this.config.items.filter((i) => i.id !== id);
    this.lastStatus.delete(id);
    this.failing.delete(id);
    this.save();
    this.monitor.setItems(this.config.items);
    this.log("info", item.name, "Stopped watching.");
  }

  checkNow(id: string): CheckNowOutcome {
    return this.monitor.checkNow(id);
  }

  addReminder(input: Parameters<Methods["addReminder"]>[0]): void {
    const name = cleanName(input.name);
    const url = normalizeUrl(input.url);
    if (!url) throw new UserError("Paste the link to the page you want opened.");
    const at = new Date(input.at);
    if (Number.isNaN(at.getTime())) throw new UserError("Pick a date and a time.");
    if (at.getTime() <= this.now()) throw new UserError("That time has already passed. Pick one in the future.");
    const reminders = this.config.reminders ?? [];
    const reminder: Reminder = { id: newItemId(name, reminders), name, url, at: at.toISOString() };
    this.config.reminders = [...reminders, reminder];
    this.save();
    this.deps.onState();
  }

  removeReminder(id: string): void {
    this.config.reminders = (this.config.reminders ?? []).filter((r) => r.id !== id);
    this.save();
    this.deps.onState();
  }

  updateAlerts(patch: Parameters<Methods["updateAlerts"]>[0]): void {
    const alerts = { ...this.config.alerts };
    if (patch.openBrowser !== undefined) alerts.openBrowser = patch.openBrowser;
    if (patch.sound !== undefined) alerts.sound = patch.sound;
    if (patch.desktop !== undefined) alerts.desktop = patch.desktop;
    if (patch.discordWebhook !== undefined) {
      const hook = patch.discordWebhook.trim();
      if (!hook) {
        delete alerts.discordWebhook;
      } else if (DISCORD_WEBHOOK.test(hook)) {
        alerts.discordWebhook = hook;
      } else {
        throw new UserError(
          "That is not a Discord webhook link. It starts with https://discord.com/api/webhooks/",
        );
      }
    }
    this.config.alerts = alerts;
    this.save();
    this.deps.onState();
  }

  newNtfyTopic(): void {
    let code = "";
    for (let i = 0; i < 10; i++) code += TOPIC_ALPHABET[randomInt(TOPIC_ALPHABET.length)];
    this.config.alerts = { ...this.config.alerts, ntfyTopic: `dropwatch-${code}` };
    this.save();
    this.deps.onState();
  }

  clearNtfyTopic(): void {
    const { ntfyTopic: _topic, ...rest } = this.config.alerts;
    this.config.alerts = rest;
    this.save();
    this.deps.onState();
  }

  setBestBuyKey(raw: string): void {
    const key = raw.trim();
    if (!key) {
      delete this.config.bestBuyApiKey;
    } else if (/^[A-Za-z0-9]{16,64}$/.test(key)) {
      this.config.bestBuyApiKey = key;
    } else {
      throw new UserError("That doesn't look like a Best Buy key. It is one run of letters and numbers.");
    }
    this.save();
    // Products that stopped over the old key get a fresh start with the new one.
    const bestBuy = this.config.items.filter((i) => i.source === "bestbuy").map((i) => i.id);
    bestBuy.forEach((id) => this.failing.delete(id));
    this.monitor.restart(bestBuy);
    this.deps.onState();
  }

  async testAlert(): Promise<TestAlertResult> {
    const sent: string[] = [];
    const failures: string[] = [];
    const { alerts } = this.config;
    if (alerts.sound) {
      this.deps.playSound();
      sent.push("alarm sound");
    }
    if (alerts.desktop !== false) {
      this.deps.notify({
        title: "Test alert from Dropwatch",
        body: "This is what an in-stock alert looks like.",
      });
      sent.push("desktop notification");
    }
    if (alerts.ntfyTopic) sent.push("phone");
    if (alerts.discordWebhook) sent.push("Discord");
    await this.push("Test alert from Dropwatch", "https://github.com/kfancy420/dropwatch", (line) =>
      failures.push(line),
    );
    return { sent: sent.filter((s) => !failures.some((f) => f.toLowerCase().includes(s.toLowerCase()))), failures };
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.config.paused = paused;
    this.save();
    this.log("info", "Dropwatch", paused ? "Paused watching." : "Resumed watching.");
  }

  completeOnboarding(): void {
    this.config.onboarded = true;
    this.save();
    this.deps.onState();
  }

  clearActivity(): void {
    this.activity = [];
    this.activityDirty = true;
    this.flush();
    this.deps.onState();
  }

  private loadConfigSafely(): Config {
    let config: Config;
    try {
      config = this.readConfig();
    } catch (err) {
      if (!(err instanceof ConfigCorruptError)) {
        // The file is there but would not open. The list inside may be fine, so it is not replaced.
        this.saveBlocked = true;
        this.log(
          "problem",
          "Dropwatch",
          "Your saved watchlist would not open, so Dropwatch left it untouched and is not saving changes. Quit Dropwatch from its icon next to the clock, then open it again.",
        );
        return defaultConfig();
      }
      // Keep the damaged file for the person to recover; start clean.
      const kept = `${this.configFile}.unreadable-${this.now()}`;
      try {
        renameSync(this.configFile, kept);
      } catch {
        // Nothing to keep.
      }
      this.log("problem", "Dropwatch", `The saved watchlist could not be read, so a new one was started. The old file was kept as ${kept}.`);
      return defaultConfig();
    }

    const rawItems: unknown[] = config.items;
    const rawReminders: unknown[] = Array.isArray(config.reminders) ? config.reminders : [];
    const seen = new Set<string>();
    const fresh = <T extends { id: string }>(entry: T | undefined): entry is T => {
      if (!entry || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    };
    const items = rawItems.map(savedItem).filter(fresh);
    seen.clear();
    const reminders = rawReminders.map(savedReminder).filter(fresh);

    const dropped = rawItems.length - items.length + rawReminders.length - reminders.length;
    if (dropped > 0) {
      const kept = `${this.configFile}.bak`;
      try {
        copyFileSync(this.configFile, kept);
      } catch {
        // The entries are left out either way.
      }
      this.log(
        "problem",
        "Dropwatch",
        `${dropped} saved ${dropped === 1 ? "entry" : "entries"} could not be understood and ${dropped === 1 ? "was" : "were"} left out. A copy of the list as it was is kept as ${kept}.`,
      );
    }
    return {
      items,
      reminders,
      alerts: savedAlerts(config.alerts),
      ...(filled(config.bestBuyApiKey) && { bestBuyApiKey: config.bestBuyApiKey }),
      ...(config.paused === true && { paused: true }),
      ...(config.onboarded === true && { onboarded: true }),
      ...(config.trayNoticeShown === true && { trayNoticeShown: true }),
    };
  }

  /** Reads the saved list, waiting out a file that something else holds for a moment. */
  private readConfig(): Config {
    for (let attempt = 1; ; attempt++) {
      try {
        return loadConfig(this.configFile);
      } catch (err) {
        if (err instanceof ConfigCorruptError || attempt >= 3) throw err;
        pause(100);
      }
    }
  }

  private loadWatchState(): Record<string, SavedItemState> {
    const out: Record<string, SavedItemState> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.watchStateFile, "utf8"));
      if (!parsed || typeof parsed !== "object") return out;
      for (const [id, raw] of Object.entries(parsed as Record<string, Partial<SavedItemState> | null>)) {
        if (!raw || typeof raw.nextAt !== "number" || typeof raw.failures !== "number") continue;
        if (raw.errorKind !== undefined && !SOURCE_ERROR_KINDS.includes(raw.errorKind)) continue;
        out[id] = {
          nextAt: raw.nextAt,
          failures: raw.failures,
          stopped: raw.stopped === true,
          ...(typeof raw.error === "string" && { error: raw.error }),
          ...(raw.errorKind && { errorKind: raw.errorKind }),
        };
      }
    } catch {
      // No file yet, or a damaged one: every product starts fresh.
    }
    return out;
  }

  private loadActivity(): void {
    if (!existsSync(this.activityFile)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.activityFile, "utf8"));
      if (!Array.isArray(parsed)) return;
      this.activity = (parsed as ActivityEntry[])
        .filter((e) => e && typeof e.at === "number" && typeof e.text === "string" && typeof e.title === "string")
        .slice(0, ACTIVITY_LIMIT)
        .map((e, i) => ({ ...e, id: i + 1 }));
      this.nextActivityId = this.activity.length + 1;
    } catch {
      // A damaged log is dropped.
    }
  }

  /** Never throws: a full disk must not stop an alert or take the window down. */
  private save(): void {
    if (this.saveBlocked) return;
    this.lastSaveTryAt = this.now();
    try {
      saveConfig(this.configFile, this.config);
      this.unsaved = false;
    } catch {
      if (this.unsaved) return;
      this.unsaved = true;
      this.log("problem", "Dropwatch", "Your changes could not be saved to this computer. Dropwatch will keep trying.");
    }
  }

  private log(kind: ActivityKind, title: string, text: string, url?: string): void {
    this.activity = [
      { id: this.nextActivityId++, at: this.now(), kind, title, text, ...(url && { url }) },
      ...this.activity,
    ].slice(0, ACTIVITY_LIMIT);
    this.activityDirty = true;
    this.deps.onState();
  }

  private onMonitorLog(line: string, kind: LogKind, item?: WatchItem): void {
    if (!item) return;
    const snap = this.monitor.snapshot().find((s) => s.id === item.id);
    const host = hostOf(item.url);
    const previous = this.lastStatus.get(item.id);
    switch (kind) {
      case "in_stock":
        this.log("in_stock", item.name, `In stock${money(snap?.price)} on ${host}.`, item.url);
        break;
      case "over_max":
        this.log(
          "over_max",
          item.name,
          `In stock${money(snap?.price)}, above your $${item.maxPrice?.toFixed(2)} limit. No alert sent.`,
          item.url,
        );
        break;
      case "out_of_stock":
        // The first check after a start is not news.
        if (previous && previous !== "unknown") this.log("out_of_stock", item.name, "Sold out again.", item.url);
        break;
      case "unknown":
        if (previous) {
          this.log("problem", item.name, `Dropwatch can no longer tell whether this is in stock on ${host}.`, item.url);
        }
        break;
      case "stopped":
        this.log(
          "problem",
          item.name,
          `Stopped watching. ${explainError(snap?.errorKind ?? "network", host, item.source)}`,
          item.url,
        );
        break;
      case "retry":
        // One line per run of failures, not one per attempt.
        if (!this.failing.has(item.id)) {
          this.failing.add(item.id);
          this.log(
            "problem",
            item.name,
            `${explainError(snap?.errorKind ?? "network", host, item.source)} Dropwatch will keep trying.`,
            item.url,
          );
        }
        break;
      case "alert_failed":
        this.log("problem", item.name, `An alert did not go out: ${line.replace(/^alert failed: /, "")}.`);
        break;
      case "info":
        break;
    }
    if (snap?.status && kind !== "stopped" && kind !== "retry" && kind !== "alert_failed") {
      this.lastStatus.set(item.id, snap.status);
    }
  }

  private async alertInStock(item: WatchItem, result: CheckResult): Promise<void> {
    // The item may have been removed while its check was in flight.
    if (!this.config.items.some((i) => i.id === item.id)) return;
    const { alerts } = this.config;
    if (alerts.openBrowser) this.deps.openExternal(item.url);
    if (alerts.sound) this.deps.playSound();
    if (alerts.desktop !== false) {
      this.deps.notify({
        title: `In stock: ${item.name}`,
        body: `${result.price !== undefined ? `$${result.price.toFixed(2)} on ` : "On "}${hostOf(item.url)}. Click to open the page.`,
        url: item.url,
      });
    }
    await this.push(alertText(item, result), item.url, (line) =>
      this.log("problem", item.name, `${line}.`),
    );
  }

  /** Phone and Discord. The window handles the browser, sound and desktop notice itself. */
  private async push(text: string, url: string, onFailure: (line: string) => void): Promise<void> {
    const { alerts } = this.config;
    if (!alerts.ntfyTopic && !alerts.discordWebhook) return;
    await sendAlerts(
      { ...alerts, openBrowser: false, sound: false },
      { text, url },
      {
        post: this.deps.post ?? ((target, init) => fetch(target, init)),
        spawn: () => {},
        log: (line) => onFailure(line.replace(/^ntfy alert failed/, "Phone alert failed")),
        platform: process.platform,
        bell: () => {},
      },
    );
  }

  private checkReminders(): void {
    const all = this.config.reminders ?? [];
    if (all.length === 0) return;
    const now = this.now();
    const { due, missed } = splitDue(all, now);
    const stale = all.filter(
      (r) => r.done && now - new Date(r.at).getTime() > DONE_REMINDER_KEEP_MS,
    );
    if (due.length === 0 && missed.length === 0 && stale.length === 0) return;

    const finished = new Set([...due, ...missed].map((r) => r.id));
    const dropped = new Set(stale.map((r) => r.id));
    this.config.reminders = all
      .filter((r) => !dropped.has(r.id))
      .map((r) => (finished.has(r.id) ? { ...r, done: true } : r));

    for (const r of missed) {
      this.log(
        "problem",
        r.name,
        `Missed this reminder: Dropwatch was not running at ${new Date(r.at).toLocaleString()}.`,
        r.url,
      );
    }
    for (const r of due) {
      const { alerts } = this.config;
      if (alerts.openBrowser) this.deps.openExternal(r.url);
      if (alerts.sound) this.deps.playSound();
      if (alerts.desktop !== false) {
        this.deps.notify({
          title: `Drop time: ${r.name}`,
          body: `Your reminder for ${hostOf(r.url)}. Click to open the page.`,
          url: r.url,
        });
      }
      this.log("reminder", r.name, `Reminder went off for ${hostOf(r.url)}.`, r.url);
      void this.push(`DROP TIME: ${r.name}`, r.url, (line) => this.log("problem", r.name, `${line}.`));
    }
    // Saved last: the alert matters more than the note that it went out.
    this.save();
    if (stale.length > 0 && due.length === 0 && missed.length === 0) this.deps.onState();
  }
}
