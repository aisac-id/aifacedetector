import { initEngine, detect, faceThumb, getBackend } from "./engine.js";
import { FaceAnalysis, SIGNAL_META } from "./analysis.js";
import { SourceManager } from "./sources.js";
import { sfx, setSound, soundOn } from "./audio.js";

const $ = (id) => document.getElementById(id);
const view = $("view");
const hud = $("hud");
const hctx = hud.getContext("2d");

const TUNE_KEY = "aifd-tuning-v1";
const DEFAULT_TUNE = {
  sens: 1, interval: 300, minConf: 0.4, inputSize: 320,
  labels: true, dots: true, mirror: false, alerts: true, sound: true,
};
let tune = { ...DEFAULT_TUNE };

const COLORS = { REAL: "#34d399", SUSPECT: "#fbbf24", SYNTHETIC: "#ff3b5c", SCANNING: "#22d3ee" };
const VCLASS = { REAL: "v-real", SUSPECT: "v-sus", SYNTHETIC: "v-ai", SCANNING: "v-scan" };

let engineReady = false;
let paused = false;
let busy = false;
let scanTimer = null;
let tracks = new Map();
let nextId = 1;
let selectedId = null;
let logs = [];
let lastAlertAt = 0;
let lastPartRender = 0;
let lastSigRender = 0;

const src = new SourceManager(view, onSrcStatus);

// debug/inspection hook (read-only usage in tests & devtools)
let scanCount = 0;
window.__aifd = { get tracks() { return tracks; }, src, get tune() { return tune; }, get scans() { return scanCount; } };

/* ---------- persistence ---------- */
function saveTune() { try { localStorage.setItem(TUNE_KEY, JSON.stringify(tune)); } catch (e) {} }
function restoreTune() {
  try {
    const raw = localStorage.getItem(TUNE_KEY);
    if (raw) tune = { ...DEFAULT_TUNE, ...JSON.parse(raw) };
  } catch (e) {}
}

/* ---------- toasts ---------- */
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

/* ---------- sources ---------- */
function onSrcStatus(s) {
  if (s === "share-ended") {
    $("srcStatus").textContent = "share stopped";
    showGate("Screen share ended. Share again or switch back to the demo reel.");
    return;
  }
  $("srcStatus").textContent = s;
}

function showGate(msg) {
  $("gateMsg").textContent = msg;
  $("srcGate").hidden = false;
}
function hideGate() { $("srcGate").hidden = true; }

async function switchSource(mode) {
  tracks.clear();
  selectedId = null;
  hideGate();
  $("deviceWrap").hidden = mode !== "webcam";
  $("captureBtn").hidden = mode !== "screen";
  $("truthChip").hidden = mode !== "demo";
  $("srcChip").textContent = { demo: "DEMO REEL", webcam: "WEBCAM", screen: "SCREEN / TAB" }[mode];
  try {
    if (mode === "demo") {
      await src.useDemo();
    } else if (mode === "webcam") {
      await src.useWebcam($("deviceSel").value || undefined);
      await fillDevices();
    } else if (mode === "screen") {
      src.stop();
      $("srcStatus").textContent = "press “Share tab / screen…” to begin";
      showGate("Pick the meeting tab (Meet / Zoom / Teams) or any window in Chrome's picker.");
      return;
    }
    sizeStage();
  } catch (err) {
    console.warn("source error", err);
    sfx.error();
    const msg = mode === "webcam"
      ? "Camera unavailable or permission denied. Check chrome://settings/content/camera."
      : "Could not start this source. " + (err && err.message ? err.message : "");
    showGate(msg);
    $("srcStatus").textContent = "source error";
  }
}

async function startScreen() {
  hideGate();
  try {
    await src.useScreen();
    tracks.clear();
    selectedId = null;
    sizeStage();
    toast("Capturing — every face on screen gets a verdict");
    sfx.ok();
  } catch (err) {
    console.warn("display error", err);
    showGate("Share was cancelled or blocked. Press “Share tab / screen…” to try again.");
    $("srcStatus").textContent = "share cancelled";
  }
}

