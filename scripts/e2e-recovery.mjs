// Drives the real app through the three things that can go wrong around the
// window: a screen that fails to draw, a window page that crashes, and
// Windows signing out while the app is running.
// Usage: pnpm app:build && pnpm e2e:recovery
// Set DROPWATCH_EXE to test a packaged build instead of the dev build.
// The alarm and the system beep are replaced with counters, so the run is silent.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { _electron as electron } from "playwright-core";

const dataDir = mkdtempSync(join(tmpdir(), "dropwatch-recovery-"));
const PRODUCT = "Prismatic Evolutions Elite Trainer Box";

// ---- The pretend store ----
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  if (req.url === "/robots.txt") {
    res.end("User-agent: *\nDisallow: /cart\n");
  } else if (req.url === "/products/elite-trainer-box.js") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        title: PRODUCT,
        available: false,
        price: 5499,
        variants: [{ id: 1, title: "Default", available: false, price: 5499 }],
      }),
    );
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const store = `http://127.0.0.1:${server.address().port}`;

// ---- Helpers ----
const results = [];
async function step(name, run) {
  try {
    await run();
    results.push(["PASS", name]);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(["FAIL", name]);
    console.log(`FAIL  ${name}\n      ${String(err.message ?? err).split("\n")[0]}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, timeout, message) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(message);
    await sleep(100);
  }
}

const env = {
  ...process.env,
  DROPWATCH_DATA_DIR: dataDir,
  // The pretend shop above lives on this computer, which the app otherwise refuses to contact.
  DROPWATCH_ALLOW_LOOPBACK: "1",
  DROPWATCH_WINDOW_POS: process.env.DROPWATCH_WINDOW_POS ?? "4040,100",
};
delete env.ELECTRON_RUN_AS_NODE;
const exe = process.env.DROPWATCH_EXE;

let app;
let page;
async function launch(...extra) {
  app = await electron.launch(
    exe ? { executablePath: resolve(exe), args: extra, env } : { args: [".", ...extra], env },
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
}

// These go through the background process, so they keep working after the
// window's page has crashed and been loaded again.
const inWindow = (source) =>
  app.evaluate(
    ({ BrowserWindow }, js) =>
      Promise.race([
        BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js, true),
        new Promise((_, fail) => setTimeout(() => fail(new Error("the window did not answer")), 2000)),
      ]),
    source,
  );
const windowText = () => inWindow("document.body.innerText").catch(() => "");
const waitForText = (text, timeout = 8000) =>
  until(async () => (await windowText()).includes(text), timeout, `the window never showed "${text}"`);
const click = (label) =>
  inWindow(
    `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`,
  );
const callApp = (method, ...args) =>
  inWindow(`window.dropwatch.call(${JSON.stringify(method)}, ...${JSON.stringify(args)})`);
// Windows can take from a moment to a few seconds to end the page's process,
// so a crash only counts once the app has been told the page is gone.
const countCrashes = () =>
  app.evaluate(({ BrowserWindow }) => {
    globalThis.__gone = 0;
    BrowserWindow.getAllWindows()[0].webContents.on("render-process-gone", () => {
      globalThis.__gone++;
    });
  });
const crashes = () => app.evaluate(() => globalThis.__gone);
async function crashPage() {
  const before = await crashes();
  const started = Date.now();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await until(async () => (await crashes()) > before, 20000, "the page was told to crash and did not");
  console.log(`      the page was gone ${Date.now() - started} ms after it was told to crash`);
}
const pageIsDead = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed());

// The alarm is made with the browser's audio engine. This stands in for it and counts.
const silenceAlarm = () =>
  inWindow(`(() => {
    window.__alarms = 0;
    const node = () => ({
      frequency: {},
      gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (next) => next,
      start() {},
      stop() {},
    });
    window.AudioContext = class {
      currentTime = 0;
      destination = node();
      resume() { window.__alarms++; return Promise.resolve(); }
      createOscillator() { return node(); }
      createGain() { return node(); }
    };
  })()`);
const alarms = () => inWindow("window.__alarms");
const silenceBeep = () =>
  app.evaluate(({ shell }) => {
    globalThis.__beeps = 0;
    shell.beep = () => {
      globalThis.__beeps++;
    };
  });
const beeps = () => app.evaluate(() => globalThis.__beeps);

// ---- Signing out of Windows ----
// A helper process delivers the two messages Windows sends every window at
// sign-out: "may the session end?" and "the session is ending".
const SENDER = `
Add-Type -Namespace Win -Name Msg -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);'
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $hwnd = [IntPtr][long]$line
  $result = [IntPtr]::Zero
  [void][Win.Msg]::SendMessageTimeout($hwnd, 0x11, [IntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$result)
  [void][Win.Msg]::SendMessageTimeout($hwnd, 0x16, [IntPtr]1, [IntPtr]::Zero, 2, 5000, [ref]$result)
  [Console]::Out.WriteLine('sent')
}
`;
const sender = spawn(
  "pwsh",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SENDER, "utf16le").toString("base64")],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const senderLines = createInterface({ input: sender.stdout });
const senderSays = (word) =>
  new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the sign-out helper never said "${word}"`)), 30000);
    const onLine = (line) => {
      if (line.trim() !== word) return;
      clearTimeout(timer);
      senderLines.off("line", onLine);
      done();
    };
    senderLines.on("line", onLine);
  });
