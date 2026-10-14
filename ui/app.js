const $ = (id) => document.getElementById(id);
const card = $('card');

let s = null;                 // último estado conocido
let base = { pos: 0, at: 0 }; // para interpolar el progreso entre consultas
let visible = false;
let pollTimer = null, polling = false;
let offKind = null;
const overrides = {};         // cambios optimistas que esperan confirmación de Spotify

// ── Consultas a Spotify ────────────────────────────────
function override(field, value, ms = 1800) { overrides[field] = { value, until: Date.now() + ms }; }

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const next = await sf.nowPlaying();
    for (const [k, o] of Object.entries(overrides)) {
      if (Date.now() > o.until || next[k] === o.value) delete overrides[k];
      else next[k] = o.value;
    }
    render(next);
  } finally { polling = false; }
}
function schedule(delay = 1000) {
  clearTimeout(pollTimer);
  if (!visible) return;
  pollTimer = setTimeout(async () => { await poll(); schedule(); }, delay);
}
async function cmd(...args) { await sf.cmd(...args); schedule(250); }

// ── Render ───────────────────────────────────────────────
const fmt = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const isPlaying = () => s && s.state === 'playing';
const currentPos = () => !s ? 0 : Math.min(s.duration, base.pos + (isPlaying() ? performance.now() - base.at : 0));

function render(n) {
  if (n.error) return renderOff(n.error);
  offKind = null;
  const trackChanged = !s || s.title !== n.title || s.art !== n.art;
  if (!s || trackChanged || n.state !== s.state || Math.abs(n.position - currentPos()) > 1500) {
    base = { pos: n.position, at: performance.now() };
  }
  s = n;

  card.classList.add('has-record');
  card.classList.toggle('playing', isPlaying());
  $('playIcon').setAttribute('href', isPlaying() ? '#i-pause' : '#i-play');
  $('shuffleBtn').classList.toggle('on', n.shuffle);
  $('repeatBtn').classList.toggle('on', n.repeat !== 'off');
  $('repeatIcon').setAttribute('href', n.repeat === 'track' ? '#i-repeat1' : '#i-repeat');
  $('dur').textContent = fmt(n.duration);
  if (!faderDrag && !overrides.volume) setFader(n.volume);

  if (trackChanged) {
    setTitle(n.title || '—');
    $('artist').textContent = n.artists || '';
    $('album').textContent = n.album && n.album !== n.title ? n.album : '';
    loadArt(n.art);
  }
}

function renderOff(kind) {
  s = null; offKind = kind;
  card.classList.remove('playing', 'has-record');
  $('playIcon').setAttribute('href', '#i-play');
  setTitle({ 'not-running': 'Spotify está cerrado', idle: 'Nada en la bandeja' }[kind] || 'No pude leer Spotify');
  $('artist').textContent = kind === 'not-running' ? 'Tocá START para abrirlo' : 'Poné un tema en Spotify';
  $('album').textContent = '';
  $('cur').textContent = $('dur').textContent = '–:––';
  $('fill').style.width = '0';
  for (const id of ['shuffleBtn', 'repeatBtn']) $(id).classList.remove('on');
  for (const img of document.querySelectorAll('.sleeve img')) img.classList.remove('on');
  artUrl = null;
}

let rpm = 33;

// Título: arranca grande y se achica hasta entrar entero en dos líneas sin partir palabras.
function setTitle(text) {
  const el = $('title');
  el.textContent = text;
  el.style.webkitLineClamp = 'none';
  let size = 24;
  for (; size > 15; size--) {
    el.style.fontSize = size + 'px';
    if (el.scrollHeight <= Math.ceil(size * 1.18 * 2) + 2 && el.scrollWidth <= el.clientWidth) break;
  }
  el.style.webkitLineClamp = '';
  el.style.overflowWrap = size <= 15 ? 'anywhere' : '';
}

