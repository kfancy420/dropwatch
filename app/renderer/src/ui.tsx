// Small building blocks every screen uses.

import { Component, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  busy?: boolean;
};

export function Button({ variant = "secondary", busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--${variant}${className ? ` ${className}` : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className="iconbtn" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 512 512" aria-hidden="true">
      <rect x="16" y="16" width="480" height="480" rx="120" fill="var(--action)" />
      <rect x="132" y="108" width="216" height="304" rx="34" fill="#fff" transform="rotate(-9 240 260)" />
      <circle cx="372" cy="146" r="92" fill="var(--action)" />
      <circle cx="372" cy="146" r="66" fill="#1FD08A" />
    </svg>
  );
}

export type LampTone = "live" | "warn" | "off" | "stop" | "busy" | "idle";

export function Lamp({ tone }: { tone: LampTone }) {
  return <span className={`lamp lamp--${tone}`} aria-hidden="true" />;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="toggle">
      <div>
        <label htmlFor={id} className="toggle__label">
          {label}
        </label>
        {hint && <p className="hint">{hint}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children(id: string): ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="hint">{hint}</p>
      )}
    </div>
  );
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog--wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog__body">
          <header className="dialog__head">
            <h2 id={titleId}>{title}</h2>
            <IconButton label="Close" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/**
 * Catches a screen that fails to draw. Around one screen it leaves the rest of
 * the window working; with `whole` it stands in for the window itself.
 */
export class Boundary extends Component<{ whole?: boolean; children: ReactNode }, { problem?: string }> {
  override state: { problem?: string } = {};

  static getDerivedStateFromError(error: unknown): { problem: string } {
    return { problem: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactNode {
    const { problem } = this.state;
    if (problem === undefined) return this.props.children;
    const { whole } = this.props;
    const notice = (
      <Empty title={whole ? "This window ran into a problem" : "This screen ran into a problem"}>
        <p>Dropwatch is still watching in the background, and your alerts still go out.</p>
        <Button variant="primary" onClick={() => this.setState({ problem: undefined })}>
          {whole ? "Show the window again" : "Show this screen again"}
        </Button>
        <p className="hint">What went wrong: {problem || "unknown"}</p>
      </Empty>
    );
    if (!whole) return notice;
    return (
      <div className="shell shell--failed">
        <div className="titlebar" />
        {notice}
      </div>
    );
  }
}