const senderReady = senderSays("ready");

const activityFile = join(dataDir, "activity.json");
const newestSaved = () => {
  try {
    return JSON.parse(readFileSync(activityFile, "utf8"))[0];
  } catch {
    return undefined;
  }
};

/**
 * Makes a change the app has not written to disk yet, signs out, and expects
 * the change on disk at once. The app writes its activity log every five
 * seconds, so the change is made just after one of those writes.
 */
async function signOutSaves() {
  await senderReady;
  const paused = (await callApp("getState")).value.paused;
  await callApp("setPaused", !paused);
  const first = !paused ? "Paused watching." : "Resumed watching.";
  await until(() => newestSaved()?.text === first, 8000, "the five-second save never happened");

  await callApp("setPaused", paused);
  const second = paused ? "Paused watching." : "Resumed watching.";
  expect(newestSaved()?.text === first, "the change was on disk before signing out, so this proves nothing");

  const hwnd = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE(0).toString(),
  );
  const sent = senderSays("sent");
  sender.stdin.write(`${hwnd}\n`);
  await sent;
  await until(() => newestSaved()?.text === second, 1500, "signing out did not save the latest activity");
}

/** The app's helper processes let go of the folder a moment after it ends, and rmSync does not wait for them. */
async function removeFolder(dir) {
  for (let attempt = 1; ; attempt++) {
    try {
      return rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if (attempt === 120) throw err;
      await new Promise((done) => setTimeout(done, 250));
    }
  }
}

/** Windows ends the app right after the sign-out messages. */
async function endApp() {
  const proc = app.process();
  if (proc.exitCode === null && proc.signalCode === null) {
    const gone = new Promise((done) => proc.once("exit", done));
    proc.kill();
    await gone;
  }
  await app.close().catch(() => {});
}