// Portada: tapa del disco, etiqueta del vinilo, luz ambiente y acento.
let artUrl = null, layer = 0;
async function loadArt(url) {
  if (url === artUrl) return;
  artUrl = url;
  const data = url ? await sf.art(url) : null;
  if (url !== artUrl || !data) return;
  const img = new Image();
  img.src = data;
  await img.decode().catch(() => {});
  layer ^= 1;
  const [inS, outS] = layer ? [$('sleeveB'), $('sleeveA')] : [$('sleeveA'), $('sleeveB')];
  // la tapa nueva cae desde arriba y la vieja se va hacia abajo, como pasando discos en una batea
  inS.classList.remove('out', 'on'); inS.src = data; void inS.offsetWidth; inS.classList.add('on');
  if (outS.classList.contains('on')) { outS.classList.replace('on', 'out'); setTimeout(() => outS.classList.remove('out'), 700); }
  $('label').src = data;
  setAccent(img);
}
function setAccent(img) {
  const c = document.createElement('canvas'); c.width = c.height = 24;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 24, 24);
  const px = g.getImageData(0, 0, 24, 24).data;
  const buckets = Array.from({ length: 18 }, () => ({ w: 0, h: 0, s: 0 }));
  for (let i = 0; i < px.length; i += 4) {
    const [h, sat, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    const w = sat * (1 - Math.abs(l - .5) * 1.6);
    if (w <= .05) continue;
    const b = buckets[Math.floor(h / 20) % 18];
    b.w += w; b.h += h * w; b.s += sat * w;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  const [h, sat] = best.w > 1 ? [best.h / best.w, Math.min(85, Math.max(45, (best.s / best.w) * 100))] : [30, 10];
  document.documentElement.style.setProperty('--accent', `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% 68%)`);
  document.documentElement.style.setProperty('--accent-soft', `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% 60% / .28)`);
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, sat = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}

// ── Brazo ────────────────────────────────────────────────
// Geometría en coordenadas del SVG de la bandeja (300×192).
const PIVOT = [262, 34], CENTER = [100, 96], ARM = 150;
const R_OUT = 81, R_IN = 38, REST = 98;
const D = Math.hypot(CENTER[0] - PIVOT[0], CENTER[1] - PIVOT[1]);
const TOWARD = Math.atan2(CENTER[1] - PIVOT[1], CENTER[0] - PIVOT[0]) * 180 / Math.PI;
const grooveAngle = (p) => {
  const r = R_OUT - p * (R_OUT - R_IN);
  return TOWARD - Math.acos((ARM ** 2 + D ** 2 - r ** 2) / (2 * ARM * D)) * 180 / Math.PI;
};
const radiusAt = (deg) => {
  const a = deg * Math.PI / 180;
  return Math.hypot(PIVOT[0] + ARM * Math.cos(a) - CENTER[0], PIVOT[1] + ARM * Math.sin(a) - CENTER[1]);
};
const A_OUT = grooveAngle(0), A_IN = grooveAngle(1);
let armA = REST, lift = 1, armDrag = null;

function drawArm() {
  const dx = 2 + lift * 6, dy = 3 + lift * 7;
  $('arm').setAttribute('transform', `rotate(${armA} ${PIVOT[0]} ${PIVOT[1]})`);
  $('armShadow').setAttribute('transform', `translate(${dx} ${dy}) rotate(${armA} ${PIVOT[0]} ${PIVOT[1]})`);
  $('armShadow').setAttribute('opacity', (.55 - lift * .2).toFixed(2));
}

const svgPoint = (e) => {
  const svg = $('armSvg'), pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
};
$('arm').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  $('arm').setPointerCapture(e.pointerId);
  armDrag = true;
});
$('arm').addEventListener('pointermove', (e) => {
  if (!armDrag) return;
  const p = svgPoint(e);
  armA = Math.max(REST, Math.min(A_IN + 1, Math.atan2(p.y - PIVOT[1], p.x - PIVOT[0]) * 180 / Math.PI));
});
$('arm').addEventListener('pointerup', () => {
  if (!armDrag) return;
  armDrag = null;
  if (!s) return;
  if (armA < A_OUT - 6) { if (isPlaying()) togglePlay(); return; } // brazo al apoyabrazos: stop
  const p = Math.max(0, Math.min(1, (R_OUT - radiusAt(armA)) / (R_OUT - R_IN)));
  const ms = p * s.duration;
  base = { pos: ms, at: performance.now() };
  sf.cmd('seek-to', Math.round(ms / 1000)).then(() => { if (!isPlaying()) togglePlay(); else schedule(250); });
});

