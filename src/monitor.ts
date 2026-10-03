// The watch loop: checks each item on its interval, alerts once when an item
// turns buyable, and backs off (never pushes harder) when a site objects.

import { hostOf, SourceError, type SourceErrorKind } from "./http.js";
import {
  DEFAULT_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  type CheckResult,
  type WatchItem,
} from "./types.js";

export type LogKind =
  | "in_stock"
  | "over_max"
  | "out_of_stock"
  | "unknown"
  | "stopped"
  | "retry"
  | "alert_failed"
  | "info";

export interface MonitorDeps {
  check(item: WatchItem): Promise<CheckResult>;
  alert(item: WatchItem, result: CheckResult): Promise<void>;
  log(line: string, kind: LogKind, item?: WatchItem): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 0..1, used to jitter intervals so checks do not land on a fixed beat. */
  random(): number;
  /** Called whenever an item's state changes (a check starts or ends). */
  onChange?(): void;
}

export type Status = "buyable" | "in_stock_over_max" | "out_of_stock" | "unknown";

interface ItemState {
  status?: Status;
  price?: number;
  nextAt: number;
  checkedAt?: number;
  failures: number;
  stopped: boolean;
  error?: string;
  errorKind?: SourceErrorKind;
  checking: boolean;
}

/** The part of an item's state worth keeping across a restart: what the site last said no to. */
export interface SavedItemState {
  nextAt: number;
  failures: number;
  stopped: boolean;
  error?: string;
  errorKind?: SourceErrorKind;
}

export type CheckNowOutcome = "queued" | "busy" | "too_soon" | "waiting";

/** What a UI needs to draw one item. */
export interface ItemSnapshot {
  id: string;
  status?: Status;
  price?: number;
  checkedAt?: number;
  nextAt: number;
  /** The current problem, if the last check failed. */
  error?: string;
  errorKind?: SourceErrorKind;
  /** True when dropwatch gave up on this item (refused, disallowed, not found). */
  stopped: boolean;
  checking: boolean;
}

/** Minimum gap between two requests to the same host, across all items. */
const HOST_GAP_MS = 3_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
/** Consecutive refusals after which we stop asking a site altogether. */
const BLOCKED_LIMIT = 3;
const HEARTBEAT_MS = 10 * 60 * 1000;
/** A manual "check now" is ignored this soon after the last check: the same floor as any interval. */
export const MANUAL_GAP_MS = MIN_INTERVAL_SEC * 1000;

export function intervalMs(item: WatchItem): number {
  const sec = item.intervalSec ?? DEFAULT_INTERVAL_SEC[item.source];
  return Math.max(sec, MIN_INTERVAL_SEC) * 1000;
}

function statusOf(item: WatchItem, result: CheckResult): Status {
  if (result.availability !== "in_stock") return result.availability;
  const overMax =
    item.maxPrice !== undefined &&
    result.price !== undefined &&
    result.price > item.maxPrice;
  return overMax ? "in_stock_over_max" : "buyable";
}

export class Monitor {
  private items: WatchItem[] = [];
  private readonly states = new Map<string, ItemState>();
  private readonly hostLastHit = new Map<string, number>();
  private checks = 0;
  private lastHeartbeat: number;

  /** `saved` is what troubled() returned before the last exit, so a restart does not wipe a site's "no". */
  constructor(
    items: WatchItem[],
    private readonly deps: MonitorDeps,
    saved: Record<string, SavedItemState> = {},
  ) {
    this.lastHeartbeat = deps.now();
    this.setItems(items);
    const now = deps.now();
    for (const item of items) {
      const kept = saved[item.id];
      const state = this.states.get(item.id);
      if (!kept || !state) continue;
      state.failures = kept.failures;
      state.stopped = kept.stopped;
      state.error = kept.error;
      state.errorKind = kept.errorKind;
      state.nextAt = Math.min(Math.max(kept.nextAt, now), now + MAX_RETRY_AFTER_MS);
    }
  }

  /** Replaces the watchlist. Items that stay keep their state; new ones are checked at once. */
  setItems(items: WatchItem[]): void {
    this.items = items;
    const ids = new Set(items.map((i) => i.id));
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
    for (const item of items) {
      if (!this.states.has(item.id)) this.states.set(item.id, this.freshState());
    }
  }

  /** Forgets what went wrong with these items and checks them again, for when the cause was fixed. */
  restart(ids: string[]): void {
    for (const id of ids) {
      const state = this.states.get(id);
      if (!state || state.checking) continue;
      this.states.set(id, { ...this.freshState(), status: state.status, price: state.price });
    }
    this.deps.onChange?.();
  }

  /** Items a site is refusing or failing, with when they may be asked again. */
  troubled(): Record<string, SavedItemState> {
    const out: Record<string, SavedItemState> = {};
    for (const [id, s] of this.states) {
      if (s.failures === 0 && !s.stopped) continue;
      out[id] = {
        nextAt: s.nextAt,
        failures: s.failures,
        stopped: s.stopped,
        error: s.error,
        errorKind: s.errorKind,
      };
    }
    return out;
  }

  /** Waits until this host may be asked again and books the slot. Checks and previews share it. */
  async reserveHost(host: string): Promise<void> {
    const now = this.deps.now();
    const at = Math.max(now, (this.hostLastHit.get(host) ?? -Infinity) + HOST_GAP_MS);
    this.hostLastHit.set(host, at);
    if (at > now) await this.deps.sleep(at - now);
  }

  private freshState(): ItemState {
    return { nextAt: this.deps.now(), failures: 0, stopped: false, checking: false };
  }