try {
  await launch();

  await step("set up with one product", async () => {
    await page.getByRole("heading", { name: "Know the minute it's back in stock" }).waitFor();
    await page.getByRole("button", { name: "Set it up", exact: true }).click();
    await page.getByRole("switch", { name: "Open the product page in my browser" }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Product link").fill(`${store}/products/elite-trainer-box`);
    await page.getByRole("button", { name: "Check link", exact: true }).click();
    await page.getByText("Sold out right now").waitFor();
    await page.getByRole("button", { name: "Watch this product", exact: true }).click();
    await page.locator(".row__name", { hasText: PRODUCT }).waitFor();
    await silenceAlarm();
    await silenceBeep();
    await countCrashes();
  });

  // ---- 1. A screen that fails to draw ----
  await step("a screen that fails to draw shows the problem screen", async () => {
    // A state the screens cannot draw stands in for any bug in them.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("dropwatch:state", { products: null }),
    );
    await waitForText("This window ran into a problem");
    await waitForText("Dropwatch is still watching in the background, and your alerts still go out.");
  });

  await step("the alarm still sounds on the problem screen", async () => {
    const result = await callApp("testAlert");
    expect(result.ok && result.value.sent.includes("alarm sound"), `test alert: ${JSON.stringify(result)}`);
    await until(async () => (await alarms()) === 1, 3000, `the alarm played ${await alarms()} times`);
  });

  await step("the store is still checked behind the problem screen", async () => {
    const before = hits.length;
    await until(() => hits.length > before, 45000, "no checks were made");
  });

  await step("\"Show the window again\" brings the screens back, and they work", async () => {
    await click("Show the window again");
    await waitForText(PRODUCT);
    await click("Pause watching");
    await waitForText("Watching is paused. Nothing is being checked.");
    await click("Resume watching");
    await waitForText("Watching 1 product");
  });

  await step("one screen failing to draw leaves the other screens in use", async () => {
    const good = (await callApp("getState")).value;
    // Only the Activity screen reads the activity list.
    await app.evaluate(
      ({ BrowserWindow }, bad) => BrowserWindow.getAllWindows()[0].webContents.send("dropwatch:state", bad),
      { ...good, activity: null },
    );
    await waitForText(PRODUCT);
    await click("Activity");
    await waitForText("This screen ran into a problem");
    await waitForText("What went wrong:");
    await click("Watchlist");
    await waitForText(PRODUCT);
    expect(!(await windowText()).includes("ran into a problem"), "the problem screen followed to the watchlist");
    // The next real state from the app mends the broken screen.
    await click("Pause watching");
    await waitForText("Watching is paused. Nothing is being checked.");
    await click("Resume watching");
    await click("Activity");
    await waitForText("Resumed watching.");
    await click("Watchlist");
    await waitForText(PRODUCT);
  });

  // ---- 2. The window's page crashes ----
  await step("after a crash the window comes back by itself, and works", async () => {
    await crashPage();
    await waitForText(PRODUCT, 15000);
    expect((await pageIsDead()) === false, "the page still counts as crashed");
    await click("Pause watching");
    await waitForText("Watching is paused. Nothing is being checked.");
    await click("Resume watching");
    await waitForText("Watching 1 product");
    await silenceAlarm();
    await callApp("testAlert");
    await until(async () => (await alarms()) === 1, 3000, "the alarm did not play after the reload");
  });

  await step("an alert while the page is down falls back to the system beep", async () => {
    // A reminder is the one alert whose moment the test can choose. It has to
    // come due after the page is gone, so a slow crash means another go.
    for (let attempt = 1; ; attempt++) {
      const due = Date.now() + 3000;
      const result = await callApp("addReminder", {
        name: "Recovery check",
        url: "https://example.com/",
        at: new Date(due).toISOString(),
      });
      expect(result.ok, `reminder: ${JSON.stringify(result)}`);
      await crashPage();
      if (Date.now() < due) break;
      expect(attempt < 3, "three times over, the page took longer to crash than the reminder took to come due");
      await waitForText(PRODUCT, 45000);
    }
    await until(async () => (await beeps()) === 1, 6000, "no system beep while the page was down");
  });

  await step("a second crash within a minute is also recovered from", async () => {
    await waitForText(PRODUCT, 45000);
    await silenceAlarm();
    await callApp("testAlert");
    await until(async () => (await alarms()) === 1, 3000, "the alarm did not play after the second reload");
    expect((await beeps()) === 1, `the beep was used while the page was up: ${await beeps()}`);
  });

  await step("opening the window from the tray revives a dead page at once", async () => {
    await crashPage();
    expect((await pageIsDead()) === true, "the page was reloaded before the test could look");
    // The same call the tray icon makes.
    await app.evaluate(({ app: electronApp }) => electronApp.emit("second-instance"));
    await waitForText(PRODUCT, 4000);
  });

  // ---- The window's page hangs ----
  await step("an alert on a hung page falls back to the system beep, and the page is replaced", async () => {
    const [beepsBefore, crashesBefore] = [await beeps(), await crashes()];
    const result = await callApp("addReminder", {
      name: "Hang check",
      url: "https://example.com/",
      at: new Date(Date.now() + 2000).toISOString(),
    });
    expect(result.ok, `reminder: ${JSON.stringify(result)}`);
    // An endless loop stands in for any way the page might hang.
    await app.evaluate(({ BrowserWindow }) => {
      void BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("setTimeout(() => { for (;;) {} }, 0)");
    });
    await until(async () => (await beeps()) === beepsBefore + 1, 10000, "no system beep while the page was hung");
    await until(async () => (await crashes()) === crashesBefore + 1, 10000, "the hung page was not ended");
    // The tray icon's call again, to skip the wait before the reload.
    await app.evaluate(({ app: electronApp }) => electronApp.emit("second-instance"));
    await waitForText(PRODUCT, 8000);
    await silenceAlarm();
    await callApp("testAlert");
    await until(async () => (await alarms()) === 1, 3000, "the alarm did not play on the fresh page");
    await sleep(3500);
    expect((await beeps()) === beepsBefore + 1, "the beep was used though the page played the alarm");
    expect((await crashes()) === crashesBefore + 1, "a page that played the alarm was ended");
  });

  await step("the store was checked all the way through", async () => {
    const before = hits.length;
    await until(() => hits.length > before, 45000, "no checks were made after the crashes");
  });

  // ---- 3. Signing out of Windows ----
  await step("signing out saves at once (window open)", async () => {
    await signOutSaves();
  });
  await endApp();

  await step("after signing back in, everything is where it was", async () => {
    await launch();
    await waitForText(PRODUCT, 15000);
    await click("Activity");
    await waitForText("Recovery check");
    const text = await windowText();
    expect(/Paused watching\.|Resumed watching\./.test(text), "the activity from before signing out is gone");
  });

  await step("signing out saves at once (window closed to the tray)", async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(500);
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
    expect(visible === false, `window visible: ${visible}`);
    await signOutSaves();
  });
  await endApp();

  await step("signing out saves at once (started hidden at sign-in)", async () => {
    await launch("--hidden");
    await waitForText(PRODUCT, 15000);
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
    expect(visible === false, `window visible: ${visible}`);
    await signOutSaves();
  });
  await endApp();

  await step("the saved files are whole", async () => {
    // The watch-state file only exists once a product has had trouble.
    for (const name of ["dropwatch.json", "activity.json", "watch-state.json"]) {
      const file = join(dataDir, name);
      expect(name === "watch-state.json" || existsSync(file), `${name} is missing`);
      if (existsSync(file)) JSON.parse(readFileSync(file, "utf8"));
      expect(!existsSync(`${file}.tmp`), `${name}.tmp was left behind`);
    }
  });
} finally {
  await endApp().catch(() => {});
  sender.stdin.end();
  server.close();
  await removeFolder(dataDir);
}

const failed = results.filter(([status]) => status === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
