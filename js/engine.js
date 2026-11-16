// Model loading + face detection (face-api.js / TensorFlow.js, all local).
let backend = "webgl";

export async function initEngine(onStatus) {
  onStatus("booting engine…");
  try {
    await faceapi.tf.setBackend("webgl");
    await faceapi.tf.ready();
  } catch (e) {
    backend = "cpu";
    await faceapi.tf.setBackend("cpu");
    await faceapi.tf.ready();
  }
  onStatus("loading detector…");
  const base = "vendor/weights";
  await faceapi.nets.tinyFaceDetector.loadFromUri(base);
  onStatus("loading landmarks…");
  await faceapi.nets.faceLandmark68Net.loadFromUri(base);
  onStatus("ready");
  return backend;
}

export function getBackend() { return backend; }

export async function detect(canvas, { inputSize = 320, minConfidence = 0.4 } = {}) {
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: minConfidence });
  return faceapi.detectAllFaces(canvas, opts).withFaceLandmarks();
}

export function faceThumb(srcCanvas, box, size = 72) {
  const pad = box.width * 0.22;
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(srcCanvas.width - sx, box.width + pad * 2);
  const sh = Math.min(srcCanvas.height - sy, box.height + pad * 2);
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  const s = Math.max(sw, sh);
  const ox = sx + (sw - s) / 2, oy = sy + (sh - s) / 2;
  ctx.drawImage(srcCanvas, ox, oy, s, s, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.8);
}