// Webcam source. Frames stay on-device; nothing is recorded or uploaded.
export class WebcamSource {
  constructor() { this.stream = null; this.video = null; this.onEnded = null; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 640, facingMode: "user" },
      audio: false,
    });
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.srcObject = this.stream;
    await v.play();
    this.video = v;
    this.stream.getVideoTracks()[0].addEventListener("ended", () => {
      if (this.onEnded) this.onEnded("cam-ended");
    });
    return v;
  }
  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null; this.video = null;
  }
}