async function fillDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter((d) => d.kind === "videoinput");
    const sel = $("deviceSel");
    const cur = sel.value;
    sel.innerHTML = "";
    cams.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Camera ${i + 1}`;
      sel.appendChild(o);
    });
    if (cur && cams.some((d) => d.deviceId === cur)) sel.value = cur;
  } catch (e) {}
}

function sizeStage() {
  hud.width = view.width;
  hud.height = view.height;
}

/* ---------- scanning ---------- */
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanOnce, tune.interval);
}

async function scanOnce() {
  if (!engineReady || paused || busy || src.mode === "none") { scheduleScan(); return; }
  busy = true;
  try {
    // draw the latest frame here too: rAF is suspended in background tabs,
    // and scanning must keep running while the user is on the meeting tab
    src.tick(performance.now());
    scanCount++;
    const results = await detect(view, { inputSize: tune.inputSize, minConfidence: tune.minConf });
    processResults(results);
  } catch (err) {
    console.warn("scan error", err);
  }
  busy = false;
  scheduleScan();
}

function processResults(results) {
  const now = performance.now();
  const seen = new Set();
  for (const r of results) {
    const b = r.detection.box;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    let best = null, bestD = Infinity;
    for (const t of tracks.values()) {
      const d = Math.hypot(t.cx - cx, t.cy - cy);
      if (d < Math.max(b.width, t.box.width) * 0.75 && d < bestD) { best = t; bestD = d; }
    }
    let track = best;
    if (!track) {
      track = {
        id: nextId++,
        analysis: new FaceAnalysis(),
        drawBox: { x: b.x, y: b.y, w: b.width, h: b.height },
        thumb: null, thumbAt: 0,
        lastVerdict: "SCANNING",
      };
      tracks.set(track.id, track);
      if (selectedId == null) selectedId = track.id;
    }
    track.box = b;
    track.cx = cx; track.cy = cy;
    track.landmarks = r.landmarks.positions;
    track.lastSeen = now;
    track.analysis.update(view, r, now, tune.sens);
    seen.add(track.id);

    if (!track.thumb || now - track.thumbAt > 1600) {
      track.thumb = faceThumb(view, b, 72);
      track.thumbAt = now;
    }

    const v = track.analysis.verdict;
    if (v !== track.lastVerdict && v !== "SCANNING") {
      logEvent(track, v);
      if (v === "SYNTHETIC" && tune.alerts && now - lastAlertAt > 5000) {
        lastAlertAt = now;
        sfx.alert();
        flashAlert();
        toast(`Synthetic face flagged — ${track.analysis.subtype.toLowerCase()}`, "err");
      } else if (v === "REAL" && track.lastVerdict !== "SCANNING") {
        sfx.ok();
      }
      track.lastVerdict = v;
    } else if (v !== "SCANNING") {
      track.lastVerdict = v;
    }
  }
  for (const [id, t] of tracks) {
    if (!seen.has(id) && now - t.lastSeen > 900) {
      tracks.delete(id);
      if (selectedId === id) selectedId = null;
    }
  }
  if (selectedId == null && tracks.size) selectedId = tracks.keys().next().value;

  if (now - lastPartRender > 350) {
    lastPartRender = now;
    renderParticipants();
  }
  $("facesPill").textContent = `${tracks.size} face${tracks.size === 1 ? "" : "s"}`;
  const flagged = [...tracks.values()].filter((t) => t.analysis.verdict === "SYNTHETIC" || t.analysis.verdict === "SUSPECT").length;
  $("aiPill").textContent = `${flagged} flagged`;
  $("aiPill").classList.toggle("hot", flagged > 0);
}

function flashAlert() {
  const f = $("alertFlash");
  f.classList.add("on");
  setTimeout(() => f.classList.remove("on"), 450);
}

/* ---------- HUD ---------- */
function drawHud(now) {
  if (src.tick(now) && (hud.width !== view.width || hud.height !== view.height)) sizeStage();
  hctx.clearRect(0, 0, hud.width, hud.height);
  const W = hud.width;
  for (const t of tracks.values()) {
    if (!t.box) continue;
    const b = t.box, d = t.drawBox;
    d.x += (b.x - d.x) * 0.35; d.y += (b.y - d.y) * 0.35;
    d.w += (b.width - d.w) * 0.35; d.h += (b.height - d.h) * 0.35;
    const v = t.analysis.verdict;
    const col = COLORS[v];
    const sel = t.id === selectedId;

    hctx.save();
    hctx.strokeStyle = col;
    hctx.lineWidth = sel ? 3 : 2;
    hctx.shadowColor = col;
    hctx.shadowBlur = v === "SYNTHETIC" ? 14 + Math.sin(now / 160) * 6 : 8;
    const L = Math.min(d.w, d.h) * 0.22;
    hctx.beginPath();
    // corner brackets
    hctx.moveTo(d.x, d.y + L); hctx.lineTo(d.x, d.y); hctx.lineTo(d.x + L, d.y);
    hctx.moveTo(d.x + d.w - L, d.y); hctx.lineTo(d.x + d.w, d.y); hctx.lineTo(d.x + d.w, d.y + L);
    hctx.moveTo(d.x + d.w, d.y + d.h - L); hctx.lineTo(d.x + d.w, d.y + d.h); hctx.lineTo(d.x + d.w - L, d.y + d.h);
    hctx.moveTo(d.x + L, d.y + d.h); hctx.lineTo(d.x, d.y + d.h); hctx.lineTo(d.x, d.y + d.h - L);
    hctx.stroke();
    if (sel) {
      hctx.setLineDash([4, 6]);
      hctx.lineWidth = 1;
      hctx.strokeRect(d.x - 6, d.y - 6, d.w + 12, d.h + 12);
      hctx.setLineDash([]);
    }
    hctx.restore();

    if (tune.dots && t.landmarks) {
      hctx.save();
      hctx.fillStyle = col;
      hctx.globalAlpha = 0.75;
      for (let i = 0; i < t.landmarks.length; i += 2) {
        const p = t.landmarks[i];
        hctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
      hctx.restore();
    }

    if (tune.labels) {
      const label = v === "SCANNING" ? "SCANNING…" : `${v} · ${t.analysis.score}`;
      hctx.save();
      hctx.font = `600 ${Math.max(13, W / 70)}px "Space Grotesk", sans-serif`;
      const tw = hctx.measureText(label).width;
      const lx = Math.max(4, Math.min(d.x, W - tw - 22));
      const ly = Math.max(26, d.y - 10);
      hctx.fillStyle = "rgba(3,8,18,0.85)";
      hctx.strokeStyle = col;
      hctx.lineWidth = 1;
      const bh = 24;
      hctx.beginPath();
      hctx.roundRect(lx - 8, ly - bh + 6, tw + 16, bh, 6);
      hctx.fill(); hctx.stroke();
      hctx.fillStyle = col;
      hctx.fillText(label, lx, ly);
      hctx.restore();
    }
  }
  if (src.mode === "demo") {
    $("truthChip").hidden = false;
    $("truthChip").textContent = src.demoSubject;
  }
  $("fpsPill").textContent = `${src.fps} fps`;
  if (now - lastSigRender > 220) {
    lastSigRender = now;
    renderSignals();
  }
  requestAnimationFrame(drawHud);
}

/* ---------- participants ---------- */
function renderParticipants() {
  const list = $("partList");
  const arr = [...tracks.values()].sort((a, b) => a.id - b.id);
  $("partEmpty").hidden = arr.length > 0;
  $("partCount").textContent = `${arr.length} in view`;
  list.innerHTML = "";
  for (const t of arr) {
    const a = t.analysis;
    const li = document.createElement("li");
    li.className = "part" + (t.id === selectedId ? " selected" : "");
    li.dataset.id = t.id;
    const col = COLORS[a.verdict];
    li.innerHTML = `
      <img src="${t.thumb || ""}" alt="">
      <div class="part-info">
        <div class="part-name">Face ${t.id} <span class="verdict ${VCLASS[a.verdict]}">${a.verdict}</span></div>
        <div class="part-bar"><i style="width:${a.score}%;background:${col}"></i></div>
      </div>
      <span class="part-score" style="color:${col}">${a.verdict === "SCANNING" ? "…" : a.score}</span>`;
    li.addEventListener("click", () => { selectedId = t.id; sfx.ui(); renderParticipants(); renderSignals(); });
    list.appendChild(li);
  }
}

/* ---------- signals ---------- */
function buildSignalList() {
  const ul = $("sigList");
  ul.innerHTML = "";
  for (const m of SIGNAL_META) {
    const li = document.createElement("li");
    li.className = "sig-item";
    li.innerHTML = `<span title="${m.hint}">${m.label} <b id="sigv-${m.key}">—</b></span>
      <div class="sig-meter"><i id="sigb-${m.key}"></i></div>`;
    ul.appendChild(li);
  }
}

const ADVICE = {
  SCANNING: "Collecting samples… a verdict lands after ~5 seconds of observation.",
  REAL: "Live human signals present — natural micro-motion, skin texture and sensor noise.",
  SUSPECT: "Mixed signals. Compression, beauty filters or a very still moment can cause this — look closer, don't accuse.",
  SYNTHETIC: "Multiple liveness signals missing — treat this face as unverified.",
};

function renderSignals() {
  const t = selectedId != null ? tracks.get(selectedId) : null;
  $("sigBody").hidden = !t;
  $("sigEmpty").hidden = !!t;
  $("sigTarget").textContent = t ? `Face ${t.id}` : "select a face";
  if (!t) return;
  const a = t.analysis;
  const col = COLORS[a.verdict];
  $("dialArc").style.stroke = col;
  $("dialArc").style.strokeDashoffset = String(314 * (1 - a.score / 100));
  $("dialScore").textContent = a.verdict === "SCANNING" ? "…" : a.score;
  $("dialVerdict").textContent = a.verdict;
  $("dialVerdict").style.fill = col;
  $("sigSubtype").textContent = a.subtype || "OBSERVING";
  $("sigSubtype").style.color = col;
  $("sigAdvice").textContent = ADVICE[a.verdict];
  const st = a.stats || {};
  $("sigMeta").textContent = `${Math.round((st.age || 0) / 1000)}s observed · ${st.blinks || 0} blinks · ${a.samples.length} samples`;
  for (const m of SIGNAL_META) {
    const v = a.signals[m.key];
    const pct = Math.round(v * 100);
    $("sigv-" + m.key).textContent = pct + "%";
    const bar = $("sigb-" + m.key);
    bar.style.width = pct + "%";
    bar.style.background = v > 0.6 ? "linear-gradient(90deg,#34d399,#22d3ee)" : v > 0.3 ? "linear-gradient(90deg,#fbbf24,#fb923c)" : "linear-gradient(90deg,#ff3b5c,#ff6a8d)";
  }
}

/* ---------- log ---------- */
function logEvent(track, verdict) {
  logs.unshift({
    t: new Date(),
    verdict,
    face: track.id,
    score: track.analysis.score,
    subtype: track.analysis.subtype,
    thumb: track.thumb,
  });
  if (logs.length > 100) logs.pop();
  renderLog();
}

function renderLog() {
  const filter = $("logFilter").value;
  const arr = logs.filter((l) =>
    filter === "all" ? true :
    filter === "synthetic" ? l.verdict === "SYNTHETIC" || l.verdict === "SUSPECT" :
    l.verdict === "REAL");
  $("logEmpty").hidden = arr.length > 0;
  const ul = $("logList");
  ul.innerHTML = "";
  for (const l of arr) {
    const li = document.createElement("li");
    li.className = "log-item k-" + l.verdict.toLowerCase();
    const time = l.t.toTimeString().slice(0, 8);
    li.innerHTML = `
      ${l.thumb ? `<img src="${l.thumb}" alt="">` : ""}
      <span class="log-msg"><b>Face ${l.face}</b> → <b>${l.verdict}</b> (${l.score})${l.subtype ? " · " + l.subtype : ""}</span>
      <time>${time}</time>`;
    ul.appendChild(li);
  }
}

/* ---------- report ---------- */
function exportReport() {
  const participants = [...tracks.values()].map((t) => ({
    face: t.id,
    verdict: t.analysis.verdict,
    authenticity: t.analysis.score,
    subtype: t.analysis.subtype,
    signals: Object.fromEntries(Object.entries(t.analysis.signals).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    stats: t.analysis.stats ? {
      observedSeconds: Math.round(t.analysis.stats.age / 1000),
      blinks: t.analysis.stats.blinks,
      samples: t.analysis.samples.length,
    } : null,
  }));
  const report = {
    tool: "AIFaceDetector", version: "1.0.0",
    generatedAt: new Date().toISOString(),
    source: src.mode,
    backend: getBackend(),
    tuning: tune,
    method: "Heuristic liveness triage (micro-motion, blink rhythm, skin micro-texture, color richness, sensor noise). Not forensic proof.",
    participants,
    events: logs.slice(0, 50).map((l) => ({ at: l.t.toISOString(), face: l.face, verdict: l.verdict, score: l.score, subtype: l.subtype })),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `aifacedetector-report-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  sfx.shutter();
  toast("Report downloaded — verdicts, signals & event history");
}

