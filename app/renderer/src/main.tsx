import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/instrument-sans";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { playAlarm } from "./sound.js";
import { Boundary } from "./ui.js";

// Outside the screens, so the alarm still sounds if one of them fails to draw.
window.dropwatch.onSound(playAlarm);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary whole>
      <App />
    </Boundary>
  </StrictMode>,
);
