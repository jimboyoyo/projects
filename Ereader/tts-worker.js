// Runs the Kokoro text-to-speech model off the main thread so page turns stay smooth.
//
// Messages in:
//   {type:"load", gpu:boolean, voice:string}
//   {type:"gen", id, epoch, text, voice, speed}   queue one sentence for generation
//   {type:"epoch", n}                             anything queued under an older epoch is dropped
// Messages out:
//   {type:"progress", pct} | {type:"status", text} | {type:"ready", device, dtype, warmMs}
//   {type:"start", id} | {type:"audio", id, audio, sr, ms} | {type:"skipped", id} | {type:"error", id, message}
//
// The model runs one sentence at a time and a running job cannot be interrupted, so the page bumps the
// epoch whenever you jump, step, replay or pause. Jobs that are still waiting are then skipped instead of
// making the sentence you actually want wait behind them.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;
let loadP = null;
let latest = 0;          // newest epoch seen
const queue = [];
let busy = false;
let curId = null;        // job being generated right now
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(wantGpu, voice) {
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
  let lastErr, used = null;
  for (const a of attempts) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL, { dtype: a.dtype, device: a.device, progress_callback });
      used = a;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!used) throw lastErr;
  // The first run compiles shaders and allocates buffers, so do it now instead of during the first sentence.
  postMessage({ type: "status", text: "Warming up the voice…" });
  let warmMs = 0;
  try {
    const t0 = performance.now();
    await tts.generate("Ready.", { voice: voice || "af_heart" });
    if (used.device === "webgpu") await tts.generate("It was a bright cold day in April, and the clocks were striking thirteen.", { voice: voice || "af_heart" });
    warmMs = Math.round(performance.now() - t0);
  } catch (err) { /* a failed warm-up is not fatal */ }
  postMessage({ type: "ready", device: used.device, dtype: used.dtype, warmMs, threads: self.crossOriginIsolated ? Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1 });
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    if (loadP) await loadP;
    for (;;) {
      await sleep(2);                        // let any newer epoch message arrive before choosing the next job
      const job = queue.shift();
      if (!job) break;
      if (job.epoch < latest) { postMessage({ type: "skipped", id: job.id }); continue; }
      postMessage({ type: "start", id: job.id });
      curId = job.id;
      const t0 = performance.now();
      try {
        if (!tts) throw new Error("model not loaded");
        const a = await tts.generate(job.text, { voice: job.voice, speed: job.speed });
        const f = a.audio;
        postMessage({ type: "audio", id: job.id, audio: f, sr: a.sampling_rate, ms: Math.round(performance.now() - t0) }, [f.buffer]);
      } catch (err) {
        postMessage({ type: "error", id: job.id, message: String((err && err.message) || err) });
      }
      curId = null;
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "load") {
    loadP = load(m.gpu, m.voice).catch((err) =>
      postMessage({ type: "error", id: null, message: String((err && err.message) || err) })
    );
  } else if (m.type === "epoch") {
    latest = Math.max(latest, m.n);
  } else if (m.type === "gen") {
    latest = Math.max(latest, m.epoch);
    queue.push(m);
    pump();
  }
};

// A lost GPU device surfaces as an unhandled promise rejection inside the runtime, so the job would never finish.
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  if (curId != null) { const id = curId; curId = null; postMessage({ type: "error", id, message: "GPU device lost: " + String((e.reason && e.reason.message) || e.reason) }); }
});
