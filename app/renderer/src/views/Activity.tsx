import type { ActivityEntry, ActivityKind, AppState } from "../../../shared/types.js";
import { call } from "../api.js";
import { Button, Empty, Lamp, type LampTone } from "../ui.js";

const TONE: Record<ActivityKind, LampTone> = {
  in_stock: "live",
  over_max: "warn",
  out_of_stock: "off",
  problem: "stop",
  reminder: "busy",
  info: "idle",
};

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

function dayLabel(at: number): string {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(new Date(at))) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return DAY.format(at);
}

function groupByDay(entries: ActivityEntry[]): Array<[string, ActivityEntry[]]> {
  const groups: Array<[string, ActivityEntry[]]> = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at);
    const last = groups.at(-1);
    if (last && last[0] === label) last[1].push(entry);
    else groups.push([label, [entry]]);
  }
  return groups;
}

export function Activity({ state }: { state: AppState }) {
  return (
    <>
      <header className="view__head">
        <div>
          <h1>Activity</h1>
          <p className="view__sub">What Dropwatch has seen and done, newest first.</p>
        </div>
        {state.activity.length > 0 && <Button onClick={() => void call("clearActivity")}>Clear activity</Button>}
      </header>

      {state.activity.length === 0 ? (
        <Empty title="Nothing has happened yet">
          <p>Stock changes, alerts and problems show up here as they happen.</p>
        </Empty>
      ) : (
        groupByDay(state.activity).map(([label, entries]) => (
          <section key={label}>
            <h2 className="group">{label}</h2>
            <ul className="log">
              {entries.map((entry) => (
                <li key={entry.id} className="log__item">
                  <time className="log__time">{TIME.format(entry.at)}</time>
                  <Lamp tone={TONE[entry.kind] ?? "idle"} />
                  <div>
                    <strong>{entry.title}</strong>
                    <p>{entry.text}</p>
                  </div>
                  {entry.url && entry.kind === "in_stock" && (
                    <Button onClick={() => void call("openExternal", entry.url!)}>Open page</Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
