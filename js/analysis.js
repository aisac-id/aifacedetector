// Authenticity engine — five on-device liveness signals per face track.
// Honest heuristics: micro-motion, blinking, skin micro-texture, color
// richness and temporal sensor noise. Not a forensic deepfake classifier.

const scratch = document.createElement("canvas");
scratch.width = 160; scratch.height = 160;
const sctx = scratch.getContext("2d", { willReadFrequently: true });
const CS = 160;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

function cropStats(srcCanvas, box) {
  const pad = box.width * 0.12;
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(srcCanvas.width - sx, box.width + pad * 2);
  const sh = Math.min(srcCanvas.height - sy, box.height + pad * 2);
  if (sw < 12 || sh < 12) return null;
  sctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, CS, CS);
  const d = sctx.getImageData(0, 0, CS, CS).data;
  const n = CS * CS;
  const gray = new Float32Array(n);
  const colors = new Set();
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  // high-frequency energy: |gray - 3x3 box blur|; skin noise = hi energy
  // measured only on non-edge pixels (local range < 18) so crisp cartoon
  // edges don't masquerade as skin texture.
  const hi = new Float32Array(n);
  let hiSum = 0, flat = 0, skinSum = 0, skinN = 0;
  const B = CS - 2;
  for (let y = 1; y < CS - 1; y++) {
    for (let x = 1; x < CS - 1; x++) {
      const i = y * CS + x;
      let sum = 0, mx = -1, mn = 256;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = gray[i + dy * CS + dx];
          sum += v;
          if (v > mx) mx = v;
          if (v < mn) mn = v;
        }
      }
      const h = Math.abs(gray[i] - sum / 9);
      hi[i] = h;
      hiSum += h;
      const range = mx - mn;
      if (range < 3) flat++;
      if (range < 18) { skinSum += h; skinN++; }
    }
  }
  const inner = B * B;
  return {
    hi,
    hiMean: hiSum / inner,
    skinNoise: skinN ? skinSum / skinN : 0,
    flatRatio: flat / inner,
    colorCount: colors.size,
  };
}

function eyeAspect(pts, a, b, c, d, e, f) {
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  return (dist(pts[b], pts[f]) + dist(pts[c], pts[e])) / (2 * dist(pts[a], pts[d]) + 1e-6);
}

function relLandmarks(positions, box) {
  let cx = 0, cy = 0;
  for (const p of positions) { cx += p.x; cy += p.y; }
  cx /= positions.length; cy /= positions.length;
  const s = box.width || 1;
  return positions.map((p) => ({ x: (p.x - cx) / s, y: (p.y - cy) / s }));
}

export class FaceAnalysis {
  constructor() {
    this.born = performance.now();
    this.samples = [];        // { t, j, ear, hiMean, flatRatio, colorCount, resid }
    this.prevRel = null;
    this.prevHi = null;
    this.blinks = [];
    this.earHist = [];
    this.lastBlinkAt = 0;
    this.wasClosed = false;
    this.signals = { micro: 0.5, blink: 0.55, texture: 0.5, color: 0.5, temporal: 0.5 };
    this.score = 55;
    this.verdict = "SUSPECT";
    this.subtype = "";
    this.mature = false;
  }

