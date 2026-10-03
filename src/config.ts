// dropwatch.json: the watchlist and alert settings. Lives in the folder
// dropwatch is run from, so the program and its list travel together.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Config } from "./types.js";

export const CONFIG_FILE = "dropwatch.json";

export function configPath(explicit?: string): string {
  return resolve(explicit ?? process.env.DROPWATCH_CONFIG ?? CONFIG_FILE);
}

export function defaultConfig(): Config {
  return { items: [], alerts: { openBrowser: true, sound: true } };
}

/** The file was read, but what it holds is not a dropwatch list. */
export class ConfigCorruptError extends Error {}

/**
 * Throws ConfigCorruptError when the file's contents are damaged. A file that
 * could not be read at all (locked, no permission) throws the system's own
 * error instead: the list inside it may be fine.
 */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) return defaultConfig();
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigCorruptError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigCorruptError(`${path} does not hold a dropwatch list`);
  }
  const saved = parsed as Partial<Config>;
  const base = defaultConfig();
  const alerts = saved.alerts && typeof saved.alerts === "object" ? saved.alerts : {};
  return {
    ...saved,
    items: Array.isArray(saved.items) ? saved.items : [],
    alerts: { ...base.alerts, ...alerts },
  };
}

const RENAME_TRIES = 5;
const RENAME_WAIT_MS = 40;

export function saveConfig(path: string, config: Config): void {
  // Write-then-rename so a crash mid-write cannot leave a half-written list.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      // On Windows a virus scanner or a sync tool can hold the file for a moment.
      const code = (err as NodeJS.ErrnoException).code;
      const held = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!held || attempt >= RENAME_TRIES) throw err;
      pause(RENAME_WAIT_MS);
    }
  }
}

/** Blocks for a moment. Only for the short waits around a file someone else is holding. */
export function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function newItemId(name: string, existing: Array<{ id: string }>): string {
  const slug =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item";
  const taken = new Set(existing.map((i) => i.id));
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}
