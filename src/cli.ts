// `dropwatch` — restock monitor entry point.
//
// Watches a list of product pages and tells a person the moment one is
// buyable. It never adds to cart, never checks out and never disguises itself.

import { Command, InvalidArgumentError } from "commander";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import pkg from "../package.json";
import { alertText, defaultAlertDeps, sendAlerts } from "./alerts.js";
import { configPath, loadConfig, newItemId, saveConfig } from "./config.js";
import { hostOf, SourceError } from "./http.js";
import { intervalMs, Monitor } from "./monitor.js";
import { isJsonOutput, printRows } from "./output.js";
import { parseWhen, splitDue } from "./reminders.js";
import { restrictedRetailer } from "./retailers.js";
import { bestBuySku } from "./sources/bestbuy.js";
import { checkItem, detectSource } from "./sources/index.js";
import { MIN_INTERVAL_SEC, type CheckResult, type Config, type WatchItem } from "./types.js";

const say = (line: string) => process.stderr.write(`${line}\n`);
const stamp = () => new Date().toTimeString().slice(0, 8);

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive number");
  return n;
}

function describe(result: CheckResult): string {
  const price = result.price !== undefined ? ` at $${result.price.toFixed(2)}` : "";
  if (result.availability === "in_stock") return `IN STOCK${price}`;
  if (result.availability === "out_of_stock") return "out of stock";
  return `unknown${result.detail ? ` (${result.detail})` : ""}`;
}

function alertChannels(config: Config): string {
  const on = [
    config.alerts.openBrowser && "opens the product page",
    config.alerts.sound && "alarm sound",
    config.alerts.ntfyTopic && "phone push (ntfy)",
    config.alerts.discordWebhook && "Discord",
  ].filter(Boolean);
  return on.length > 0 ? on.join(", ") : "none (console only)";
}

