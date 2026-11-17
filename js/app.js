import { extractPosture, makeBaseline, scorePosture, FatigueTracker, STATE_LABEL, FATIGUE_LABEL } from "./metrics.js";
import { demoFrame, drawFigure, CYCLE } from "./demo.js";
import { initEngines, detectPose, detectFace } from "./engine.js";
import { WebcamSource } from "./sources.js";
import { sfx } from "./audio.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const SVG = (path, color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const ICONS = {
  good: SVG('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>', "#34d399"),
  warn: SVG('<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>', "#fbbf24"),
  alert: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>', "#fb7185"),
  sleep: SVG('<path d="M3 12h4l2-3 3 6 2-3h7"/>', "#fbbf24"),
  load: SVG('<circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/>', "#5eead4"),
  nobody: SVG('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>', "#8fb5ac"),
};

// ---------- persistence ----------
const TUNE_KEY = "pp-tuning-v1", BASE_KEY = "pp-baseline-v1";
const DEFAULT_TUNE = { alertAfterMs: 8000, breakEveryMin: 20, sens: 1, mirror: true, skeleton: true, sound: true };
let tune = { ...DEFAULT_TUNE };
const store = {
  get(k) { return new Promise((res) => { try { chrome.storage.local.get([k], (o) => res(o[k])); } catch { res(null); } }); },
  set(k, v) { try { chrome.storage.local.set({ [k]: v }); } catch {} },
};
function saveTune() { store.set(TUNE_KEY, tune); }

// ---------- state ----------
let srcKind = "demo", paused = false, engineReady = false;
let bootTime = performance.now();
let frames = 0, bodyFrames = 0, goodFrames = 0, fps = 0, lastTick = 0, dtEma = 33;
let scoreEma = null, rawState = "NO_BODY", stableState = "NO_BODY", stateRun = 0;
let parts = {}, lastLm = null, lastFace = { eyesClosed: false, yawning: false }, lastTruth = null;
let poseMs = 0, faceMs = 0, faceTick = 0;
let base = null;
const fatigue = new FatigueTracker();
let trackedMs = 0, breakAcc = 0, alerts = 0, breaks = 0;
let badSince = null, alertFired = false, goodSince = null, drowsyFired = false;
let cal = null; // {start, samples}
let timeline = []; let lastTimelinePush = 0;
let events = [];
let lastYawnTotal = 0;
const cam = new WebcamSource();
let lastVideoTs = 0;