// ── Fader de volumen ─────────────────────────────────────
const setFader = (v) => { $('faderCap').style.top = `calc(${(100 - (v < 0 ? 100 : v)) / 100} * (100% - 10px) + 5px)`; }; // -1: Spotify todavía sin audio
let volTimer, faderDrag = false;
const vol = () => (s && s.volume >= 0 ? s.volume : 100);
function changeVolume(v) {
  if (!s) return;
  v = Math.round(Math.max(0, Math.min(100, v)));
  s.volume = v; override('volume', v, 2500);
  setFader(v);
  clearTimeout(volTimer); volTimer = setTimeout(() => cmd('volume', v), 120);
}
const faderFromEvent = (e) => { const r = $('faderSlot').getBoundingClientRect(); return (1 - (e.clientY - r.top) / r.height) * 100; };
$('faderSlot').addEventListener('pointerdown', (e) => { if (!s) return; e.stopPropagation(); $('faderSlot').setPointerCapture(e.pointerId); faderDrag = true; changeVolume(faderFromEvent(e)); });
$('faderSlot').addEventListener('pointermove', (e) => { if (faderDrag) changeVolume(faderFromEvent(e)); });
$('faderSlot').addEventListener('pointerup', () => { faderDrag = false; });
card.addEventListener('wheel', (e) => {
  if (!s) return;
  e.preventDefault();
  changeVolume(vol() + (e.deltaY < 0 ? 4 : -4));
}, { passive: false });

// ── Audio del sistema para los LED ───────────────────────
let chans, timeData, audioOk = false, audioCtx;
window.startAudio = async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw new Error('sin pista de audio');
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const split = audioCtx.createChannelSplitter(2);
    src.connect(split);
    chans = [0, 1].map((i) => { const a = audioCtx.createAnalyser(); a.fftSize = 1024; split.connect(a, i); return a; });
    timeData = new Float32Array(1024);
    audioOk = true;
  } catch (e) { console.log('audio: modo simulado —', e.message); }
};
document.addEventListener('pointerdown', () => audioCtx && audioCtx.state === 'suspended' && audioCtx.resume());

const LEDS = 20;
const ledRows = [$('ledL'), $('ledR')].map((row) => Array.from({ length: LEDS }, (_, i) => {
  const led = document.createElement('i');
  if (i >= LEDS - 3) led.classList.add('r'); else if (i >= LEDS - 7) led.classList.add('y');
  row.append(led); return led;
}));
let ref = -30;
const meter = [0, 0], wobble = [0, 0];
function meterTargets(t) {
  if (audioOk) {
    const dbs = chans.map((a) => {
      a.getFloatTimeDomainData(timeData);
      let sum = 0; for (let i = 0; i < timeData.length; i++) sum += timeData[i] ** 2;
      return 20 * Math.log10(Math.sqrt(sum / timeData.length) || 1e-6);
    });
    const loud = Math.max(...dbs);
    if (loud < -65) return [0, 0];
    ref += (loud - ref) * (loud > ref ? .02 : .004); // se adapta al volumen
    return dbs.map((db, i) => { wobble[i] += (Math.random() - .5) * .5 - wobble[i] * .08; return Math.max(0, Math.min(1, (db - ref + 18 + wobble[i]) / 21)); });
  }
  if (!isPlaying()) return [0, 0];
  return [0, 1].map((c) => .55 + .25 * Math.sin(t / 140 + c * 2) * Math.sin(t / 377 + c));
}

// ── Bucle de animación ───────────────────────────────────
let last = 0, angle = 0, speed = 0;
function frame(t) {
  const dt = Math.min(64, t - (last || t)) / 1000; last = t;

  // plato: arranque rápido y frenado con inercia
  const target = isPlaying() ? (rpm === 33 ? 200 : 270) : 0;
  speed += (target - speed) * (1 - Math.exp(-dt / (target > speed ? .35 : .7)));
  angle = (angle + speed * dt) % 360;
  $('spin').style.transform = `rotate(${angle}deg)`;

  // brazo: sigue el avance del tema; se levanta en pausa
  if (!armDrag) {
    const p = s && s.duration ? currentPos() / s.duration : 0;
    const goal = s ? grooveAngle(p) : REST;
    armA += (goal - armA) * (1 - Math.exp(-dt / .3));
  }
  const liftGoal = armDrag || !isPlaying() ? 1 : 0;
  lift += (liftGoal - lift) * (1 - Math.exp(-dt / .18));
  drawArm();

  if (s) {
    const pos = currentPos();
    $('cur').textContent = fmt(pos);
    $('fill').style.width = `${s.duration ? (pos / s.duration) * 100 : 0}%`;
  }

  const targets = meterTargets(t);
  ledRows.forEach((row, c) => {
    meter[c] = targets[c] > meter[c] ? targets[c] : meter[c] - dt * 1.4;
    const lit = Math.round(Math.max(0, meter[c]) * LEDS);
    row.forEach((led, i) => led.classList.toggle('on', i < lit));
  });

  if (visible) requestAnimationFrame(frame);
}

