// One-off script: rasterizes build/icon.svg to a 1024x1024 build/icon.png
// using Electron's own Chromium (already a devDependency — no new tool
// needed). Run via `node build/generate-icon.js` with ELECTRON_RUN_AS_NODE
// unset so `app`/BrowserWindow are actually available. Not part of the
// build pipeline — run once whenever icon.svg changes, then commit the
// regenerated PNG.
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const SIZE = 1024;

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "icon.svg"), "utf8");
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
    svg{width:${SIZE}px;height:${SIZE}px;display:block;}
  </style></head><body>${svg}</body></html>`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    frame: false, // a titled frame added extra height, producing a non-square capture
    show: false,
    transparent: true,
    webPreferences: { offscreen: false },
  });

  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 200)); // let the SVG paint
  let image = await win.webContents.capturePage();
  // capturePage returns device pixels, which can be larger than SIZE under
  // OS display scaling (e.g. 125%) — crop to a square using the smaller
  // dimension so the result is always square regardless of scaling.
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  image = image.crop({ x: 0, y: 0, width: side, height: side });
  fs.writeFileSync(path.join(__dirname, "icon.png"), image.toPNG());
  console.log("Wrote build/icon.png at", image.getSize());
  app.quit();
});