// ---------- logging / toast ----------
function now() { return performance.now(); }
function fmtClock(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function addLog(kind, msg) {
  events.push({ t: Date.now(), kind, msg });
  if (events.length > 200) events.shift();
  const li = document.createElement("li");
  li.className = kind;
  const d = new Date();
  li.innerHTML = `<time>${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}</time><b>${msg}</b>`;
  const log = $("log");
  log.prepend(li);
  while (log.children.length > 60) log.removeChild(log.lastChild);
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function play(name) { if (tune.sound) sfx[name](); }

// ---------- status banner ----------
function setBanner(cls, icon, title, hint) {
  const b = $("statusBanner");
  b.className = "status-banner" + (cls ? " " + cls : "");
  $("statusIcon").innerHTML = ICONS[icon] || ICONS.load;
  $("statusTitle").textContent = title;
  $("statusHint").textContent = hint;
}

function updateBanner() {
  if (cal) { setBanner("", "load", "Calibrating", "Sit tall and look at the screen…"); return; }
  if (stableState === "NO_BODY") { setBanner("", "nobody", "No body in frame", "Sit back so your head and shoulders are visible."); return; }
  if (stableState !== "GOOD") {
    const cls = alertFired ? "alert" : "warn";
    setBanner(cls, alertFired ? "alert" : "warn", STATE_LABEL[stableState], alertFired ? "Alert sent — reset your posture to clear it." : `Hold threshold ${Math.round(tune.alertAfterMs / 1000)}s before the chime.`);
    return;
  }
  if (fatigue.state === "DROWSY") { setBanner("alert", "sleep", "Drowsy — take a break", "Long eye closures detected. Stand up, stretch, look away."); return; }
  if (fatigue.state === "MILD") { setBanner("warn", "sleep", "Getting tired", "Blink a bit more and relax your shoulders."); return; }
  setBanner("good", "good", "Great posture", "Keep it up — break reminder in " + fmtClock(Math.max(0, tune.breakEveryMin * 60000 - breakAcc)) + ".");
}

// ---------- coaching ----------
function coach(m, t, dt) {
  if (!m) { badSince = null; goodSince = null; return; }
  trackedMs += dt; breakAcc += dt;
  if (stableState !== "GOOD" && stableState !== "NO_BODY") {
    goodSince = null;
    if (badSince === null) badSince = t;
    if (!alertFired && t - badSince >= tune.alertAfterMs) {
      alertFired = true; alerts++;
      play("alert");
      addLog("alert", `Posture alert: ${STATE_LABEL[stableState]}`);
      toast("Posture check — " + STATE_LABEL[stableState].toLowerCase());
    }
  } else if (stableState === "GOOD") {
    if (goodSince === null) goodSince = t;
    if (badSince !== null && t - goodSince >= 2000) {
      if (alertFired) { addLog("good", "Posture recovered"); play("good"); }
      badSince = null; alertFired = false;
    }
  }
  if (breakAcc >= tune.breakEveryMin * 60000) {
    breakAcc = 0; breaks++;
    play("break");
    addLog("warn", "Break reminder (20-20-20)");
    toast("Break time: look 20 feet away for 20 seconds");
  }
  if (fatigue.totalYawns > lastYawnTotal) {
    lastYawnTotal = fatigue.totalYawns;
    play("yawn");
    addLog("warn", "Yawn detected");
  }
  if (fatigue.state === "DROWSY" && !drowsyFired) {
    drowsyFired = true;
    addLog("alert", "Drowsiness warning (PERCLOS " + Math.round(fatigue.perclos * 100) + "%)");
  }
  if (fatigue.state === "FRESH") drowsyFired = false;
}

// ---------- calibration ----------
function startCal() {
  if (cal) return;
  cal = { start: now(), samples: [] };
  $("calVeil").hidden = false;
  play("ui");
  addLog("info", "Calibration started");
}
function finishCal() {
  const b = makeBaseline(cal.samples);
  cal = null;
  $("calVeil").hidden = true;
  if (!b || b.n < 10) {
    addLog("warn", "Calibration failed — not enough samples");
    toast("Calibration failed: keep head & shoulders in frame");
    play("error");
    return;
  }
  base = b;
  store.set(BASE_KEY, base);
  $("calInfo").textContent = `Personal baseline: neck ${b.neckLen.toFixed(2)} shoulder-widths (${b.n} samples).`;
  addLog("good", "Baseline calibrated");
  toast("Baseline saved — scoring is now personal");
  play("good");
}

// ---------- main tick ----------
function tick() {
  const t = now();
  const dt = lastTick ? Math.min(2000, t - lastTick) : 33;
  lastTick = t;
  dtEma = dtEma * 0.9 + dt * 0.1;
  fps = Math.round(1000 / dtEma);
  if (!paused) {
    frames++;
    let lm = null, blend = null;
    if (srcKind === "demo") {
      const f = demoFrame(t - bootTime);
      lm = f.lm; blend = f.blend;
      lastFace = { eyesClosed: f.eyesClosed, yawning: f.yawning };
      lastTruth = f.truth;
      fatigue.push(blend, t);
    } else if (engineReady && cam.video && cam.video.readyState >= 2) {
      const ts = Math.max(t, lastVideoTs + 1); lastVideoTs = ts;
      const p = detectPose(cam.video, ts);
      lm = p.lm; poseMs = p.ms;
      if (faceTick++ % 3 === 0) {
        const f = detectFace(cam.video, ts);
        faceMs = f.ms;
        if (f.blend) {
          fatigue.push(f.blend, t);
          lastFace = { eyesClosed: (f.blend.eyeBlinkLeft + f.blend.eyeBlinkRight) / 2 > 0.5, yawning: f.blend.jawOpen > 0.6 };
        }
      }
      lastTruth = null;
    }
    lastLm = lm;
    const m = extractPosture(lm);
    if (m) {
      bodyFrames++;
      if (cal) cal.samples.push(m);
      const r = scorePosture(m, base, tune.sens);
      scoreEma = scoreEma === null ? r.score : scoreEma * 0.75 + r.score * 0.25;
      parts = r.parts;
      if (r.state === rawState) stateRun++; else { rawState = r.state; stateRun = 1; }
      if (stateRun >= 4) stableState = rawState;
      if (stableState === "GOOD") goodFrames++;
    } else {
      parts = {};
      rawState = "NO_BODY"; stateRun++;
      if (stateRun >= 4) stableState = "NO_BODY";
    }
    coach(m, t, dt);
    if (cal) {
      const p = clamp((t - cal.start) / 3000, 0, 1);
      $("calFill").style.width = Math.round(p * 100) + "%";
      if (p >= 1) finishCal();
    }
    if (t - lastTimelinePush >= 500) {
      lastTimelinePush = t;
      timeline.push({ score: scoreEma === null ? null : Math.round(scoreEma), fatigue: fatigue.index });
      if (timeline.length > 240) timeline.shift();
      drawTimeline();
    }
    updateUI();
  }
  setTimeout(tick, 33);
}

// ---------- UI ----------
function updateUI() {
  $("pillFps").textContent = "FPS " + fps;
  const trackPct = frames ? Math.round((bodyFrames / frames) * 100) : 0;
  $("pillTrack").textContent = "TRACK " + trackPct + "%";
  const score = scoreEma === null ? null : Math.round(scoreEma);
  $("scoreNum").textContent = score === null ? "–" : score;
  const sb = document.querySelector(".score-big");
  sb.className = "score-big" + (score !== null && score < 55 ? " alert" : score !== null && score < 80 ? " warn" : "");
  const tag = $("postureTag");
  tag.textContent = stableState.replace("_", " ");
  tag.className = "state-tag " + (stableState === "GOOD" ? "good" : stableState === "NO_BODY" ? "" : alertFired ? "alert" : "warn");
  const cap = { slouch: 45, shoulder: 25, head: 28, lean: 25, drift: 25 };
  for (const [k, el] of [["slouch", "pbSlouch"], ["shoulder", "pbShoulder"], ["head", "pbHead"], ["lean", "pbLean"], ["drift", "pbDrift"]]) {
    $(el).style.width = Math.round(clamp((parts[k] || 0) / cap[k], 0, 1) * 100) + "%";
  }
  $("faIndex").textContent = fatigue.index;
  $("faBlinks").textContent = fatigue.blinksPerMin ? fatigue.blinksPerMin.toFixed(1) : "–";
  $("faPerclos").textContent = Math.round(fatigue.perclos * 100) + "%";
  $("faYawns").textContent = fatigue.yawnTimes.length;
  const ft = $("fatigueTag");
  ft.textContent = FATIGUE_LABEL[fatigue.state];
  ft.className = "state-tag " + (fatigue.state === "FRESH" ? "good" : fatigue.state === "MILD" ? "warn" : "alert");
  $("stGood").textContent = bodyFrames ? Math.round((goodFrames / bodyFrames) * 100) + "%" : "–";
  $("stTracked").textContent = fmtClock(trackedMs);
  $("stAlerts").textContent = alerts;
  $("stBreaks").textContent = breaks;
  $("stBlinks").textContent = fatigue.totalBlinks;
  $("stYawns").textContent = fatigue.totalYawns;
  const chip = $("truthChip");
  if (srcKind === "demo" && lastTruth) { chip.hidden = false; chip.textContent = "DEMO: " + lastTruth; }
  else chip.hidden = true;
  if (srcKind === "webcam") $("srcNote").textContent = `Live · pose ${Math.round(poseMs)}ms · face ${Math.round(faceMs)}ms every 3rd frame`;
  updateBanner();
}

// ---------- rendering ----------
const stage = $("stage"), sctx = stage.getContext("2d");
function draw() {
  const w = stage.width, h = stage.height;
  sctx.clearRect(0, 0, w, h);
  if (srcKind === "webcam" && cam.video && cam.video.readyState >= 2) {
    sctx.save();
    if (tune.mirror) { sctx.translate(w, 0); sctx.scale(-1, 1); }
    sctx.drawImage(cam.video, 0, 0, w, h);
    sctx.restore();
    sctx.fillStyle = "rgba(3,15,12,0.25)";
    sctx.fillRect(0, 0, w, h);
  } else {
    sctx.fillStyle = "#03110e";
    sctx.fillRect(0, 0, w, h);
    sctx.strokeStyle = "rgba(45,212,191,0.07)";
    sctx.lineWidth = 1;
    for (let x = 0; x < w; x += 48) { sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, h); sctx.stroke(); }
    for (let y = 0; y < h; y += 48) { sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(w, y); sctx.stroke(); }
  }
  if (lastLm && tune.skeleton) {
    let lm = lastLm;
    if (srcKind === "webcam" && tune.mirror) lm = lastLm.map((p) => ({ ...p, x: 1 - p.x }));
    const color = stableState === "GOOD" ? "#2dd4bf" : stableState === "NO_BODY" ? "#8fb5ac" : alertFired ? "#fb7185" : "#fbbf24";
    drawFigure(sctx, lm, w, h, color, lastFace);
  }
  // score ring bottom-right
  if (scoreEma !== null) {
    const cx = w - 74, cy = h - 74, r = 44;
    const score = Math.round(scoreEma);
    const col = score >= 80 ? "#2dd4bf" : score >= 55 ? "#fbbf24" : "#fb7185";
    sctx.save();
    sctx.fillStyle = "rgba(4,20,18,0.82)";
    sctx.beginPath(); sctx.arc(cx, cy, r + 14, 0, Math.PI * 2); sctx.fill();
    sctx.strokeStyle = "rgba(45,212,191,0.18)"; sctx.lineWidth = 7;
    sctx.beginPath(); sctx.arc(cx, cy, r, 0, Math.PI * 2); sctx.stroke();
    sctx.strokeStyle = col; sctx.lineCap = "round";
    sctx.beginPath(); sctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (score / 100) * Math.PI * 2); sctx.stroke();
    sctx.fillStyle = col; sctx.font = "800 26px Manrope, sans-serif"; sctx.textAlign = "center"; sctx.textBaseline = "middle";
    sctx.fillText(String(score), cx, cy - 6);
    sctx.fillStyle = "#8fb5ac"; sctx.font = "700 10px Manrope, sans-serif";
    sctx.fillText("POSTURE", cx, cy + 16);
    sctx.restore();
  }
  requestAnimationFrame(draw);
}