/* ---------- pause / sound ---------- */
function setPaused(p) {
  paused = p;
  $("pauseVeil").hidden = !p;
  $("stage").classList.toggle("paused", p);
  $("pausePath").setAttribute("d", p ? "M8 5l11 7-11 7z" : "M8 5h3v14H8zM13 5h3v14h-3z");
  sfx.ui();
}

function refreshSoundBtn() {
  $("soundBtn").classList.toggle("off", !soundOn());
  $("soundWaves").style.display = soundOn() ? "" : "none";
}

/* ---------- tuning UI ---------- */
function refreshTuneUI() {
  $("sensRange").value = tune.sens;
  $("sensVal").textContent = tune.sens.toFixed(2) + "×";
  $("intRange").value = tune.interval;
  $("intVal").textContent = tune.interval + " ms";
  $("confRange").value = tune.minConf;
  $("confVal").textContent = tune.minConf.toFixed(2);
  $("sizeSel").value = String(tune.inputSize);
  for (const [id, key] of [["labelsTgl", "labels"], ["dotsTgl", "dots"], ["mirrorTgl", "mirror"], ["alertTgl", "alerts"]]) {
    $(id).classList.toggle("on", tune[key]);
    $(id).setAttribute("aria-checked", String(tune[key]));
  }
  $("stage").classList.toggle("mirrored", tune.mirror);
  setSound(tune.sound);
  refreshSoundBtn();
}

