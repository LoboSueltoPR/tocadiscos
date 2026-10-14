const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen, session, desktopCapturer, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = { hotkey: 'Control+Alt+Space', alwaysOnTop: true, x: null, y: null };

const W = 828, H = 264; // equipo de 780×212 más el margen transparente para la sombra

let win, tray, config;

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
  catch {}
}

// Lo que suena sale de los controles multimedia de Windows (los del panel de volumen), que Spotify
// alimenta. Un ayudante de PowerShell queda abierto y responde las consultas sin lanzar programas.
let media = null, mediaSeq = 0;
const pending = new Map();

function startMedia() {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'runner', 'media.ps1')], { windowsHide: true });
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line === 'ready') { media = p; for (const fn of waiting.splice(0)) fn(); continue; }
      const [id, b64] = line.split('\t');
      const cb = pending.get(id);
      if (!cb) continue;
      pending.delete(id);
      try { cb(JSON.parse(Buffer.from(b64 || '', 'base64').toString('utf8') || 'null')); } catch { cb(null); }
    }
  });
  p.on('exit', () => {
    if (media === p) media = null;
    for (const cb of pending.values()) cb(null);
    pending.clear();
    if (!quitting) setTimeout(startMedia, 2000); // si se cae, vuelve a arrancar
  });
  p.on('error', () => {});
}

const waiting = [];
let quitting = false;
async function ask(command, arg = '') {
  if (!media) await new Promise((r) => { waiting.push(r); setTimeout(r, 8000); });
  if (!media) return null;
  return new Promise((resolve) => {
    const id = String(++mediaSeq);
    pending.set(id, resolve);
    media.stdin.write(`${id}\t${command}\t${String(arg).replace(/[\t\n]/g, ' ')}\n`);
  });
}

const openSpotify = () => shell.openExternal('spotify:');

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - W - 8, y: workArea.y + workArea.height - H - 8 };
}

function onScreen(x, y) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    x >= a.x - 20 && y >= a.y - 20 && x + W <= a.x + a.width + 20 && y + H <= a.y + a.height + 20);
}

function createWindow() {
  const pos = config.x != null && onScreen(config.x, config.y) ? { x: config.x, y: config.y } : defaultPosition();
  win = new BrowserWindow({
    width: W, height: H, ...pos,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: config.alwaysOnTop, show: false, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // El margen transparente deja pasar los clics; la página avisa cuando el mouse está sobre el equipo.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => showWindow());
  // El audio del sistema (loopback) alimenta el espectro y los VU. Se pide con "gesto de usuario" simulado.
  win.webContents.on('did-finish-load', () => win.webContents.executeJavaScript('window.startAudio && startAudio()', true));
  win.on('moved', savePosition);
}

function setupLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const [source] = await desktopCapturer.getSources({ types: ['screen'] });
    cb({ video: source, audio: 'loopback' });
  });
}

let saveTimer;
function savePosition() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { const [x, y] = win.getPosition(); config.x = x; config.y = y; saveConfig(); }, 300);
}

function showWindow() {
  win.showInactive(); // sin robar el foco a lo que estés usando
  win.webContents.send('visibility', true);
}
function hideWindow() {
  win.webContents.send('visibility', false);
  setTimeout(() => win.hide(), 160); // deja terminar la animación de salida
}
function toggleWindow() {
  if (win.isVisible()) hideWindow();
  else showWindow();
}

function setAlwaysOnTop(v) {
  config.alwaysOnTop = v; saveConfig();
  win.setAlwaysOnTop(v);
  win.webContents.send('pinned', v);
  buildTrayMenu();
}

// Ícono de bandeja: un disco dibujado a mano (BGRA), sin archivos externos.
function trayIcon() {
  const s = 32, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), i = (y * s + x) * 4;
    let a = 0, c = [0, 0, 0];
    if (d < 15) { a = 255; c = [30, 30, 30]; }
    if (d < 15 && d > 12.6) c = [235, 235, 235];
    if (d < 6.2) c = [96, 215, 30];
    if (d < 2) c = [30, 30, 30];
    if (d >= 14.2 && d < 15) a = Math.round(255 * (15 - d) / 0.8);
    buf[i] = c[2]; buf[i + 1] = c[1]; buf[i + 2] = c[0]; buf[i + 3] = a;
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function buildTrayMenu() {
  const login = app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath()] }).openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Mostrar / ocultar   (${config.hotkey.replace('Control', 'Ctrl')})`, click: toggleWindow },
    { type: 'separator' },
    { label: 'Siempre encima', type: 'checkbox', checked: config.alwaysOnTop, click: (m) => setAlwaysOnTop(m.checked) },
    { label: 'Iniciar con Windows', type: 'checkbox', checked: login,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, path: process.execPath, args: [app.getAppPath()] }) },
    { label: 'Volver a la esquina', click: () => { const p = defaultPosition(); win.setPosition(p.x, p.y); showWindow(); } },
    { label: 'Editar atajo…', click: () => { saveConfig(); require('electron').shell.openPath(CONFIG_PATH); } },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() },
  ]));
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!globalShortcut.register(config.hotkey, toggleWindow)) {
    console.error(`No se pudo registrar el atajo ${config.hotkey}`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && toggleWindow());

  app.whenReady().then(() => {
    config = loadConfig();
    saveConfig();
    startMedia();
    setupLoopback();
    createWindow();
    tray = new Tray(trayIcon());
    tray.setToolTip('Tocadiscos');
    tray.on('click', toggleWindow);
    buildTrayMenu();
    registerHotkey();
    fs.watchFile(CONFIG_PATH, { interval: 1500 }, () => {
      const prev = config.hotkey; config = loadConfig();
      if (config.hotkey !== prev) { registerHotkey(); buildTrayMenu(); }
    });
  });

  app.on('will-quit', () => { quitting = true; globalShortcut.unregisterAll(); media && media.kill(); });
  app.on('window-all-closed', (e) => e.preventDefault());
}

ipcMain.handle('now-playing', async () => (await ask('now')) || { error: 'failed' });
ipcMain.handle('cmd', (_e, [command, arg]) => ask(command, arg));

const artCache = new Map();
ipcMain.handle('art', async (_e, key) => {
  if (!key) return null;
  if (artCache.has(key)) return artCache.get(key);
  const r = await ask('art');
  if (!r || !r.data) return null;
  if (artCache.size > 30) artCache.delete(artCache.keys().next().value);
  artCache.set(r.key, r.data);
  return r.key === key ? r.data : null;
});

ipcMain.on('hide', hideWindow);
ipcMain.on('interactive', (_e, v) => win.setIgnoreMouseEvents(!v, { forward: true }));
// Arrastre manual: las regiones -webkit-app-region en Windows se tragan el hover y la rueda.
ipcMain.on('move', (_e, x, y) => { win.setPosition(Math.round(x), Math.round(y)); savePosition(); });
ipcMain.on('toggle-pin', () => setAlwaysOnTop(!config.alwaysOnTop));
ipcMain.handle('get-pinned', () => config.alwaysOnTop);
ipcMain.on('open-spotify', openSpotify);
