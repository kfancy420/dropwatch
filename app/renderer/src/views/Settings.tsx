import { useState, type FormEvent } from "react";
import { Check, Copy } from "lucide-react";

import type { AppState, TestAlertResult } from "../../../shared/types.js";
import { call } from "../api.js";
import { Button, Field, Toggle } from "../ui.js";

const NTFY_IOS = "https://apps.apple.com/us/app/ntfy/id1625396347";
const NTFY_ANDROID = "https://play.google.com/store/apps/details?id=io.heckel.ntfy";
const BESTBUY_KEYS = "https://developer.bestbuy.com/";
const REPO = "https://github.com/kfancy420/dropwatch";

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function TestAlert() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestAlertResult>();

  async function send() {
    setBusy(true);
    try {
      setResult(await call("testAlert"));
    } catch (err) {
      setResult({ sent: [], failures: [(err as Error).message] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="test">
      <Button onClick={() => void send()} busy={busy}>
        {busy ? "Sending" : "Send a test alert"}
      </Button>
      <div aria-live="polite">
        {result && result.sent.length > 0 && <p className="hint">Sent: {list(result.sent)}.</p>}
        {result && result.sent.length === 0 && result.failures.length === 0 && (
          <p className="hint">Every alert is switched off, so nothing was sent.</p>
        )}
        {result?.failures.map((failure) => (
          <p key={failure} className="field__error">
            {failure}. Check the setup and your internet connection.
          </p>
        ))}
      </div>
    </div>
  );
}

export function AlertToggles({ state }: { state: AppState }) {
  const { alerts } = state;
  return (
    <div className="toggles">
      <Toggle
        label="Open the product page in my browser"
        hint="The fastest way to the buy button."
        checked={alerts.openBrowser}
        onChange={(openBrowser) => void call("updateAlerts", { openBrowser })}
      />
      <Toggle
        label="Play an alarm sound"
        checked={alerts.sound}
        onChange={(sound) => void call("updateAlerts", { sound })}
      />
      <Toggle
        label="Show a notification on this computer"
        checked={alerts.desktop}
        onChange={(desktop) => void call("updateAlerts", { desktop })}
      />
    </div>
  );
}

export function PhoneSetup({ state }: { state: AppState }) {
  const [copied, setCopied] = useState(false);
  const topic = state.alerts.ntfyTopic;

  if (!topic) {
    return (
      <div className="stack">
        <p>
          Get a buzz on your phone when something comes in stock, even when you are away from the computer. It
          uses a free app called ntfy and takes about two minutes.
        </p>
        <div className="actions actions--start">
          <Button variant="primary" onClick={() => void call("newNtfyTopic")}>
            Set up phone alerts
          </Button>
        </div>
      </div>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(topic!);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Selecting the text by hand still works.
    }
  }

  return (
    <div className="stack">
      <ol className="steps">
        <li>
          <p>Install the free ntfy app on your phone.</p>
          <div className="actions actions--start">
            <Button onClick={() => void call("openExternal", NTFY_IOS)}>iPhone: App Store</Button>
            <Button onClick={() => void call("openExternal", NTFY_ANDROID)}>Android: Google Play</Button>
          </div>
        </li>
        <li>
          <p>In ntfy, tap the plus button and type this topic name exactly:</p>
          <div className="topic">
            <code>{topic}</code>
            <Button onClick={() => void copy()}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="hint">Anyone who knows this name can see your alerts, so keep it to yourself.</p>
        </li>
        <li>
          <p>Send a test alert. Your phone should buzz within a few seconds.</p>
        </li>
      </ol>
      <div className="actions actions--start">
        <Button variant="quiet" onClick={() => void call("clearNtfyTopic")}>
          Turn off phone alerts
        </Button>
      </div>
    </div>
  );
}

function DiscordSetup({ state }: { state: AppState }) {
  const [hook, setHook] = useState("");
  const [error, setError] = useState<string>();
  const saved = state.alerts.discordWebhook;

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await call("updateAlerts", { discordWebhook: hook });
      setHook("");
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (saved) {
    return (
      <div className="stack">
        <p>Alerts are also posted to your Discord channel.</p>
        <div className="actions actions--start">
          <Button variant="quiet" onClick={() => void call("updateAlerts", { discordWebhook: "" })}>
            Turn off Discord alerts
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={save}>
      <Field
        label="Webhook link"
        hint="In Discord: channel settings, Integrations, Webhooks, New webhook, Copy webhook URL."
        error={error}
      >
        {(id) => (
          <div className="inline">
            <input
              id={id}
              type="text"
              placeholder="https://discord.com/api/webhooks/..."
              value={hook}
              onChange={(e) => setHook(e.target.value)}
            />
            <Button type="submit" disabled={!hook.trim()}>
              Save webhook
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}

function BestBuySetup({ state }: { state: AppState }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await call("setBestBuyKey", key);
      setKey("");
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (state.hasBestBuyKey) {
    return (
      <div className="stack">
        <p>A Best Buy key is saved. Paste a bestbuy.com product link on the watchlist to watch it.</p>
        <div className="actions actions--start">
          <Button variant="quiet" onClick={() => void call("setBestBuyKey", "")}>
            Remove the key
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={save}>
      <p>
        Best Buy offers its own service for checking stock, and it needs a free key. Sign up on Best Buy's
        developer site, then paste the key here. Best Buy decides who gets a key, so this may not work for
        everyone. Most people can skip it.
      </p>
      <div className="actions actions--start">
        <Button onClick={() => void call("openExternal", BESTBUY_KEYS)}>Open Best Buy's developer site</Button>
      </div>
      <Field label="Best Buy key" error={error}>
        {(id) => (
          <div className="inline">
            <input id={id} type="text" value={key} onChange={(e) => setKey(e.target.value)} />
            <Button type="submit" disabled={!key.trim()}>
              Save key
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}

export function Settings({ state }: { state: AppState }) {
  return (
    <>
      <header className="view__head">
        <div>
          <h1>Settings</h1>
        </div>
      </header>

      <section className="panel">
        <h2>When something comes in stock</h2>
        <AlertToggles state={state} />
        <TestAlert />
      </section>

      <section className="panel">
        <h2>Alerts on your phone</h2>
        <PhoneSetup state={state} />
      </section>

      <section className="panel">
        <h2>Discord</h2>
        <DiscordSetup state={state} />
      </section>

      <section className="panel" id="bestbuy">
        <h2>Best Buy</h2>
        <BestBuySetup state={state} />
      </section>

      <section className="panel">
        <h2>This app</h2>
        <Toggle
          label={state.platform === "darwin" ? "Open Dropwatch when I log in" : "Start Dropwatch when I sign in to Windows"}
          hint={
            state.canLaunchAtLogin
              ? "It starts quietly next to the clock and keeps watching."
              : "Available in the installed app."
          }
          checked={state.launchAtLogin}
          disabled={!state.canLaunchAtLogin}
          onChange={(on) => void call("setLaunchAtLogin", on)}
        />
        <div className="about">
          <span>Dropwatch {state.version}</span>
          <Button variant="quiet" onClick={() => void call("openExternal", REPO)}>
            View on GitHub
          </Button>
        </div>
      </section>
    </>
  );
}
