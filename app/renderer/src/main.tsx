import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/instrument-sans";
import "./styles.css";

import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { playAlarm } from "./sound.js";
import { Button, Empty } from "./ui.js";

// Outside the screens, so the alarm still sounds if one of them fails to draw.
window.dropwatch.onSound(playAlarm);

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="shell shell--failed">
        <div className="titlebar" />
        <Empty title="This window ran into a problem">
          <p>Dropwatch is still watching in the background, and your alerts still go out.</p>
          <Button variant="primary" onClick={() => this.setState({ failed: false })}>
            Show the window again
          </Button>
        </Empty>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
