// What the window and the background process say to each other.

import type { CheckNowOutcome, Status } from "../../src/monitor.js";
import type { Availability, SourceType } from "../../src/types.js";

export type { CheckNowOutcome, Status };

export interface ProductView {
  id: string;
  name: string;
  url: string;
  host: string;
  source: SourceType;
  maxPrice?: number;
  status?: Status;
  price?: number;
  checkedAt?: number;
  nextAt: number;
  /** Plain-language description of what is wrong, when something is. */
  problem?: string;
  stopped: boolean;
  checking: boolean;
}

export interface ReminderView {
  id: string;
  name: string;
  url: string;
  host: string;
  at: string;
  done: boolean;
}

export type ActivityKind =
  | "in_stock"
  | "over_max"
  | "out_of_stock"
  | "problem"
  | "reminder"
  | "info";

export interface ActivityEntry {
  id: number;
  at: number;
  kind: ActivityKind;
  title: string;
  text: string;
  url?: string;
}

export interface AlertsView {
  openBrowser: boolean;
  sound: boolean;
  desktop: boolean;
  ntfyTopic?: string;
  discordWebhook?: string;
}

/** The part of the state the engine owns. */
export interface EngineState {
  products: ProductView[];
  reminders: ReminderView[];
  alerts: AlertsView;
  hasBestBuyKey: boolean;
  paused: boolean;
  onboarded: boolean;
  activity: ActivityEntry[];
}

export interface AppState extends EngineState {
  version: string;
  platform: string;
  launchAtLogin: boolean;
  /** False when running unpackaged, where a login item would point at the wrong program. */
  canLaunchAtLogin: boolean;
  update?: { version: string; url: string };
}

export type Preview =
  | {
      kind: "ok";
      url: string;
      host: string;
      source: SourceType;
      title?: string;
      price?: number;
      availability: Availability;
    }
  | { kind: "restricted"; url: string; name: string; instead: string }
  | { kind: "needs_key" }
  | { kind: "error"; message: string };

export interface TestAlertResult {
  sent: string[];
  failures: string[];
}

export interface Methods {
  getState(): AppState;
  previewProduct(url: string, soldOutText?: string): Preview;
  addProduct(input: { url: string; name: string; maxPrice?: number }): void;
  updateProduct(id: string, patch: { name: string; maxPrice?: number }): void;
  removeProduct(id: string): void;
  checkNow(id: string): CheckNowOutcome;
  addReminder(input: { name: string; url: string; at: string }): void;
  removeReminder(id: string): void;
  updateAlerts(patch: {
    openBrowser?: boolean;
    sound?: boolean;
    desktop?: boolean;
    discordWebhook?: string;
  }): void;
  newNtfyTopic(): void;
  clearNtfyTopic(): void;
  setBestBuyKey(key: string): void;
  testAlert(): TestAlertResult;
  setPaused(paused: boolean): void;
  setLaunchAtLogin(on: boolean): void;
  openExternal(url: string): void;
  completeOnboarding(): void;
  clearActivity(): void;
}

export type MethodName = keyof Methods;

export type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Bridge {
  call<K extends MethodName>(
    method: K,
    ...args: Parameters<Methods[K]>
  ): Promise<CallResult<ReturnType<Methods[K]>>>;
  onState(listener: (state: AppState) => void): () => void;
  onSound(listener: () => void): () => void;
}