  update(srcCanvas, det, now, sensitivity) {
    const box = det.detection.box;
    const pts = det.landmarks.positions;
    const rel = relLandmarks(pts, box);
    let j = null;
    if (this.prevRel) {
      let s = 0;
      for (let i = 0; i < rel.length; i++) {
        s += Math.hypot(rel[i].x - this.prevRel[i].x, rel[i].y - this.prevRel[i].y);
      }
      j = s / rel.length;
    }
    this.prevRel = rel;

    const ear = (eyeAspect(pts, 36, 37, 38, 39, 40, 41) + eyeAspect(pts, 42, 43, 44, 45, 46, 47)) / 2;
    this.earHist.push(ear);
    if (this.earHist.length > 24) this.earHist.shift();
    const sorted = [...this.earHist].sort((a, b) => a - b);
    const base = sorted[Math.floor(sorted.length / 2)] || ear;
    const closed = ear < base * 0.72;
    if (closed && !this.wasClosed && now - this.lastBlinkAt > 260) {
      this.blinks.push(now);
      this.lastBlinkAt = now;
    }
    this.wasClosed = closed;
    this.blinks = this.blinks.filter((t) => now - t < 14000);

    const cs = cropStats(srcCanvas, box);
    let resid = null;
    if (cs) {
      if (this.prevHi) {
        let s = 0;
        for (let i = 0; i < cs.hi.length; i++) s += Math.abs(cs.hi[i] - this.prevHi[i]);
        resid = s / cs.hi.length;
      }
      this.prevHi = cs.hi;
      this.samples.push({ t: now, j, ear, resid, hiMean: cs.hiMean, skinNoise: cs.skinNoise, flatRatio: cs.flatRatio, colorCount: cs.colorCount });
      if (this.samples.length > 48) this.samples.shift();
    }

    this.compute(now, sensitivity);
  }

  compute(now, sensitivity = 1) {
    const age = now - this.born;
    this.mature = age > 4500 && this.samples.length >= 6;
    const recent = this.samples.slice(-14);
    const jMean = mean(recent.filter((s) => s.j != null).map((s) => s.j));
    const skinMean = mean(recent.map((s) => s.skinNoise));
    const flatMean = mean(recent.map((s) => s.flatRatio));
    const colMean = mean(recent.map((s) => s.colorCount));
    const residMean = mean(recent.filter((s) => s.resid != null).map((s) => s.resid));
    const earVar = (() => {
      const e = recent.map((s) => s.ear);
      const m = mean(e);
      return mean(e.map((v) => (v - m) * (v - m)));
    })();

    const sig = {};
    sig.micro = clamp01((jMean - 0.0022) / 0.005);
    if (age < 5000) sig.blink = 0.55;
    else if (this.blinks.length >= 1) sig.blink = 1;
    else sig.blink = clamp01(earVar / 0.0016) * 0.45 + 0.12;
    sig.texture = clamp01((skinMean - 0.35) / 1.3);
    sig.color = clamp01((colMean - 120) / 380) * 0.5 + clamp01(1 - (flatMean - 0.32) / 0.4) * 0.5;
    sig.temporal = clamp01((residMean - 0.25) / 0.8);
    this.signals = sig;

    const raw =
      sig.micro * 0.24 + sig.blink * 0.16 + sig.texture * 0.24 +
      sig.color * 0.14 + sig.temporal * 0.22;
    this.score = Math.round(clamp01(raw * sensitivity) * 100);

    if (!this.mature) {
      this.verdict = "SCANNING";
    } else if (this.score >= 64) {
      this.verdict = "REAL";
    } else if (this.score >= 38) {
      this.verdict = "SUSPECT";
    } else {
      this.verdict = "SYNTHETIC";
    }

    if (this.verdict !== "REAL" && this.verdict !== "SCANNING") {
      if (sig.color < 0.22 && flatMean > 0.4) this.subtype = "ANIMATED AVATAR";
      else if (sig.micro < 0.18 && sig.temporal < 0.25) this.subtype = "STATIC / LOOPED FACE";
      else this.subtype = "AI-GENERATED LIKENESS";
    } else {
      this.subtype = this.verdict === "REAL" ? "LIVE HUMAN SIGNALS" : "";
    }
    this.stats = { jMean, skinMean, flatMean, colMean, residMean, blinks: this.blinks.length, age };
  }
}

export const SIGNAL_META = [
  { key: "micro", label: "Micro-motion", hint: "Natural landmark jitter vs frozen rig" },
  { key: "blink", label: "Blink rhythm", hint: "Eye-aspect-ratio dips over time" },
  { key: "texture", label: "Skin micro-texture", hint: "High-frequency detail GANs tend to smooth away" },
  { key: "color", label: "Color richness", hint: "Quantized palette exposes cel-shaded avatars" },
  { key: "temporal", label: "Sensor noise", hint: "Frame-to-frame grain real cameras always carry" },
];