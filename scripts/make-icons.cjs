// Renders build/*.svg to the PNGs the app and installer use.
// Run with: pnpm icons
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const build = join(__dirname, "..", "build");
const DRAW = 512;
const jobs = [
  ["icon.svg", "icon.png", 512],
  ["tray.svg", "tray.png", 32],
];

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: DRAW,
      height: DRAW,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true },
    });
    await win.loadURL("data:text/html,<body style='margin:0;background:transparent;overflow:hidden'></body>");
    for (const [svgFile, pngFile, size] of jobs) {
      const svg = readFileSync(join(build, svgFile), "utf8").replace(
        "<svg ",
        `<svg width="${DRAW}" height="${DRAW}" style="display:block" `,
      );
      await win.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(svg)}; 0`);
      await new Promise((done) => setTimeout(done, 300));
      const image = await win.webContents.capturePage();
      writeFileSync(join(build, pngFile), image.resize({ width: size, height: size, quality: "best" }).toPNG());
      console.log(`wrote build/${pngFile}`);
    }
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
