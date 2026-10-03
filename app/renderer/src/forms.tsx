// The two things a person adds: a product to watch and a drop-day reminder.

import { useState, type FormEvent } from "react";

import type { Preview } from "../../shared/types.js";
import { call, price } from "./api.js";
import { Button, Field, Lamp } from "./ui.js";

const CHECK_EVERY: Record<string, string> = {
  shopify: "every 30 seconds",
  bestbuy: "every 30 seconds",
  page: "once a minute",
};

/** "$49.99", "49,99" and "49" all mean a price; anything else is a mistake. */
export function parseLimit(raw: string): number | undefined | "invalid" {
  const text = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : "invalid";
}

export function AddProductForm({
  onAdded,
  onReminder,
  onBestBuySetup,
}: {
  onAdded(): void;
  onReminder(url: string, name: string): void;
  onBestBuySetup(): void;
}) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [phrase, setPhrase] = useState("");
  const [usedPhrase, setUsedPhrase] = useState(false);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);

  async function check(link: string, soldOutText?: string) {
    if (!link.trim() || checking) return;
    setChecking(true);
    setError(undefined);
    try {
      const result = await call("previewProduct", link, soldOutText);
      setPreview(result);
      setUsedPhrase(Boolean(soldOutText));
      if (result.kind === "ok") {
        setUrl(result.url);
        setName((current) => current || result.title || "");
      }
    } catch (err) {
      setPreview({ kind: "error", message: (err as Error).message });
    } finally {
      setChecking(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (preview?.kind !== "ok") return;
    const max = parseLimit(limit);
    if (max === "invalid") {
      setError("Type the price limit as a number, like 49.99.");
      return;
    }
    setAdding(true);
    setError(undefined);
    try {
      await call("addProduct", { url: preview.url, name, maxPrice: max });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  const found = preview?.kind === "ok" ? preview : undefined;
  const readable = found && found.availability !== "unknown";

  return (
    <div className="stack">
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void check(url);
        }}
      >
        <Field
          label="Product link"
          hint="Open the product's page in your browser, copy the address from the top, and paste it here."
        >
          {(id) => (
            <div className="inline">
              <input
                id={id}
                type="text"
                inputMode="url"
                autoFocus
                placeholder="https://store.com/products/booster-box"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setPreview(undefined);
                }}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  if (pasted) {
                    event.preventDefault();
                    setUrl(pasted.trim());
                    setPreview(undefined);
                    void check(pasted);
                  }
                }}
              />
              <Button type="submit" variant={found ? "secondary" : "primary"} busy={checking}>
                {checking ? "Checking" : "Check link"}
              </Button>
            </div>
          )}
        </Field>
      </form>

      {preview?.kind === "error" && (
        <p className="notice notice--bad" role="alert">
          {preview.message}
        </p>
      )}

      {preview?.kind === "restricted" && (
        <div className="notice">
          <h3>Dropwatch won't check {preview.name}</h3>
          <p>
            {preview.name} does not allow automated stock checks, and Dropwatch follows each store's rules. What
            works there: {preview.instead}
          </p>
          <p>A reminder can still get you to the page at drop time.</p>
          <div className="actions">
            <Button variant="primary" onClick={() => onReminder(preview.url, `${preview.name} drop`)}>
              Set a reminder instead
            </Button>
          </div>
        </div>
      )}

      {preview?.kind === "needs_key" && (
        <div className="notice">
          <h3>Best Buy needs one extra step</h3>
          <p>
            Best Buy lets apps check stock through its own service, which asks for a free key. Add yours in
            Settings, then come back and paste this link again.
          </p>
          <div className="actions">
            <Button variant="primary" onClick={onBestBuySetup}>
              Open Best Buy setup
            </Button>
          </div>
        </div>
      )}

      {found && !readable && (
        <form
          className="notice stack"
          onSubmit={(event) => {
            event.preventDefault();
            void check(found.url, phrase);
          }}
        >
          <h3>One question about this page</h3>
          <p>
            Dropwatch opened the page but can't tell whether the product is in stock. What words does the page
            show when it is sold out?
          </p>
          <Field label="Sold-out words" hint="Copy them exactly as the page shows them, for example Sold out.">
            {(id) => (
              <div className="inline">
                <input id={id} type="text" value={phrase} onChange={(event) => setPhrase(event.target.value)} />
                <Button type="submit" variant="primary" busy={checking} disabled={!phrase.trim()}>
                  Check again
                </Button>
              </div>
            )}
          </Field>
        </form>
      )}

      {found && readable && (
        <form className="stack" onSubmit={add}>
          <div className={`found${found.availability === "in_stock" ? " found--live" : ""}`}>
            <Lamp tone={found.availability === "in_stock" ? "live" : "off"} />
            <div className="found__text">
              <strong>{found.title ?? found.host}</strong>
              <span>{found.host}</span>
            </div>
            <div className="found__right">
              {found.price !== undefined && <span className="money">{price(found.price)}</span>}
              <span>{found.availability === "in_stock" ? "In stock right now" : "Sold out right now"}</span>
            </div>
          </div>

          {found.availability === "in_stock" && usedPhrase && (
            <p className="hint">
              The page does not show those words at the moment, so Dropwatch reads it as in stock. If it is in
              fact sold out, the words don't match. Copy them exactly and check again.
            </p>
          )}

          <Field label="Name">
            {(id) => (
              <input id={id} type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field
            label="Only alert me at or below this price (optional)"
            hint="Leave it empty to be alerted at any price. Useful on reseller shops that mark prices up."
          >
            {(id) => (
              <div className="money-input">
                <span aria-hidden="true">$</span>
                <input
                  id={id}
                  type="text"
                  inputMode="decimal"
                  placeholder={found.price !== undefined ? found.price.toFixed(2) : "49.99"}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                />
              </div>
            )}
          </Field>

          {error && (
            <p className="notice notice--bad" role="alert">
              {error}
            </p>
          )}

          <div className="actions actions--split">
            <p className="hint">Dropwatch will check this page {CHECK_EVERY[found.source]}.</p>
            <Button type="submit" variant="primary" busy={adding} disabled={!name.trim()}>
              Watch this product
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function ReminderForm({
  initial,
  onSaved,
}: {
  initial?: { url: string; name: string };
  onSaved(): void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [date, setDate] = useState(() => localDate(new Date()));
  const [time, setTime] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!date || !time) {
      setError("Pick a date and a time.");
      return;
    }
    const at = new Date(`${date}T${time}`);
    if (Number.isNaN(at.getTime())) {
      setError("Pick a date and a time.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await call("addReminder", { name, url, at: at.toISOString() });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="stack" noValidate onSubmit={save}>
      <Field label="What is dropping">
        {(id) => (
          <input
            id={id}
            type="text"
            autoFocus
            maxLength={120}
            placeholder="Pokemon Center restock"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="Page to open" hint="The product page, or the store's home page if there is no product page yet.">
        {(id) => (
          <input
            id={id}
            type="text"
            inputMode="url"
            placeholder="https://www.pokemoncenter.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <div className="pair">
        <Field label="Date">
          {(id) => (
            <input id={id} type="date" min={localDate(new Date())} value={date} onChange={(e) => setDate(e.target.value)} />
          )}
        </Field>
        <Field label="Time">
          {(id) => <input id={id} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
        </Field>
      </div>
      <p className="hint">
        Set it five minutes before the drop so you have time to sign in. The computer has to be on, with
        Dropwatch running.
      </p>
      {error && (
        <p className="notice notice--bad" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <Button type="submit" variant="primary" busy={saving} disabled={!name.trim() || !url.trim()}>
          Save reminder
        </Button>
      </div>
    </form>
  );
}
