// PosturePal metrics — pure functions, no DOM. Calibrated offline + in-browser.
// Pose landmark indices (MediaPipe): 0 nose, 7 leftEar, 8 rightEar,
// 11 leftShoulder, 12 rightShoulder, 23 leftHip, 24 rightHip.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const deg = (rad) => Math.abs(rad * 180 / Math.PI);

export function extractPosture(lm) {
  if (!lm || lm.length < 25) return null;
  const nose = lm[0], earL = lm[7], earR = lm[8];
  const shL = lm[11], shR = lm[12], hipL = lm[23], hipR = lm[24];
  const vis = (p) => (p.visibility === undefined ? 1 : p.visibility);
  if ([nose, shL, shR].some((p) => vis(p) < 0.5)) return null;
  const shMid = mid(shL, shR);
  const shoulderW = dist(shL, shR);
  if (shoulderW < 0.04) return null; // too far / partial body
  const hipMid = mid(hipL, hipR);
  const hipsOk = vis(hipL) > 0.4 && vis(hipR) > 0.4;
  const earsOk = vis(earL) > 0.4 && vis(earR) > 0.4;
  return {
    shoulderW,
    // vertical nose→shoulder distance in shoulder-widths: shrinks when slouching
    neckLen: (shMid.y - nose.y) / shoulderW,
    // horizontal head offset from shoulder centre (head jutting sideways)
    headOffset: (nose.x - shMid.x) / shoulderW,
    shoulderTiltDeg: deg(Math.atan2(shR.y - shL.y, shR.x - shL.x)),
    headRollDeg: earsOk ? deg(Math.atan2(earR.y - earL.y, earR.x - earL.x)) : 0,
    lean: hipsOk ? (shMid.x - hipMid.x) / shoulderW : 0,
    earsOk, hipsOk,
  };
}

// Baseline = average of good-posture samples captured during calibration.
export function makeBaseline(samples) {
  if (!samples.length) return null;
  const avg = (k) => samples.reduce((s, m) => s + m[k], 0) / samples.length;
  return { neckLen: avg("neckLen"), headOffset: avg("headOffset"), n: samples.length };
}

export const DEFAULT_BASE = { neckLen: 0.9, headOffset: 0, n: 0 };

// Returns {score, state, parts}. Each penalty is capped; worst part names the state.
export function scorePosture(m, base, sens = 1) {
  if (!m) return { score: 0, state: "NO_BODY", parts: {} };
  const b = base || DEFAULT_BASE;
  const parts = {};
  const ratio = m.neckLen / Math.max(0.3, b.neckLen);
  parts.slouch = clamp(((1 - ratio) / 0.35) * 45, 0, 45);
  parts.shoulder = clamp((m.shoulderTiltDeg - 4) * 2.2, 0, 25);
  parts.head = clamp((m.headRollDeg - 6) * 1.8, 0, 28);
  parts.lean = clamp((Math.abs(m.lean) - 0.12) * 90, 0, 25);
  parts.drift = clamp((Math.abs(m.headOffset - b.headOffset) - 0.1) * 80, 0, 25);
  let worst = null, worstV = 0, total = 0;
  for (const [k, v] of Object.entries(parts)) {
    const sv = v * sens;
    total += sv;
    if (sv > worstV) { worstV = sv; worst = k; }
  }
  const score = Math.round(clamp(100 - total, 0, 100));
  let state = "GOOD";
  if (score < 80 && worst) {
    state = { slouch: "SLOUCHING", shoulder: "SHOULDER_TILT", head: "HEAD_TILT", lean: "LEANING", drift: "HEAD_FORWARD" }[worst];
  }
  return { score, state, parts };
}

// Fatigue from FaceLandmarker blendshapes: eyeBlinkLeft/Right, jawOpen.
// Time-weighted so frame-rate changes (background throttling) don't skew rates.
export class FatigueTracker {
  constructor() { this.reset(); }
  reset() {
    this.closed = false; this.closedAt = 0;
    this.jaw = false; this.jawAt = 0;
    this.blinkTimes = []; this.yawnTimes = [];
    this.closedTime = 0; this.windowTime = 0;
    this.samples = []; // {t, closed} ring for 60s window
    this.lastT = null;
    this.blinksPerMin = 0; this.perclos = 0; this.index = 0; this.state = "FRESH";
    this.totalBlinks = 0; this.totalYawns = 0;
  }
  push(blend, t) {
    if (!blend) return;
    const eye = ((blend.eyeBlinkLeft || 0) + (blend.eyeBlinkRight || 0)) / 2;
    const jawOpen = blend.jawOpen || 0;
    const isClosed = eye > 0.5;
    const dt = this.lastT === null ? 0 : Math.min(2000, t - this.lastT);
    this.lastT = t;
    // blink edges
    if (isClosed && !this.closed) this.closedAt = t;
    if (!isClosed && this.closed) {
      const dur = t - this.closedAt;
      if (dur >= 60 && dur <= 500) { this.blinkTimes.push(t); this.totalBlinks++; }
    }
    this.closed = isClosed;
    // yawn: jaw wide open sustained >= 800ms, once per episode
    if (jawOpen > 0.6 && !this.jaw) { this.jaw = true; this.jawAt = t; }
    if (jawOpen > 0.6 && this.jaw && !this.jawFired && t - this.jawAt >= 800) {
      this.jawFired = true; this.yawnTimes.push(t); this.totalYawns++;
    }
    if (jawOpen <= 0.6) { this.jaw = false; this.jawFired = false; }
    // 60s rolling window, time-weighted PERCLOS
    this.samples.push({ t, closed: isClosed, dt });
    while (this.samples.length && t - this.samples[0].t > 60000) this.samples.shift();
    let ct = 0, wt = 0;
    for (const s of this.samples) { wt += s.dt; if (s.closed) ct += s.dt; }
    this.perclos = wt > 0 ? ct / wt : 0;
    this.windowTime = wt;
    this.blinkTimes = this.blinkTimes.filter((bt) => t - bt <= 60000);
    this.yawnTimes = this.yawnTimes.filter((yt) => t - yt <= 180000);
    const spanMin = Math.max(10000, wt) / 60000; // rates need >=10s to be meaningful
    this.blinksPerMin = wt >= 10000 ? this.blinkTimes.length / spanMin : 0;
    const lowBlink = wt >= 30000 ? clamp(10 - this.blinksPerMin, 0, 10) * 2.5 : 0;
    // PERCLOS > ~0.15 is treated as impaired in drowsiness research; 260 maps 0.23 → 60.
    this.index = Math.round(clamp(this.perclos * 260 + lowBlink + this.yawnTimes.length * 12, 0, 100));
    this.state = this.index > 60 ? "DROWSY" : this.index > 30 ? "MILD" : "FRESH";
  }
}

export const STATE_LABEL = {
  GOOD: "Great posture",
  SLOUCHING: "Slouching — sit tall",
  SHOULDER_TILT: "Shoulders uneven",
  HEAD_TILT: "Head tilted",
  LEANING: "Leaning to one side",
  HEAD_FORWARD: "Head drifting forward",
  NO_BODY: "No body in frame",
};

export const FATIGUE_LABEL = { FRESH: "Fresh", MILD: "Getting tired", DROWSY: "Drowsy — take a break" };