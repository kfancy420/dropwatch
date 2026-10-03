import { useMemo, useState, type FormEvent } from "react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";

import type { AppState, ProductView } from "../../../shared/types.js";
import { ago, call, price, until, useNow } from "../api.js";
import { parseLimit } from "../forms.js";
import { Button, Dialog, Empty, Field, IconButton, Lamp, type LampTone } from "../ui.js";

function tone(p: ProductView, paused: boolean): LampTone {
  if (p.stopped) return "stop";
  if (p.status === "buyable") return "live";
  if (paused) return "idle";
  if (p.problem || p.status === "in_stock_over_max" || p.status === "unknown") return "warn";
  if (p.status === "out_of_stock") return "off";
  return "busy";
}

function statusText(p: ProductView): string {
  if (p.stopped) return "Stopped";
  switch (p.status) {
    case "buyable":
      return "In stock";
    case "in_stock_over_max":
      return "Over your limit";
    case "out_of_stock":
      return "Sold out";
    case "unknown":
      return "Can't read stock";
    default:
      return "Checking";
  }
}

const RANK: Record<string, number> = { buyable: 0, in_stock_over_max: 1 };

function Checked({ product }: { product: ProductView }) {
  const now = useNow();
  if (product.checking) return <span>Checking now</span>;
  if (product.checkedAt === undefined) return <span>Not checked yet</span>;
  return <span>Checked {ago(product.checkedAt, now)}</span>;
}

function NextTry({ at }: { at: number }) {
  const now = useNow();
  return <> Next try in {until(at, now)}.</>;
}

function Row({
  product,
  paused,
  onEdit,
  onRemove,
  onToast,
}: {
  product: ProductView;
  paused: boolean;
  onEdit(): void;
  onRemove(): void;
  onToast(text: string): void;
}) {
  const live = product.status === "buyable" && !product.stopped;

  async function checkNow() {
    const outcome = await call("checkNow", product.id).catch(() => undefined);
    if (outcome === "too_soon") {
      onToast("Checked a moment ago. Dropwatch waits 15 seconds between checks you ask for.");
    } else if (outcome === "waiting") {
      onToast(`${product.host} asked Dropwatch to wait. You can try again in ${until(product.nextAt, Date.now())}.`);
    }
  }

  return (
    <li className={`row${live ? " row--live" : ""}`}>
      <Lamp tone={tone(product, paused)} />
      <div className="row__main">
        <div className="row__name">{product.name}</div>
        <div className="row__meta">
          <span>{product.host}</span>
          <Checked product={product} />
        </div>
        {product.problem && (
          <p className={`row__problem${product.stopped ? " row__problem--stopped" : ""}`}>
            {product.problem}
            {!product.stopped && <NextTry at={product.nextAt} />}
          </p>
        )}
        {!product.problem && product.status === "in_stock_over_max" && product.maxPrice !== undefined && (
          <p className="row__problem">It is in stock, but above your {price(product.maxPrice)} limit.</p>
        )}
      </div>
      <div className="row__figures">
        <span className="money">{product.price !== undefined ? price(product.price) : ""}</span>
        <span className={`status status--${tone(product, false)}`}>{statusText(product)}</span>
      </div>
      <div className="row__actions">
        {product.stopped ? (
          <Button onClick={() => void checkNow()}>Try again</Button>
        ) : (
          <Button variant={live ? "primary" : "secondary"} onClick={() => void call("openExternal", product.url)}>
            Open page
          </Button>
        )}
        <IconButton label="Check now" onClick={() => void checkNow()} disabled={product.checking || paused}>
          <RefreshCw size={16} className={product.checking ? "spin" : undefined} />
        </IconButton>
        <IconButton label="Edit" onClick={onEdit}>
          <Pencil size={16} />
        </IconButton>
        <IconButton label="Stop watching" onClick={onRemove}>
          <Trash2 size={16} />
        </IconButton>
      </div>
    </li>
  );
}

function EditDialog({ product, onClose }: { product: ProductView | undefined; onClose(): void }) {
  return (
    <Dialog open={product !== undefined} title="Edit product" onClose={onClose}>
      {product && <EditForm key={product.id} product={product} onClose={onClose} />}
    </Dialog>
  );
}

function EditForm({ product, onClose }: { product: ProductView; onClose(): void }) {
  const [name, setName] = useState(product.name);
  const [limit, setLimit] = useState(product.maxPrice !== undefined ? product.maxPrice.toFixed(2) : "");
  const [error, setError] = useState<string>();

  async function save(event: FormEvent) {
    event.preventDefault();
    const max = parseLimit(limit);
    if (max === "invalid") {
      setError("Type the price limit as a number, like 49.99.");
      return;
    }
    try {
      await call("updateProduct", product.id, { name, maxPrice: max });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <Field label="Name">
        {(id) => (
          <input id={id} type="text" autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <Field
        label="Only alert me at or below this price (optional)"
        hint="Leave it empty to be alerted at any price."
        error={error}
      >
        {(id) => (
          <div className="money-input">
            <span aria-hidden="true">$</span>
            <input id={id} type="text" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>
        )}
      </Field>
      <div className="actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

export function Watchlist({
  state,
  onAdd,
  onToast,
}: {
  state: AppState;
  onAdd(): void;
  onToast(text: string): void;
}) {
  const [editing, setEditing] = useState<string>();
  const [removing, setRemoving] = useState<string>();

  const products = useMemo(
    () =>
      state.products
        .map((p, i) => ({ p, i }))
        .sort((a, b) => (RANK[a.p.status ?? ""] ?? 2) - (RANK[b.p.status ?? ""] ?? 2) || a.i - b.i)
        .map(({ p }) => p),
    [state.products],
  );
  const toRemove = state.products.find((p) => p.id === removing);

  return (
    <>
      <header className="view__head">
        <div>
          <h1>Watchlist</h1>
          {products.length > 0 && (
            <p className="view__sub">
              {state.paused
                ? "Watching is paused. Nothing is being checked."
                : "Each page is checked once or twice a minute. You get an alert when one comes in stock."}
            </p>
          )}
        </div>
        {products.length > 0 && (
          <Button variant="primary" onClick={onAdd}>
            Add a product
          </Button>
        )}
      </header>

      {products.length === 0 ? (
        <Empty title="Nothing on the shelf yet">
          <p>
            Paste the link to a product you want, and Dropwatch will tell you the moment it is back in stock.
          </p>
          <Button variant="primary" onClick={onAdd}>
            Add a product
          </Button>
        </Empty>
      ) : (
        <ul className="rows">
          {products.map((product) => (
            <Row
              key={product.id}
              product={product}
              paused={state.paused}
              onEdit={() => setEditing(product.id)}
              onRemove={() => setRemoving(product.id)}
              onToast={onToast}
            />
          ))}
        </ul>
      )}

      <EditDialog product={state.products.find((p) => p.id === editing)} onClose={() => setEditing(undefined)} />

      <Dialog open={toRemove !== undefined} title="Stop watching this product?" onClose={() => setRemoving(undefined)}>
        {toRemove && (
          <div className="stack">
            <p>
              Dropwatch will stop checking <strong>{toRemove.name}</strong> and take it off your watchlist.
            </p>
            <div className="actions">
              <Button variant="quiet" onClick={() => setRemoving(undefined)}>
                Keep watching
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void call("removeProduct", toRemove.id);
                  setRemoving(undefined);
                }}
              >
                Stop watching
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
