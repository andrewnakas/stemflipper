/**
 * Record a real /flip run's Gradio SSE frames to web/test/fixtures/gradio_frames.jsonl.
 *
 * The mock backend (scripts/mock_backend.mjs) replays these with their original timing, and
 * test/job.test.ts drives the reducer with them, so the UI is built against what the Space
 * actually sends rather than what we assume it sends.
 *
 *   node scripts/record_frames.mjs [--file ../tests/assets/mix.wav] [--preset fast]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);
const BASE = (args.backend || "https://nakas-stemflipper.hf.space").replace(/\/+$/, "");
const API = `${BASE}/gradio_api`;
const FILE = resolve(HERE, args.file || "../../tests/assets/mix.wav");
const PRESET = args.preset || "fast";
const OUT = resolve(HERE, "../test/fixtures/gradio_frames.jsonl");

const t0 = Date.now();
const log = (...m) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...m);

const bytes = await readFile(FILE);
log(`uploading ${basename(FILE)} (${bytes.length} bytes) to ${BASE}`);

const form = new FormData();
form.append("files", new Blob([bytes], { type: "audio/wav" }), basename(FILE));
const up = await fetch(`${API}/upload`, { method: "POST", credentials: "omit", body: form });
if (!up.ok) throw new Error(`upload failed (${up.status})`);
const [serverPath] = await up.json();
log("uploaded ->", serverPath);

const session_hash = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const join = await fetch(`${API}/queue/join`, {
  method: "POST",
  credentials: "omit",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    data: [{ path: serverPath, orig_name: basename(FILE), meta: { _type: "gradio.FileData" } }, PRESET, false],
    fn_index: 0,
    session_hash,
    trigger_id: null,
  }),
});
if (!join.ok) throw new Error(`queue join failed (${join.status})`);
log("joined:", JSON.stringify(await join.json()));

const res = await fetch(`${API}/queue/data?session_hash=${session_hash}`, {
  headers: { accept: "text/event-stream" },
  credentials: "omit",
});
if (!res.ok) throw new Error(`stream failed (${res.status})`);

const frames = [];
let buf = "";
const dec = new TextDecoder();
outer: for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let msg;
    try { msg = JSON.parse(data); } catch { continue; }
    const at = Date.now() - t0;
    frames.push({ at, msg });
    const note = msg.msg === "progress"
      ? `${msg.progress_data?.[0]?.progress ?? "?"} ${msg.progress_data?.[0]?.desc ?? ""}`
      : msg.msg === "estimation" ? `rank=${msg.rank} size=${msg.queue_size} eta=${msg.rank_eta}` : "";
    log(msg.msg, note);
    if (msg.msg === "process_completed" || msg.msg === "close_stream") break outer;
  }
}

// The completed frame carries the whole project + absolute server paths; keep it, but shrink the
// project to what the mock needs so the fixture stays reviewable in a diff.
const done = frames.find((f) => f.msg.msg === "process_completed");
if (done?.msg.output?.data) {
  const d = done.msg.output.data;
  await writeFile(resolve(HERE, "../test/fixtures/last_run_output.json"), JSON.stringify(d, null, 2));
  log("outputs:", d.length, "| [0] keys:", Object.keys(d[0] || {}).join(","), "| [3] tracks:", d[3]?.tracks?.length);
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
log(`wrote ${frames.length} frames -> ${OUT}`);