function retuneAll() {
  const now = performance.now();
  for (const t of tracks.values()) t.analysis.compute(now, tune.sens);
  renderParticipants();
  renderSignals();
}

/* ---------- wiring ---------- */
function wire() {
  $("sourceSel").addEventListener("change", () => { sfx.ui(); switchSource($("sourceSel").value); });
  $("deviceSel").addEventListener("change", () => switchSource("webcam"));
  $("captureBtn").addEventListener("click", startScreen);
  $("gateRetry").addEventListener("click", () => {
    if ($("sourceSel").value === "screen") startScreen();
    else switchSource($("sourceSel").value);
  });
  $("gateDemo").addEventListener("click", () => { $("sourceSel").value = "demo"; switchSource("demo"); });
  $("reportBtn").addEventListener("click", exportReport);

  $("soundBtn").addEventListener("click", () => { tune.sound = !tune.sound; setSound(tune.sound); refreshSoundBtn(); saveTune(); if (tune.sound) sfx.ui(); });
  $("pauseBtn").addEventListener("click", () => setPaused(!paused));
  $("helpBtn").addEventListener("click", () => { $("helpModal").hidden = false; sfx.ui(); });
  $("helpClose").addEventListener("click", () => { $("helpModal").hidden = true; sfx.ui(); });
  $("helpModal").addEventListener("click", (e) => { if (e.target === $("helpModal")) $("helpModal").hidden = true; });

  $("sensRange").addEventListener("input", () => { tune.sens = parseFloat($("sensRange").value); $("sensVal").textContent = tune.sens.toFixed(2) + "×"; retuneAll(); saveTune(); });
  $("intRange").addEventListener("input", () => { tune.interval = parseInt($("intRange").value); $("intVal").textContent = tune.interval + " ms"; saveTune(); });
  $("confRange").addEventListener("input", () => { tune.minConf = parseFloat($("confRange").value); $("confVal").textContent = tune.minConf.toFixed(2); saveTune(); });
  $("sizeSel").addEventListener("change", () => { tune.inputSize = parseInt($("sizeSel").value); saveTune(); sfx.ui(); });
  for (const [id, key] of [["labelsTgl", "labels"], ["dotsTgl", "dots"], ["mirrorTgl", "mirror"], ["alertTgl", "alerts"]]) {
    $(id).addEventListener("click", () => {
      tune[key] = !tune[key];
      $(id).classList.toggle("on", tune[key]);
      $(id).setAttribute("aria-checked", String(tune[key]));
      if (key === "mirror") $("stage").classList.toggle("mirrored", tune.mirror);
      saveTune(); sfx.ui();
    });
  }
  $("resetTuneBtn").addEventListener("click", () => {
    tune = { ...DEFAULT_TUNE };
    refreshTuneUI(); retuneAll(); saveTune();
    toast("Tuning reset to defaults");
  });

  $("logFilter").addEventListener("change", renderLog);
  $("clearLogBtn").addEventListener("click", () => { logs = []; renderLog(); sfx.ui(); });

  // click a box on stage to select it (mirror-aware)
  hud.addEventListener("click", (e) => {
    const r = hud.getBoundingClientRect();
    let x = ((e.clientX - r.left) / r.width) * hud.width;
    const y = ((e.clientY - r.top) / r.height) * hud.height;
    if (tune.mirror) x = hud.width - x;
    let hit = null;
    for (const t of tracks.values()) {
      const b = t.drawBox;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) hit = t;
    }
    if (hit) { selectedId = hit.id; sfx.ui(); renderParticipants(); renderSignals(); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); setPaused(!paused); }
    else if (e.key === "m" || e.key === "M") $("mirrorTgl").click();
    else if (e.key === "s" || e.key === "S") $("soundBtn").click();
    else if (e.key === "?") $("helpModal").hidden = !$("helpModal").hidden;
    else if (e.key === "Escape") $("helpModal").hidden = true;
  });

  setInterval(() => { $("clockChip").textContent = new Date().toTimeString().slice(0, 8); }, 1000);
}

/* ---------- boot ---------- */
async function boot() {
  restoreTune();
  refreshTuneUI();
  buildSignalList();
  wire();
  requestAnimationFrame(drawHud);
  await switchSource("demo");
  try {
    const backend = await initEngine((s) => {
      $("enginePill").innerHTML = `<i class="dot dot-warn"></i>${s}`;
    });
    engineReady = true;
    $("enginePill").innerHTML = `<i class="dot dot-ok"></i>engine · ${backend}`;
    toast("Radar online — demo reel shows a synthetic photo & an animated avatar");
    sfx.ok();
    scheduleScan();
  } catch (err) {
    console.error("engine failed", err);
    $("enginePill").innerHTML = `<i class="dot dot-err"></i>engine failed`;
    toast("Engine failed to load — try reloading the page", "err");
  }
}

boot();