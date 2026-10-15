// Runs the Kokoro text-to-speech model off the main thread so page turns stay smooth.
// Messages in:  {type:"load", gpu:boolean} | {type:"gen", id, text, voice, speed}
// Messages out: {type:"progress", pct} | {type:"ready", device} | {type:"audio", id, audio, sr} | {type:"error", id, message}
// The package ships a self-contained browser bundle (it includes transformers.js and the ONNX runtime loader).
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;
let chain = Promise.resolve(); // the model runs one request at a time

async function load(wantGpu) {
  const files = {};
  let best = 0;
  const progress_callback = (p) => {
    if (p && p.status === "progress" && p.file && p.total) {
      files[p.file] = { loaded: p.loaded, total: p.total };
      let l = 0, t = 0;
      for (const k in files) { l += files[k].loaded; t += files[k].total; }
      best = Math.max(best, Math.round((l / t) * 100));
      postMessage({ type: "progress", pct: best });
    }
  };
  const attempts = [];
  if (wantGpu && self.navigator && self.navigator.gpu) attempts.push({ device: "webgpu", dtype: "fp32" });
  attempts.push({ device: "wasm", dtype: "q8" });
  let lastErr;
  for (const a of attempts) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL, { dtype: a.dtype, device: a.device, progress_callback });
      postMessage({ type: "ready", device: a.device });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "load") {
    chain = chain.then(() => load(m.gpu)).catch((err) =>
      postMessage({ type: "error", id: null, message: String((err && err.message) || err) })
    );
  } else if (m.type === "gen") {
    chain = chain.then(async () => {
      try {
        if (!tts) throw new Error("model not loaded");
        const a = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
        const f = a.audio;
        postMessage({ type: "audio", id: m.id, audio: f, sr: a.sampling_rate }, [f.buffer]);
      } catch (err) {
        postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
      }
    });
  }
};