  snapshot(): ItemSnapshot[] {
    return this.items.map((item) => {
      const s = this.states.get(item.id)!;
      return {
        id: item.id,
        status: s.status,
        price: s.price,
        checkedAt: s.checkedAt,
        nextAt: s.nextAt,
        error: s.error,
        errorKind: s.errorKind,
        stopped: s.stopped,
        checking: s.checking,
      };
    });
  }

  /** Records a result the caller already has (a preview), so a new item is not fetched twice. No alert. */
  prime(id: string, result: CheckResult): void {
    const item = this.items.find((i) => i.id === id);
    const state = this.states.get(id);
    if (!item || !state) return;
    state.status = statusOf(item, result);
    state.price = result.price;
    state.checkedAt = this.deps.now();
    state.nextAt = this.deps.now() + intervalMs(item);
  }

  /** Asks for an early check. Also restarts an item dropwatch had stopped watching. */
  checkNow(id: string): CheckNowOutcome {
    const state = this.states.get(id);
    if (!state || state.checking) return "busy";
    const now = this.deps.now();
    if (state.checkedAt !== undefined && now - state.checkedAt < MANUAL_GAP_MS) return "too_soon";
    // A site that said "slow down" or "no" set a wait. Asking by hand does not shorten it.
    const refused = state.errorKind === "rate_limited" || state.errorKind === "blocked";
    if (refused && state.nextAt > now) return "waiting";
    state.stopped = false;
    // Refusals keep their count, so one more "no" stops the item again.
    if (state.errorKind !== "blocked") state.failures = 0;
    state.nextAt = now;
    this.deps.onChange?.();
    return "queued";
  }

  /** Checks every item that is due. Returns ms until the next item is due. */
  async tick(): Promise<number> {
    for (const item of [...this.items]) {
      const state = this.states.get(item.id);
      if (!state || state.stopped || state.nextAt > this.deps.now()) continue;

      await this.reserveHost(hostOf(item.url));

      this.checks++;
      state.checking = true;
      this.deps.onChange?.();
      try {
        await this.onResult(item, state, await this.deps.check(item));
      } catch (err) {
        this.onError(item, state, err);
      }
      state.checking = false;
      state.checkedAt = this.deps.now();
      this.deps.onChange?.();
    }
    const now = this.deps.now();
    const due = [...this.states.values()].filter((s) => !s.stopped).map((s) => s.nextAt);
    return due.length === 0 ? Infinity : Math.max(Math.min(...due) - now, 0);
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const wait = await this.tick();
      if (wait === Infinity) {
        this.deps.log("nothing left to watch", "info");
        return;
      }
      const now = this.deps.now();
      if (now - this.lastHeartbeat >= HEARTBEAT_MS) {
        this.lastHeartbeat = now;
        this.deps.log(
          `still watching ${this.activeCount()} item(s), ${this.checks} checks so far`,
          "info",
        );
      }
      await this.deps.sleep(Math.max(wait, 1000));
    }
  }

  activeCount(): number {
    return [...this.states.values()].filter((s) => !s.stopped).length;
  }

  private async onResult(item: WatchItem, state: ItemState, result: CheckResult): Promise<void> {
    const status = statusOf(item, result);
    const previous = state.status;
    state.status = status;
    state.price = result.price;
    state.failures = 0;
    state.error = undefined;
    state.errorKind = undefined;
    // +/-10% jitter.
    state.nextAt = this.deps.now() + intervalMs(item) * (0.9 + this.deps.random() * 0.2);

    if (status === previous) return;
    const price = result.price !== undefined ? ` at $${result.price.toFixed(2)}` : "";
    if (status === "buyable") {
      this.deps.log(`IN STOCK: ${item.name}${price}`, "in_stock", item);
      try {
        await this.deps.alert(item, result);
      } catch (err) {
        // A failed alert is not a failed stock check; do not back off for it.
        this.deps.log(
          `alert failed: ${err instanceof Error ? err.message : String(err)}`,
          "alert_failed",
          item,
        );
      }
    } else if (status === "in_stock_over_max") {
      this.deps.log(
        `${item.name}: in stock${price}, above your max of $${item.maxPrice}; no alert`,
        "over_max",
        item,
      );
    } else if (status === "out_of_stock") {
      this.deps.log(`${item.name}: out of stock`, "out_of_stock", item);
    } else {
      this.deps.log(
        `${item.name}: stock unknown${result.detail ? ` (${result.detail})` : ""}`,
        "unknown",
        item,
      );
    }
  }

  private onError(item: WatchItem, state: ItemState, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof SourceError ? err.kind : "network";
    state.failures++;
    state.error = message;
    state.errorKind = kind;

    const permanent =
      kind === "robots" || kind === "restricted" || kind === "config" || kind === "not_found";
    if (permanent || (kind === "blocked" && state.failures >= BLOCKED_LIMIT)) {
      state.stopped = true;
      // How long a person must wait before "try again" asks a site that refused.
      state.nextAt = this.deps.now() + MAX_BACKOFF_MS;
      const hint =
        kind === "blocked"
          ? " Use the retailer's own notify-me or app alerts for this one."
          : "";
      this.deps.log(`${item.name}: stopped watching. ${message}.${hint}`, "stopped", item);
      return;
    }
    const retryAfterMs =
      err instanceof SourceError && err.retryAfterSec !== undefined
        ? Math.min(err.retryAfterSec * 1000, MAX_RETRY_AFTER_MS)
        : 0;
    const backoff = Math.min(intervalMs(item) * 2 ** state.failures, MAX_BACKOFF_MS);
    const delay = Math.max(retryAfterMs, backoff);
    state.nextAt = this.deps.now() + delay;
    this.deps.log(
      `${item.name}: ${message}; trying again in ${Math.round(delay / 1000)}s`,
      "retry",
      item,
    );
  }
}
