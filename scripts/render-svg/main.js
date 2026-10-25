// Rasterise SVG/HTML snippets to PNG with Electron (used to build the app icon and artwork).
// Usage: JOBS='[["in.svg","out.png",1024,1024]]' npx electron scripts/render-svg
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const [src, out, w, h] of JSON.parse(process.env.JOBS)) {
    const win = new BrowserWindow({
      width: w, height: h, show: false, transparent: true, frame: false, useContentSize: true,
      webPreferences: { offscreen: true },
    });
    const html = `${src}.html`;
    fs.writeFileSync(html, `<html><body style="margin:0;background:transparent">${fs.readFileSync(src, 'utf8')}</body></html>`);
    await win.loadFile(html);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    fs.writeFileSync(out, img.resize({ width: w, height: h }).toPNG());
    fs.rmSync(html);
    win.destroy();
  }
  app.quit();
});
