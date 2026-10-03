import { Trash2 } from "lucide-react";

import type { AppState, ReminderView } from "../../../shared/types.js";
import { call, until, useNow } from "../api.js";
import { Button, Empty, IconButton, Lamp } from "../ui.js";

const WHEN = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function Countdown({ at }: { at: number }) {
  const now = useNow();
  return <span>in {until(at, now)}</span>;
}

function ReminderRow({ reminder }: { reminder: ReminderView }) {
  const at = new Date(reminder.at).getTime();
  return (
    <li className={`row${reminder.done ? " row--past" : ""}`}>
      <Lamp tone={reminder.done ? "idle" : "busy"} />
      <div className="row__main">
        <div className="row__name">{reminder.name}</div>
        <div className="row__meta">
          <span>{reminder.host}</span>
        </div>
      </div>
      <div className="row__figures">
        <span className="when">{WHEN.format(at)}</span>
        <span className="status">{reminder.done ? "Done" : <Countdown at={at} />}</span>
      </div>
      <div className="row__actions">
        <Button onClick={() => void call("openExternal", reminder.url)}>Open page</Button>
        <IconButton label="Delete reminder" onClick={() => void call("removeReminder", reminder.id)}>
          <Trash2 size={16} />
        </IconButton>
      </div>
    </li>
  );
}

export function Reminders({ state, onAdd }: { state: AppState; onAdd(): void }) {
  const byTime = (a: ReminderView, b: ReminderView) => new Date(a.at).getTime() - new Date(b.at).getTime();
  const upcoming = state.reminders.filter((r) => !r.done).sort(byTime);
  const past = state.reminders.filter((r) => r.done).sort((a, b) => byTime(b, a));

  return (
    <>
      <header className="view__head">
        <div>
          <h1>Reminders</h1>
          <p className="view__sub">
            Big stores such as Pokemon Center, Target and Walmart don't allow automated stock checks. Set a
            reminder for the drop time and Dropwatch alerts you at that minute.
          </p>
        </div>
        {state.reminders.length > 0 && (
          <Button variant="primary" onClick={onAdd}>
            Add a reminder
          </Button>
        )}
      </header>

      {state.reminders.length === 0 ? (
        <Empty title="No reminders set">
          <p>Know when a drop is happening? Add it here and be on the page when it starts.</p>
          <Button variant="primary" onClick={onAdd}>
            Add a reminder
          </Button>
        </Empty>
      ) : (
        <>
          {upcoming.length > 0 && (
            <ul className="rows">
              {upcoming.map((r) => (
                <ReminderRow key={r.id} reminder={r} />
              ))}
            </ul>
          )}
          {past.length > 0 && (
            <>
              <h2 className="group">Earlier</h2>
              <ul className="rows">
                {past.map((r) => (
                  <ReminderRow key={r.id} reminder={r} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