async function addItem(
  url: string,
  opts: {
    name?: string;
    maxPrice?: number;
    variant?: string;
    interval?: number;
    soldOutText?: string;
    config?: string;
  },
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a web address`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("only http and https addresses can be watched");
  }
  const restricted = restrictedRetailer(parsed.hostname);
  if (restricted) {
    throw new Error(
      `dropwatch does not check ${restricted.name}: its terms or its bot protection rule out automated checks.\n` +
        `What works instead: ${restricted.instead}\n` +
        `For a drop with a known time, set a reminder: dropwatch remind "<name>" --at "<date time>" --url ${url}`,
    );
  }

  const path = configPath(opts.config);
  const config = loadConfig(path);
  const source = await detectSource(url);
  const item: WatchItem = {
    id: "",
    name: opts.name ?? "",
    url,
    source,
    ...(source === "bestbuy" && { sku: bestBuySku(url) }),
    ...(opts.variant && { variant: opts.variant }),
    ...(opts.maxPrice !== undefined && { maxPrice: opts.maxPrice }),
    ...(opts.interval !== undefined && { intervalSec: Math.max(opts.interval, MIN_INTERVAL_SEC) }),
    ...(opts.soldOutText && { soldOutText: opts.soldOutText }),
  };

  // One live check up front, so a page we are not allowed to read is rejected
  // now and not discovered at 3am.
  let first: CheckResult | undefined;
  try {
    first = await checkItem(item, config);
  } catch (err) {
    const needsKey = err instanceof SourceError && err.kind === "config" && source === "bestbuy" && !config.bestBuyApiKey;
    if (!needsKey) throw err;
    say(`note: ${err.message}`);
  }
  item.name ||= first?.title ?? `${parsed.hostname}${parsed.pathname}`;
  item.id = newItemId(item.name, config.items);
  config.items.push(item);
  saveConfig(path, config);
  say(`added "${item.name}" (${source}, every ${intervalMs(item) / 1000}s)${first ? `: ${describe(first)}` : ""}`);
  if (source === "bestbuy") {
    say(
      "note: Best Buy sells high-demand Pokemon releases by invitation. If the product page shows an Invite button, request the invite there; stock checks cannot see invitations.",
    );
  }
}

async function checkAll(opts: { config?: string; json?: boolean }): Promise<void> {
  const config = loadConfig(configPath(opts.config));
  const rows: Array<Record<string, string>> = [];
  for (const item of config.items) {
    let status: string;
    try {
      status = describe(await checkItem(item, config));
    } catch (err) {
      status = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    rows.push({ id: item.id, name: item.name, store: hostOf(item.url), status });
  }
  printRows(rows, ["id", "name", "store", "status"], opts.json);
}

const pendingReminders = (config: Config) => (config.reminders ?? []).filter((r) => !r.done);

async function watch(opts: { config?: string }): Promise<void> {
  const path = configPath(opts.config);
  const config = loadConfig(path);
  if (config.items.length === 0 && pendingReminders(config).length === 0) {
    throw new Error("the watchlist is empty; add a product with: dropwatch add <product-url>");
  }
  say(`dropwatch ${pkg.version}: watching ${config.items.length} item(s)`);
  for (const item of config.items) {
    say(`  ${item.name}  [${hostOf(item.url)}, every ${intervalMs(item) / 1000}s]`);
  }
  for (const r of pendingReminders(config)) {
    say(`  reminder: ${r.name}  [${new Date(r.at).toLocaleString()}]`);
  }
  say(`alerts: ${alertChannels(config)}`);
  say("before a drop: be signed in at each store with your address and payment saved.");
  say("press Ctrl+C to stop.\n");

  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  const log = (line: string) => say(`[${stamp()}] ${line}`);
  const sleep = (ms: number) =>
    new Promise<void>((done) => {
      const timer = setTimeout(done, ms);
      stop.signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
    });
  const alertLog = join(dirname(path), "dropwatch-alerts.log");
  const fire = async (text: string, url: string) => {
    appendFileSync(alertLog, `${new Date().toISOString()} ${text} ${url}\n`);
    await sendAlerts(config.alerts, { text, url });
  };

  const monitor = new Monitor(config.items, {
    check: (item) => checkItem(item, config),
    alert: (item, result) => fire(alertText(item, result), item.url),
    log,
    now: () => Date.now(),
    sleep,
    random: Math.random,
  });

  const remind = async () => {
    while (!stop.signal.aborted) {
      // Re-read the file each pass so reminders added while watching count.
      const current = loadConfig(path);
      const { due, missed, pending } = splitDue(current.reminders ?? [], Date.now());
      for (const r of missed) log(`missed reminder (dropwatch was not running): ${r.name}`);
      for (const r of due) {
        log(`REMINDER: ${r.name}`);
        await fire(`REMINDER: ${r.name}`, r.url);
      }
      if (due.length + missed.length > 0) {
        for (const r of [...due, ...missed]) r.done = true;
        saveConfig(path, current);
      }
      if (pending.length === 0) return;
      await sleep(5000);
    }
  };

  await Promise.all([config.items.length > 0 ? monitor.run(stop.signal) : undefined, remind()]);
}

function addReminder(name: string, opts: { at: string; url: string; config?: string }): void {
  const path = configPath(opts.config);
  const config = loadConfig(path);
  const when = parseWhen(opts.at, Date.now());
  const protocol = URL.canParse(opts.url) ? new URL(opts.url).protocol : "";
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`"${opts.url}" is not a web address`);
  }
  const reminders = config.reminders ?? [];
  const id = newItemId(name, [...config.items, ...reminders]);
  reminders.push({ id, name, url: opts.url, at: when.toISOString() });
  saveConfig(path, { ...config, reminders });
  say(`reminder set: "${name}" at ${when.toLocaleString()}. It fires while "dropwatch watch" is running.`);
}

function settings(opts: {
  config?: string;
  ntfy?: string;
  discord?: string;
  bestbuyKey?: string;
  sound?: boolean;
  open?: boolean;
}): void {
  const path = configPath(opts.config);
  const config = loadConfig(path);
  if (opts.ntfy !== undefined) {
    // ntfy topics are open to anyone who knows the name, so "auto" makes an
    // unguessable one.
    const topic = opts.ntfy === "auto" ? `dropwatch-${randomBytes(9).toString("base64url")}` : opts.ntfy;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
      throw new Error("an ntfy topic may only contain letters, digits, - and _");
    }
    config.alerts.ntfyTopic = topic;
    say(`phone push on. In the ntfy app, subscribe to the topic: ${topic}`);
  }
  if (opts.discord !== undefined) {
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(opts.discord)) {
      throw new Error("that does not look like a Discord webhook URL");
    }
    config.alerts.discordWebhook = opts.discord;
  }
  if (opts.bestbuyKey !== undefined) config.bestBuyApiKey = opts.bestbuyKey;
  if (opts.sound !== undefined) config.alerts.sound = opts.sound;
  if (opts.open !== undefined) config.alerts.openBrowser = opts.open;
  saveConfig(path, config);
  say(`alerts: ${alertChannels(config)}`);
  say(`Best Buy API key: ${config.bestBuyApiKey ? "saved" : "not set"}`);
}

async function testAlert(opts: { config?: string }): Promise<void> {
  const config = loadConfig(configPath(opts.config));
  say(`sending a test through: ${alertChannels(config)}`);
  await sendAlerts(
    config.alerts,
    { text: "dropwatch test alert", url: config.items[0]?.url ?? "https://ntfy.sh/" },
    defaultAlertDeps,
  );
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("dropwatch")
    .description(
      "Restock monitor for trading-card drops. Watches stock politely and alerts you; you do the buying.",
    )
    .version(pkg.version);
  const withConfig = (cmd: Command) =>
    cmd.option("--config <path>", "watchlist file (default: ./dropwatch.json)");

  withConfig(program.command("add <url>"))
    .description("add a product page to the watchlist")
    .option("--name <name>", "label shown in alerts (default: the product title)")
    .option("--max-price <dollars>", "do not alert above this price", positiveNumber)
    .option("--variant <id>", "Shopify variant id to watch (default: any variant)")
    .option("--interval <seconds>", `seconds between checks (minimum ${MIN_INTERVAL_SEC})`, positiveNumber)
    .option("--sold-out-text <text>", "phrase that means sold out, for pages without stock data")
    .action(addItem);

  withConfig(program.command("list"))
    .description("show the watchlist")
    .option("--json", "force JSON output")
    .action((opts: { config?: string; json?: boolean }) => {
      const config = loadConfig(configPath(opts.config));
      const reminders = pendingReminders(config);
      if (isJsonOutput(opts.json)) {
        return printRows([...config.items, ...reminders], [], true);
      }
      printRows(
        [
          ...config.items.map((i) => ({
            id: i.id,
            name: i.name,
            store: hostOf(i.url),
            checks: `${i.source}, every ${intervalMs(i) / 1000}s`,
            "max price": i.maxPrice !== undefined ? `$${i.maxPrice}` : "",
          })),
          ...reminders.map((r) => ({
            id: r.id,
            name: r.name,
            store: hostOf(r.url),
            checks: `reminder at ${new Date(r.at).toLocaleString()}`,
          })),
        ],
        ["id", "name", "store", "checks", "max price"],
      );
    });

  withConfig(program.command("remove <id>"))
    .description("remove a product or reminder from the watchlist")
    .action((id: string, opts: { config?: string }) => {
      const path = configPath(opts.config);
      const config = loadConfig(path);
      const items = config.items.filter((i) => i.id !== id);
      const reminders = (config.reminders ?? []).filter((r) => r.id !== id);
      if (items.length === config.items.length && reminders.length === (config.reminders ?? []).length) {
        throw new Error(`nothing on the watchlist has the id "${id}"`);
      }
      saveConfig(path, { ...config, items, reminders });
      say(`removed ${id}`);
    });

  withConfig(program.command("remind <name>"))
    .description("alert at a set time, for drops at stores dropwatch does not check")
    .requiredOption("--at <when>", 'local date and time, e.g. "2026-11-14 08:55"')
    .requiredOption("--url <url>", "page to open when the reminder fires")
    .action(addReminder);

  withConfig(program.command("check"))
    .description("check every item once and print its status")
    .option("--json", "force JSON output")
    .action(checkAll);

  withConfig(program.command("watch"))
    .description("keep watching and alert when something comes into stock")
    .action(watch);

  withConfig(program.command("settings"))
    .description("choose how you are alerted")
    .option("--ntfy <topic>", 'phone push through the free ntfy app; "auto" picks a private topic')
    .option("--discord <webhook-url>", "post alerts to a Discord channel")
    .option("--bestbuy-key <key>", "free API key from developer.bestbuy.com")
    .option("--sound", "play an alarm sound")
    .option("--no-sound", "do not play a sound")
    .option("--open", "open the product page in your browser")
    .option("--no-open", "do not open the browser")
    .action(settings);

  withConfig(program.command("test-alert"))
    .description("fire every alert channel once so you know they work")
    .action(testAlert);

  return program;
}

const QUICK_START = `dropwatch ${pkg.version}: tells you the moment a product is back in stock.

Quick start (open a terminal in this folder and run):
  dropwatch add <product-url>      add a product page to watch
  dropwatch settings --ntfy auto   turn on phone alerts (free ntfy app)
  dropwatch test-alert             make sure the alerts reach you
  dropwatch watch                  start watching

Run "dropwatch --help" for everything else.`;

async function main(): Promise<void> {
  // Double-clicking the program runs it with no arguments: start watching if
  // there is a watchlist, otherwise explain and keep the window open.
  if (process.argv.length <= 2) {
    const config = loadConfig(configPath());
    if (config.items.length > 0 || pendingReminders(config).length > 0) return watch({});
    say(QUICK_START);
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      await new Promise((done) => rl.question("\nPress Enter to close.", done));
      rl.close();
    }
    return;
  }
  await buildProgram().parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
