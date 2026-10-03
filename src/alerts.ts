// Alert channels. Each one is independent: a failed phone push must not stop
// the browser from opening.

import { spawn as nodeSpawn } from "node:child_process";

import type { AlertSettings, CheckResult, WatchItem } from "./types.js";

export type PostLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export type SpawnLike = (command: string, args: string[]) => void;

export interface AlertDeps {
  post: PostLike;
  spawn: SpawnLike;
  log(line: string): void;
  platform: NodeJS.Platform;
  bell(): void;
}

const defaultSpawn: SpawnLike = (command, args) => {
  const child = nodeSpawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
};

export const defaultAlertDeps: AlertDeps = {
  post: (url, init) => fetch(url, init),
  spawn: defaultSpawn,
  log: (line) => process.stderr.write(`${line}\n`),
  platform: process.platform,
  bell: () => process.stderr.write("\x07"),
};

export function alertText(item: WatchItem, result: CheckResult): string {
  const price = result.price !== undefined ? ` at $${result.price.toFixed(2)}` : "";
  return `IN STOCK: ${item.name}${price}`;
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function openInBrowser(url: string, deps: AlertDeps): void {
  // Only ever hand a web address to the OS, never an arbitrary string.
  if (!isHttpUrl(url)) return;
  if (deps.platform === "win32") {
    deps.spawn("rundll32", ["url.dll,FileProtocolHandler", url]);
  } else if (deps.platform === "darwin") {
    deps.spawn("open", [url]);
  } else {
    deps.spawn("xdg-open", [url]);
  }
}

export function playSound(deps: AlertDeps): void {
  deps.bell();
  if (deps.platform === "win32") {
    deps.spawn("powershell", [
      "-NoProfile",
      "-Command",
      "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav').PlaySync()",
    ]);
  } else if (deps.platform === "darwin") {
    deps.spawn("afplay", ["/System/Library/Sounds/Sosumi.aiff"]);
  }
}

async function postJson(url: string, body: unknown, deps: AlertDeps): Promise<void> {
  const res = await deps.post(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`answered ${res.status}`);
}

export async function sendAlerts(
  settings: AlertSettings,
  alert: { text: string; url: string },
  deps: AlertDeps = defaultAlertDeps,
): Promise<void> {
  const { text, url } = alert;

  // Browser first: it is the step the buyer is waiting on.
  if (settings.openBrowser) openInBrowser(url, deps);
  if (settings.sound) playSound(deps);

  const pushes: Array<[string, Promise<void>]> = [];
  if (settings.ntfyTopic) {
    pushes.push([
      "ntfy",
      postJson(
        settings.ntfyServer ?? "https://ntfy.sh",
        {
          topic: settings.ntfyTopic,
          title: text,
          message: url,
          priority: 5,
          click: url,
          tags: ["rotating_light"],
        },
        deps,
      ),
    ]);
  }
  if (settings.discordWebhook) {
    pushes.push([
      "Discord",
      // The text carries a name taken from a web page; it must not be able to ping a channel.
      postJson(
        settings.discordWebhook,
        { content: `${text}\n${url}`, allowed_mentions: { parse: [] } },
        deps,
      ),
    ]);
  }
  const outcomes = await Promise.allSettled(pushes.map(([, p]) => p));
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      deps.log(`${pushes[i]![0]} alert failed: ${reason}`);
    }
  });
}