function drawTimeline() {
  const c = $("timeline"), ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(45,212,191,0.1)";
  ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); ctx.stroke(); }
  if (timeline.length < 2) return;
  const step = w / 239;
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    timeline.forEach((s, i) => {
      const v = s[key];
      if (v === null) { started = false; return; }
      const x = i * step, y = h - (v / 100) * (h - 8) - 4;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  line("score", "#2dd4bf");
  line("fatigue", "#fbbf24");
}

// ---------- sources ----------
async function useWebcam() {
  if (!engineReady) { toast("Engines still loading…"); return; }
  try {
    await cam.start();
    cam.onEnded = () => { toast("Camera ended — back to demo"); useDemo(); };
    srcKind = "webcam";
    fatigue.reset(); lastYawnTotal = 0;
    scoreEma = null; stableState = "NO_BODY"; rawState = "NO_BODY"; stateRun = 0;
    $("btnWebcam").classList.add("active"); $("btnDemo").classList.remove("active");
    $("camGate").hidden = true;
    $("srcNote").textContent = `Live · pose ${Math.round(poseMs)}ms · face every 3rd frame`;
    addLog("info", "Webcam started");
    play("ui");
  } catch (e) {
    addLog("warn", "Camera unavailable: " + (e && e.name ? e.name : "error"));
    toast("Camera unavailable — staying in demo");
    play("error");
  }
}
function useDemo() {
  cam.stop();
  srcKind = "demo";
  bootTime = now();
  fatigue.reset(); lastYawnTotal = 0;
  scoreEma = null; stableState = "NO_BODY"; rawState = "NO_BODY"; stateRun = 0;
  $("btnDemo").classList.add("active"); $("btnWebcam").classList.remove("active");
  $("camGate").hidden = true;
  $("srcNote").textContent = "Procedural figure · same scoring pipeline";
  addLog("info", "Demo mode");
  play("ui");
}

// ---------- bindings ----------
function bind() {
  $("btnDemo").onclick = useDemo;
  $("btnWebcam").onclick = useWebcam;
  $("btnCam").onclick = useWebcam;
  $("btnPause").onclick = () => {
    paused = !paused;
    $("pauseVeil").hidden = !paused;
    $("btnPause").textContent = paused ? "RESUME" : "PAUSE";
    addLog("info", paused ? "Paused" : "Resumed");
    play("ui");
  };
  const syncSound = () => { $("btnSound").textContent = tune.sound ? "SOUND ON" : "SOUND OFF"; $("tSound").checked = tune.sound; };
  $("btnSound").onclick = () => { tune.sound = !tune.sound; syncSound(); saveTune(); if (tune.sound) sfx.ui(); };
  $("tSound").onchange = (e) => { tune.sound = e.target.checked; syncSound(); saveTune(); };
  const syncMirror = () => { $("btnMirror").textContent = tune.mirror ? "MIRROR ON" : "MIRROR OFF"; $("tMirror").checked = tune.mirror; };
  $("btnMirror").onclick = () => { tune.mirror = !tune.mirror; syncMirror(); saveTune(); play("ui"); };
  $("tMirror").onchange = (e) => { tune.mirror = e.target.checked; syncMirror(); saveTune(); };
  $("tSkeleton").onchange = (e) => { tune.skeleton = e.target.checked; saveTune(); };
  $("tAlert").oninput = (e) => { tune.alertAfterMs = +e.target.value * 1000; $("vAlert").textContent = e.target.value + "s"; saveTune(); };
  $("tBreak").oninput = (e) => { tune.breakEveryMin = +e.target.value; $("vBreak").textContent = e.target.value + " min"; saveTune(); };
  $("tSens").oninput = (e) => { tune.sens = +e.target.value; $("vSens").textContent = (+e.target.value).toFixed(1) + "×"; saveTune(); };
  $("btnCal").onclick = startCal;
  $("btnCalReset").onclick = () => { base = null; store.set(BASE_KEY, null); $("calInfo").textContent = "Using default baseline. Calibrate while sitting tall for a personal reference."; addLog("info", "Baseline reset"); play("ui"); };
  $("btnReport").onclick = () => {
    const report = {
      app: "PosturePal", version: "1.0.0", generated: new Date().toISOString(),
      session: { trackedMs: Math.round(trackedMs), goodPct: bodyFrames ? Math.round(goodFrames / bodyFrames * 100) : null, alerts, breaks, blinks: fatigue.totalBlinks, yawns: fatigue.totalYawns },
      fatigue: { index: fatigue.index, state: fatigue.state, perclos: +fatigue.perclos.toFixed(3), blinksPerMin: +fatigue.blinksPerMin.toFixed(1) },
      baseline: base, tuning: tune, events,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "posturepal-report.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Session report downloaded");
    addLog("info", "Report exported");
  };
  $("btnClearLog").onclick = () => { $("log").innerHTML = ""; events = []; play("ui"); };
  $("btnHelp").onclick = () => { $("helpModal").hidden = false; play("ui"); };
  $("btnCloseHelp").onclick = () => { $("helpModal").hidden = true; play("ui"); };
  $("helpModal").onclick = (e) => { if (e.target === $("helpModal")) $("helpModal").hidden = true; };
}

function applyTuneToUI() {
  $("tAlert").value = tune.alertAfterMs / 1000; $("vAlert").textContent = tune.alertAfterMs / 1000 + "s";
  $("tBreak").value = tune.breakEveryMin; $("vBreak").textContent = tune.breakEveryMin + " min";
  $("tSens").value = tune.sens; $("vSens").textContent = tune.sens.toFixed(1) + "×";
  $("tSkeleton").checked = tune.skeleton;
  $("btnSound").textContent = tune.sound ? "SOUND ON" : "SOUND OFF"; $("tSound").checked = tune.sound;
  $("btnMirror").textContent = tune.mirror ? "MIRROR ON" : "MIRROR OFF"; $("tMirror").checked = tune.mirror;
}

// ---------- boot ----------
async function boot() {
  bind();
  const saved = await store.get(TUNE_KEY);
  if (saved) tune = { ...DEFAULT_TUNE, ...saved };
  applyTuneToUI();
  const savedBase = await store.get(BASE_KEY);
  if (savedBase && savedBase.neckLen) {
    base = savedBase;
    $("calInfo").textContent = `Personal baseline: neck ${base.neckLen.toFixed(2)} shoulder-widths (${base.n} samples).`;
  }
  addLog("info", "PosturePal started — demo mode");
  setBanner("", "load", "Demo running", "Engines loading in background…");
  tick();
  requestAnimationFrame(draw);
  try {
    await initEngines();
    engineReady = true;
    $("pillEngine").textContent = "ENGINE READY";
    $("pillEngine").classList.add("ok");
    addLog("good", "Pose + face engines ready");
  } catch (e) {
    $("pillEngine").textContent = "ENGINE FAILED";
    $("pillEngine").classList.add("warn");
    addLog("alert", "Engine init failed: " + (e && e.message ? e.message : e));
    toast("Engine failed to load — demo still works");
  }
}

window.__pp = {
  get score() { return scoreEma === null ? null : Math.round(scoreEma); },
  get state() { return stableState; },
  get rawState() { return rawState; },
  get parts() { return parts; },
  get fatigue() { return { index: fatigue.index, state: fatigue.state, blinksPerMin: fatigue.blinksPerMin, perclos: fatigue.perclos, totalBlinks: fatigue.totalBlinks, totalYawns: fatigue.totalYawns, yawnsRecent: fatigue.yawnTimes.length }; },
  get alerts() { return alerts; },
  get breaks() { return breaks; },
  get trackedMs() { return trackedMs; },
  get goodPct() { return bodyFrames ? Math.round(goodFrames / bodyFrames * 100) : null; },
  get calibrated() { return !!base; },
  get base() { return base; },
  get calibrating() { return !!cal; },
  get engineReady() { return engineReady; },
  get fps() { return fps; },
  get frames() { return frames; },
  get bodyFrames() { return bodyFrames; },
  get poseMs() { return poseMs; },
  get faceMs() { return faceMs; },
  get tune() { return tune; },
  get srcKind() { return srcKind; },
  get paused() { return paused; },
  get truth() { return lastTruth; },
  get timeline() { return timeline; },
  get events() { return events; },
  get cycle() { return CYCLE; },
  startCal, useDemo, useWebcam,
  setTune(patch) { Object.assign(tune, patch); applyTuneToUI(); saveTune(); },
  setBreakAcc(v) { breakAcc = v; },
};

boot();