// The only doorway between the window and the rest of the app.

import { contextBridge, ipcRenderer } from "electron";

import type { AppState, Bridge } from "../shared/types.js";

const bridge: Bridge = {
  call: (method, ...args) => ipcRenderer.invoke("dropwatch:call", method, args),
  onState: (listener) => {
    const handler = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on("dropwatch:state", handler);
    return () => ipcRenderer.removeListener("dropwatch:state", handler);
  },
  onSound: (listener) => {
    const handler = () => {
      // The app waits for this answer, and makes a sound itself if none comes.
      let played = true;
      try {
        listener();
      } catch {
        played = false;
      }
      ipcRenderer.send("dropwatch:sound-played", played);
    };
    ipcRenderer.on("dropwatch:sound", handler);
    return () => ipcRenderer.removeListener("dropwatch:sound", handler);
  },
};

contextBridge.exposeInMainWorld("dropwatch", bridge);
