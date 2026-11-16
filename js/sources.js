// Video sources: demo reel (synthetic photo + animated avatar), webcam,
// and screen / meeting-tab capture via getDisplayMedia.

export class SourceManager {
  constructor(canvas, onStatus) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onStatus = onStatus;
    this.mode = "none";
    this.stream = null;
    this.video = null;
    this.demo = null;
    this.frames = 0;
    this.fps = 0;
    this._fpsAt = performance.now();
    this.label = "";
    this.demoSubject = "";
  }

  _size(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  async _loadImg(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  }

  async useDemo() {
    this.stop();
    this.mode = "demo";
    this._size(1280, 720);
    const [photo, avatar] = await Promise.all([
      this._loadImg("assets/ai-photo.jpg"),
      this._loadImg("assets/avatar.jpg"),
    ]);
    this.demo = { photo, avatar, start: performance.now(), period: 16000 };
    this.label = "DEMO REEL";
    this.onStatus("demo reel running");
  }

  async useWebcam(deviceId) {
    this.stop();
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    await this.video.play();
    this._size(this.video.videoWidth || 1280, this.video.videoHeight || 720);
    this.mode = "webcam";
    this.label = "WEBCAM";
    this.onStatus("webcam live");
  }

  async useScreen() {
    this.stop();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } },
      audio: false,
    });
    this.stream = stream;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    await this.video.play();
    this._size(this.video.videoWidth || 1280, this.video.videoHeight || 720);
    this.mode = "screen";
    this.label = "SCREEN / TAB";
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      if (this.mode === "screen") this.onStatus("share-ended");
    });
    this.onStatus("capturing screen");
  }

  tick(now) {
    if (this.mode === "demo" && this.demo) {
      const { photo, avatar, start, period } = this.demo;
      const phase = ((now - start) % (period * 2)) / period;
      const idx = Math.floor(phase);
      const img = idx === 0 ? photo : avatar;
      this.demoSubject = idx === 0 ? "AI PHOTO · STATIC FEED (ground truth)" : "ANIMATED AVATAR · STATIC FEED (ground truth)";
      const ctx = this.ctx;
      const W = this.canvas.width, H = this.canvas.height;
      // static feed: identical pixels every frame, like a frozen camera tile
      const scale = Math.max(W / img.width, H / img.height) * 1.04;
      const dw = img.width * scale, dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(2,6,14,0.5)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      this._count(now);
      return true;
    }
    if (this.video && this.video.readyState >= 2) {
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      if (vw && vh && (this.canvas.width !== vw || this.canvas.height !== vh)) this._size(vw, vh);
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      this._count(now);
      return true;
    }
    return false;
  }

  _count(now) {
    this.frames++;
    if (now - this._fpsAt > 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this._fpsAt));
      this.frames = 0;
      this._fpsAt = now;
    }
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.demo = null;
    this.mode = "none";
    this.fps = 0;
  }
}