// ── Barra de avance ──────────────────────────────────────
$('bar').addEventListener('click', (e) => {
  if (!s) return;
  const r = $('bar').getBoundingClientRect();
  const ms = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * s.duration;
  base = { pos: ms, at: performance.now() };
  cmd('seek-to', Math.round(ms / 1000));
});

// ── Controles ────────────────────────────────────────────
function seekBy(sec) {
  if (!s) return;
  const ms = Math.max(0, Math.min(s.duration, currentPos() + sec * 1000));
  base = { pos: ms, at: performance.now() };
  cmd('seek-to', ms / 1000);
}
function togglePlay() {
  if (!s) { sf.openSpotify(); schedule(1500); return; }
  base = { pos: currentPos(), at: performance.now() };
  const next = isPlaying() ? 'paused' : 'playing';
  override('state', next);
  render({ ...s, state: next });
  cmd('play-pause');
}
function shuffle() {
  if (!s) return;
  override('shuffle', !s.shuffle); render({ ...s, shuffle: !s.shuffle });
  cmd('shuffle', s.shuffle ? 'on' : 'off');
}
function repeat() {
  if (!s) return;
  const next = { off: 'context', context: 'track', track: 'off' }[s.repeat] || 'off';
  override('repeat', next); render({ ...s, repeat: next });
  cmd('repeat', next);
}
function setRpm(v) {
  rpm = v;
  $('rpm33').classList.toggle('on', v === 33);
  $('rpm45').classList.toggle('on', v === 45);
}

$('playBtn').onclick = togglePlay;
$('startBtn').onclick = togglePlay;
$('prevBtn').onclick = () => cmd('previous');
$('nextBtn').onclick = () => cmd('next');
$('shuffleBtn').onclick = shuffle;
$('repeatBtn').onclick = repeat;
$('hideBtn').onclick = () => sf.hide();
$('rpm33').onclick = () => setRpm(33);
$('rpm45').onclick = () => setRpm(45);
$('target').onclick = () => sf.togglePin();
$('sleeve').onclick = () => { if (!dragged) sf.openSpotify(); };
sf.getPinned().then((v) => $('target').classList.toggle('on', v));
sf.onPinned((v) => $('target').classList.toggle('on', v));

// Teclado (cuando la ventana tiene el foco)
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') sf.hide();
  else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') e.shiftKey ? seekBy(10) : cmd('next');
  else if (e.key === 'ArrowLeft') e.shiftKey ? seekBy(-10) : cmd('previous');
  else if (e.key === 'ArrowUp' && s) changeVolume(vol() + 4);
  else if (e.key === 'ArrowDown' && s) changeVolume(vol() - 4);
  else if (k === 's') shuffle();
  else if (k === 'r') repeat();
});

// Arrastrar la ventana desde cualquier zona que no sea un control.
let drag = null, dragged = false;
card.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button:not(#sleeve), .bar, .slot, #arm')) return;
  drag = { x: e.screenX, y: e.screenY, wx: window.screenX, wy: window.screenY, id: e.pointerId };
  dragged = false;
});
card.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!dragged && Math.hypot(dx, dy) < 4) return;
  if (!dragged) card.setPointerCapture(drag.id);
  dragged = true;
  sf.move(drag.wx + dx, drag.wy + dy);
});
card.addEventListener('pointerup', () => { drag = null; setTimeout(() => (dragged = false), 0); });

// Clics a través del margen transparente: solo la tarjeta recibe el mouse.
let interactive = false;
function setInteractive(v) { if (v !== interactive) { interactive = v; sf.interactive(v); } }
document.addEventListener('mousemove', (e) => setInteractive(!!drag || armDrag || faderDrag || !!e.target.closest('.card')));
document.addEventListener('mouseleave', () => { if (!drag && !armDrag && !faderDrag) setInteractive(false); });

// ── Visibilidad ──────────────────────────────────────────
sf.onVisibility((v) => {
  visible = v;
  card.classList.toggle('in', v);
  if (v) { poll(); schedule(); last = 0; requestAnimationFrame(frame); }
  else { clearTimeout(pollTimer); setInteractive(false); }
});
