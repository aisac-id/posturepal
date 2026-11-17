// Procedural demo: a synthetic seated figure (33 pose landmarks, key ones animated)
// plus synthetic face blendshapes. Feeds the SAME metrics pipeline as the webcam.
// Script cycle 27s: GOOD 5s → SLOUCH 5s → HEAD_TILT 4s → LEAN 4s → FATIGUE 9s.

export const CYCLE = 27000;
const TRANS = 400;

const SEGMENTS = [
  { state: "GOOD", dur: 5000 },
  { state: "SLOUCH", dur: 5000 },
  { state: "HEAD_TILT", dur: 4000 },
  { state: "LEAN", dur: 4000 },
  { state: "FATIGUE", dur: 9000 },
];

// closures [start,end] within cycle (ms); long ones are drowsy, short ones are blinks
const CLOSURES = [[2200, 2350], [18500, 20000], [20400, 22000], [22400, 23600], [24000, 25200]];
const YAWN = [25600, 27000];

function basePose(state) {
  // front-facing seated figure, normalized coords
  let shL = { x: 0.38, y: 0.52 }, shR = { x: 0.62, y: 0.52 };
  let hipL = { x: 0.40, y: 0.85 }, hipR = { x: 0.60, y: 0.85 };
  let nose = { x: 0.50, y: 0.30 }, earL = { x: 0.445, y: 0.315 }, earR = { x: 0.555, y: 0.315 };
  if (state === "SLOUCH") {
    nose = { x: 0.50, y: 0.42 }; earL = { x: 0.445, y: 0.435 }; earR = { x: 0.555, y: 0.435 };
    shL = { x: 0.38, y: 0.55 }; shR = { x: 0.62, y: 0.55 };
  } else if (state === "HEAD_TILT") {
    const a = 22 * Math.PI / 180, cx = 0.5, cy = 0.33;
    const rot = (p) => ({ x: cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a), y: cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a) });
    nose = rot(nose); earL = rot(earL); earR = rot(earR);
  } else if (state === "LEAN") {
    const dx = 0.10;
    shL = { ...shL, x: shL.x + dx }; shR = { ...shR, x: shR.x + dx };
    nose = { ...nose, x: nose.x + dx }; earL = { ...earL, x: earL.x + dx }; earR = { ...earR, x: earR.x + dx };
  }
  return { nose, earL, earR, shL, shR, hipL, hipR };
}

const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, visibility: 0.99 });

export function demoFrame(t) {
  const tc = ((t % CYCLE) + CYCLE) % CYCLE;
  let acc = 0, idx = 0, local = 0;
  for (let i = 0; i < SEGMENTS.length; i++) {
    if (tc < acc + SEGMENTS[i].dur) { idx = i; local = tc - acc; break; }
    acc += SEGMENTS[i].dur;
  }
  const seg = SEGMENTS[idx];
  const prev = SEGMENTS[(idx + SEGMENTS.length - 1) % SEGMENTS.length];
  const cur = basePose(seg.state);
  const k = Math.min(1, local / TRANS);
  const from = basePose(prev.state);
  const mix = {};
  for (const key of Object.keys(cur)) mix[key] = lerpP(from[key], cur[key], k);
  // gentle breathing jitter
  const j = Math.sin(t / 900) * 0.002;
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.9, visibility: 0.1 }));
  lm[0] = { ...mix.nose, y: mix.nose.y + j, visibility: 0.99 };
  lm[7] = mix.earL; lm[8] = mix.earR;
  lm[11] = { ...mix.shL, y: mix.shL.y + j }; lm[12] = { ...mix.shR, y: mix.shR.y + j };
  lm[23] = mix.hipL; lm[24] = mix.hipR;
  // elbows/wrists for a nicer skeleton
  lm[13] = { x: mix.shL.x - 0.04, y: 0.68, visibility: 0.9 };
  lm[14] = { x: mix.shR.x + 0.04, y: 0.68, visibility: 0.9 };
  lm[15] = { x: mix.shL.x + 0.02, y: 0.80, visibility: 0.9 };
  lm[16] = { x: mix.shR.x - 0.02, y: 0.80, visibility: 0.9 };
  // face blendshapes
  let eye = 0;
  for (const [a, b] of CLOSURES) if (tc >= a && tc < b) eye = 0.9;
  const jaw = tc >= YAWN[0] && tc < YAWN[1] ? 0.75 : 0.02;
  const blend = { eyeBlinkLeft: eye, eyeBlinkRight: eye, jawOpen: jaw };
  return { lm, blend, truth: seg.state, eyesClosed: eye > 0.5, yawning: jaw > 0.6 };
}

const BONES = [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16]];

export function drawFigure(ctx, lm, w, h, color, face) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    ctx.beginPath(); ctx.moveTo(lm[a].x * w, lm[a].y * h); ctx.lineTo(lm[b].x * w, lm[b].y * h); ctx.stroke();
  }
  // head
  const nose = lm[0], earL = lm[7], earR = lm[8];
  const cx = (earL.x + earR.x) / 2 * w, cy = (earL.y + earR.y) / 2 * h;
  const r = Math.hypot((earR.x - earL.x) * w, (earR.y - earL.y) * h) * 0.85;
  const ang = Math.atan2((earR.y - earL.y) * h, (earR.x - earL.x) * w);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  // neck
  ctx.beginPath(); ctx.moveTo(cx, cy + r); ctx.lineTo((lm[11].x + lm[12].x) / 2 * w, (lm[11].y + lm[12].y) / 2 * h); ctx.stroke();
  // eyes + mouth rotate with head
  ctx.translate(cx, cy); ctx.rotate(ang);
  ctx.fillStyle = color;
  const eo = r * 0.4, ey = -r * 0.15;
  if (face && face.eyesClosed) {
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-eo - r * 0.14, ey); ctx.lineTo(-eo + r * 0.14, ey); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(eo - r * 0.14, ey); ctx.lineTo(eo + r * 0.14, ey); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(-eo, ey, r * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(eo, ey, r * 0.09, 0, Math.PI * 2); ctx.fill();
  }
  if (face && face.yawning) {
    ctx.beginPath(); ctx.ellipse(0, r * 0.45, r * 0.16, r * 0.24, 0, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-r * 0.18, r * 0.45); ctx.lineTo(r * 0.18, r * 0.45); ctx.stroke();
  }
  ctx.restore();
  // landmark dots
  ctx.save(); ctx.fillStyle = "#5eead4";
  for (const i of [0, 7, 8, 11, 12, 23, 24]) {
    ctx.beginPath(); ctx.arc(lm[i].x * w, lm[i].y * h, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}