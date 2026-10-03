import { useCallback, useEffect, useRef, useState } from "react";
import { AlarmClock, BookOpen, History, Layers, Settings as SettingsIcon } from "lucide-react";

import { call, useAppState } from "./api.js";
import { AddProductForm, ReminderForm } from "./forms.js";
import { Onboarding } from "./Onboarding.js";
import { Button, Dialog, Lamp, Mark } from "./ui.js";
import { Activity } from "./views/Activity.js";
import { Guide } from "./views/Guide.js";
import { Reminders } from "./views/Reminders.js";
import { Settings } from "./views/Settings.js";
import { Watchlist } from "./views/Watchlist.js";

type View = "watchlist" | "reminders" | "activity" | "guide" | "settings";

const NAV: Array<{ view: View; label: string; icon: typeof Layers }> = [
  { view: "watchlist", label: "Watchlist", icon: Layers },
  { view: "reminders", label: "Reminders", icon: AlarmClock },
  { view: "activity", label: "Activity", icon: History },
  { view: "guide", label: "Drop-day guide", icon: BookOpen },
  { view: "settings", label: "Settings", icon: SettingsIcon },
];

export function App() {
  const state = useAppState();
  const [view, setView] = useState<View>("watchlist");
  const [adding, setAdding] = useState(false);
  const [reminder, setReminder] = useState<{ url: string; name: string } | "new">();
  const [toast, setToast] = useState<string>();
  const toastTimer = useRef<number | undefined>(undefined);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    void main.current?.scrollTo(0, 0);
  }, [view]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(undefined), 4500);
  }, []);

  if (!state) return <div className="titlebar" />;

  const startReminder = (url: string, name: string) => {
    setAdding(false);
    setView("reminders");
    setReminder({ url, name });
  };
  const startBestBuy = () => {
    setAdding(false);
    setView("settings");
    window.setTimeout(() => document.getElementById("bestbuy")?.scrollIntoView({ block: "start" }), 50);
  };

  const live = state.products.filter((p) => p.status === "buyable" && !p.stopped).length;
  const count = state.products.length;
  const watching = state.paused
    ? "Paused"
    : count === 0
      ? "Nothing to watch yet"
      : `Watching ${count} product${count === 1 ? "" : "s"}`;

  return (
    <div className="shell">
      <div className="titlebar" />

      <aside className="side" inert={!state.onboarded}>
        <div className="brand">
          <Mark />
          <span>Dropwatch</span>
        </div>
        <nav aria-label="Sections">
          {NAV.map(({ view: target, label, icon: Icon }) => (
            <button
              key={target}
              type="button"
              className="nav"
              aria-current={view === target ? "page" : undefined}
              onClick={() => setView(target)}
            >
              <Icon size={17} />
              <span>{label}</span>
              {target === "watchlist" && live > 0 && <span className="nav__badge">{live} in stock</span>}
            </button>
          ))}
        </nav>
        <div className="side__status">
          <div className="side__watching">
            <Lamp tone={state.paused ? "idle" : count === 0 ? "off" : "live"} />
            <span>{watching}</span>
          </div>
          <Button onClick={() => void call("setPaused", !state.paused)}>
            {state.paused ? "Resume watching" : "Pause watching"}
          </Button>
        </div>
      </aside>

      <main className="view" ref={main} inert={!state.onboarded}>
        {state.update && (
          <div className="banner">
            <span>Dropwatch {state.update.version} is available.</span>
            <Button onClick={() => void call("openExternal", state.update!.url)}>Get the update</Button>
          </div>
        )}
        {view === "watchlist" && <Watchlist state={state} onAdd={() => setAdding(true)} onToast={showToast} />}
        {view === "reminders" && <Reminders state={state} onAdd={() => setReminder("new")} />}
        {view === "activity" && <Activity state={state} />}
        {view === "guide" && <Guide />}
        {view === "settings" && <Settings state={state} />}
      </main>

      <Dialog open={adding} title="Add a product" onClose={() => setAdding(false)} wide>
        <AddProductForm
          onAdded={() => {
            setAdding(false);
            setView("watchlist");
          }}
          onReminder={startReminder}
          onBestBuySetup={startBestBuy}
        />
      </Dialog>

      <Dialog open={reminder !== undefined} title="Add a reminder" onClose={() => setReminder(undefined)}>
        <ReminderForm
          initial={typeof reminder === "object" ? reminder : undefined}
          onSaved={() => setReminder(undefined)}
        />
      </Dialog>

      {!state.onboarded && (
        <Onboarding state={state} onReminder={startReminder} onBestBuySetup={startBestBuy} />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
