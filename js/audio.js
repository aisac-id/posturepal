// Soft wellness chimes — pure WebAudio, no assets.
let ctx = null;
function ac() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
function tone(freq, t0, dur, type = "sine", gain = 0.08) {
  const a = ac(), o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
export const sfx = {
  ui() { try { const t = ac().currentTime; tone(660, t, 0.09, "sine", 0.05); } catch {} },
  good() { try { const t = ac().currentTime; tone(523, t, 0.18); tone(784, t + 0.12, 0.25); } catch {} },
  alert() { try { const t = ac().currentTime; tone(392, t, 0.22, "sine", 0.09); tone(330, t + 0.2, 0.3, "sine", 0.09); } catch {} },
  break() { try { const t = ac().currentTime; tone(523, t, 0.2); tone(659, t + 0.18, 0.2); tone(880, t + 0.36, 0.4); } catch {} },
  yawn() { try { const t = ac().currentTime; tone(440, t, 0.3, "triangle", 0.05); } catch {} },
  error() { try { const t = ac().currentTime; tone(220, t, 0.25, "square", 0.04); } catch {} },
};