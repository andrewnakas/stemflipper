/**
 * Headless smoke test.
 *
 * Scenarios (--scenario, default "fixture"):
 *   fixture  load a bundle, play it, edit a note, export — the deep checks
 *   demo     the front door: landing -> Hear an example -> Listen -> Studio
 *   upload   drop a file and watch a whole run against scripts/mock_backend.mjs
 *   quota    the run fails on a ZeroGPU seconds limit and offers a cheaper preset
 *   runs     the run fails on a ZeroGPU *runs* limit and offers a token instead
 *   keep     keep a song in the browser, reload, reopen it and hear it
 *   local    the whole pipeline in the browser — opt-in: it downloads a 64 MB model and
 *            takes ~1x realtime with WebGPU but ~31x without, so CI does not run it
 *
 * The upload and quota scenarios need the mock backend running:
 *   node scripts/mock_backend.mjs --port 7861 [--mode quota]
 *
 * Usage: node scripts/web_smoke.mjs [baseUrl] [--scenario name] [--backend url]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import puppeteer from "puppeteer";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const BASE = (argv[0] && !argv[0].startsWith("--") ? argv[0] : "http://localhost:4173/stemflipper/").replace(/\/+$/, "");
const SCENARIO = flag("scenario", process.env.SMOKE_SCENARIO || "fixture");
const MOCK = flag("backend", process.env.MOCK_BACKEND || "http://localhost:7861");
const FIXTURE = flag("fixture", process.env.SMOKE_FIXTURE || "ci");
/**
 * The file the upload scenario drops on the page.
 *
 * Synthesised rather than committed: tests/assets is gitignored, so depending on it made
 * this scenario pass locally and fail in CI. A real WAV header matters — the app reads
 * the duration in the browser before uploading anything.
 */
function sampleWav(seconds = 3, sampleRate = 44100) {
  const frames = seconds * sampleRate;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 12000), 44 + i * 2);
  }
  const dir = join(tmpdir(), "stemflipper-smoke");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sample.wav");
  writeFileSync(path, buf);
  return path;
}

const SAMPLE = sampleWav();

const problems = [];
const note = (...m) => console.log(" ", ...m);
let browser;

function launchArgs() {
  const systemChrome = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ].find((p) => existsSync(p));
  return {
    executablePath: process.env.CHROME_PATH || systemChrome || undefined,
    headless: "new",
    args: [
      "--no-sandbox",
      // NOTE: this masks the "AudioContext.resume() never settles without a gesture"
      // class of bug, so anything that awaits audio unlock must also be exercised by a
      // real click somewhere in these scenarios.
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
    ],
  };
}

function watch(page) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    // Reading a file's duration means pointing an <audio> at a blob: URL and then
    // aborting it once the metadata arrives — downloading 40 MB into an audio element to
    // learn its length would be absurd. That abort is expected, not a defect.
    const aborted = req.failure()?.errorText === "net::ERR_ABORTED";
    if (aborted && req.url().startsWith("blob:")) return;
    problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()} ${res.url()}`);
  });
}

/** ---------------------------------------------------------------- scenarios */

async function scenarioFixture(page) {
  await page.goto(`${BASE}/?fixture=${FIXTURE}`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 60_000 });

  const state = await page.evaluate(() => {
    const s = window.__sf.state;
    return {
      route: window.__sf.route,
      hasProject: !!s.project,
      schema: s.project?.schema_version,
      tracks: (s.project?.tracks || []).map((t) => ({
        id: t.id,
        notes: (s.notes[t.id] || []).length,
        engine: t.transcription.engine,
        sampler: !!t.instrument.sampler,
      })),
      tempo: s.project?.grid?.tempo,
      duration: s.project?.song?.duration,
    };
  });
  note(`project: schema ${state.schema}, tempo ${state.tempo}, ${state.duration}s, route ${state.route}`);
  for (const t of state.tracks) {
    note(`  ${t.id.padEnd(8)} notes=${String(t.notes).padStart(4)} engine=${t.engine} sampler=${t.sampler}`);
  }
  if (!state.hasProject) problems.push("no project loaded");
  if (state.schema !== 2) problems.push(`unexpected schema_version ${state.schema}`);
  if (state.route !== "listen") problems.push(`a loaded bundle should land on Listen, not ${state.route}`);

  const waves = await page.$$eval("canvas.waveform", (els) => els.length);
  note(`listen: ${waves} waveforms`);
  if (waves < 1) problems.push("no waveforms on the listen screen");

  // Into the editor.
  await page.evaluate(() => window.__sf.navigate("studio"));
  await page.waitForSelector(".tracklanes canvas", { timeout: 10_000 });
  const rolls = await page.$$eval(".tracklanes canvas", (els) => els.length);
  note(`studio: ${rolls} piano rolls`);
  if (rolls < 1) problems.push("piano rolls did not render");

  // load() resolves as soon as the stems can play; the synth patches and sampler zones
  // arrive afterwards, so wait for them before asking those lanes to make a sound.
  await page.evaluate(() => window.__sf.waitForInstruments());

  for (const lane of ["original", "synth", "sampler"]) {
    const result = await page.evaluate(async (laneId) => {
      const ids = window.__sf.state.project.tracks.map((t) => t.id);
      for (const id of ids) {
        for (const other of ["original", "synth", "sampler"]) {
          window.__sf.setLane(id, other, other === laneId ? 1 : 0);
        }
      }
      return window.__sf.renderMix({ to: 4 });
    }, lane);
    note(`  lane ${lane.padEnd(9)} rms=${result.rms.toFixed(4)} peak=${result.peak.toFixed(3)}`);
    if (!(result.rms > 0.001)) problems.push(`lane ${lane} rendered silence (rms ${result.rms})`);
    if (result.peak > 1.05) problems.push(`lane ${lane} clipped (peak ${result.peak})`);
  }

  const advanced = await page.evaluate(async () => {
    const s = window.__sf.session;
    if (!s) return null;
    await s.ctx.resume?.();
    s.transport.play(0);
    const before = s.transport.now();
    let after = before;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      after = s.transport.now();
      if (after > before + 0.05) break;
    }
    const state = s.ctx.state;
    s.transport.seek(3);
    const seeked = s.transport.now();
    s.transport.stop();
    return { before, after, state, seeked };
  });
  if (advanced) {
    note(`transport: ctx=${advanced.state} ${advanced.before.toFixed(3)} -> ${advanced.after.toFixed(3)}, seek(3) -> ${advanced.seeked.toFixed(3)}`);
    if (Math.abs(advanced.seeked - 3) > 0.2) problems.push("seek did not move the playhead");
    if (advanced.state === "running" && !(advanced.after > advanced.before)) {
      problems.push("transport clock did not advance while the context was running");
    }
  }

  const edit = await page.evaluate(async () => {
    const id = window.__sf.state.project.tracks.find((t) => t.notes.length)?.id;
    if (!id) return null;
    const moved = await window.__sf.editFirstNote(id, 0.25, 2);
    const undone = window.__sf.undo();
    const after = window.__sf.state.notes[id].find((n) => n.id === moved.id);
    return { moved, undone, restored: { start: after.start, pitch: after.pitch } };
  });
  if (edit) {
    note(
      `edit: ${edit.moved.before.pitch}@${edit.moved.before.start.toFixed(2)} -> ${edit.moved.after.pitch}@${edit.moved.after.start.toFixed(2)}, undo -> ${edit.restored.pitch}@${edit.restored.start.toFixed(2)}`,
    );
    if (edit.moved.after.pitch !== edit.moved.before.pitch + 2) problems.push("note edit did not change pitch");
    if (Math.abs(edit.moved.after.start - (edit.moved.before.start + 0.25)) > 1e-6) problems.push("note edit did not move in time");
    if (Math.abs(edit.restored.start - edit.moved.before.start) > 1e-6) problems.push("undo did not restore the note's time");
    if (!edit.undone) problems.push("undo reported nothing to undo");
    if (edit.restored.pitch !== edit.moved.before.pitch) problems.push("undo did not restore the note");
  }

  const exported = await page.evaluate(async () => {
    const zip = await window.__sf.exportZip();
    const midi = await window.__sf.exportMidiBytes();
    return { zip, midiLength: midi.length, midiHead: midi.slice(0, 4) };
  });
  note(`export: zip ${exported.zip.size} bytes, midi ${exported.midiLength} bytes`);
  if (!(exported.zip.size > 200)) problems.push("export zip is empty");
  if (exported.zip.bytes[0] !== 0x50 || exported.zip.bytes[1] !== 0x4b) problems.push("export is not a zip (bad magic)");
  if (String.fromCharCode(...exported.midiHead) !== "MThd") problems.push("exported MIDI has a bad header");
  const { parseMidi } = await import("midi-file");
  const parsed = parseMidi(Uint8Array.from(await page.evaluate(() => window.__sf.exportMidiBytes())));
  const noteOns = parsed.tracks.flat().filter((e) => e.type === "noteOn").length;
  note(`  midi: format ${parsed.header.format}, ${parsed.tracks.length} tracks, ${noteOns} notes`);
  if (noteOns < 10) problems.push(`exported MIDI has too few notes (${noteOns})`);
}

async function scenarioDemo(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 30_000 });

  const heading = await page.$eval("h1", (el) => el.textContent.trim());
  note(`landing: "${heading}"`);
  if (!/stems/i.test(heading)) problems.push("landing heading does not mention stems");
  if (!(await page.$(".dropzone"))) problems.push("no drop zone on the landing page");

  // A real click, not a scripted navigation: this is also what unlocks audio.
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /hear an example/i.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) {
    problems.push('no "Hear an example" button');
    return;
  }
  await page.waitForSelector(".stemrow", { timeout: 30_000 });
  const listen = await page.evaluate(() => ({
    route: window.__sf.route,
    stems: document.querySelectorAll(".stemrow").length,
    downloads: document.querySelectorAll(".disclosure").length,
    ctx: window.__sf.session?.ctx?.state,
  }));

  // A bundle with no server behind it must still be downloadable in one piece, and the
  // zip has to contain the samples the instrument files name, not just what project.json
  // lists.
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Everything")?.click();
  });
  await page.waitForFunction(() => /Save the zip/.test(document.body.textContent), { timeout: 180_000 });
  const zipped = await page.evaluate(async () => {
    const a = [...document.querySelectorAll("a.btn")].find((x) => /Save the zip/.test(x.textContent));
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { error: "no central directory" };
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const names = [];
    for (let i = 0; i < count; i++) {
      const n = dv.getUint16(off + 28, true);
      names.push(new TextDecoder().decode(buf.subarray(off + 46, off + 46 + n)));
      off += 46 + n + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
    }
    return { bytes: buf.length, magic: String.fromCharCode(buf[0], buf[1]), names, label: a.textContent.trim() };
  });
  note(`zip: ${zipped.bytes} bytes, ${zipped.names?.length} entries — ${zipped.label}`);
  if (zipped.error) problems.push(`built zip is malformed: ${zipped.error}`);
  if (zipped.magic !== "PK") problems.push("built zip has no PK header");
  if (!zipped.names?.includes("project.json")) problems.push("built zip has no project.json");
  if (!zipped.names?.some((n) => /instruments\/.*\/samples\//.test(n))) {
    problems.push("built zip is missing the samples the instrument files name");
  }
  note(`listen: route=${listen.route} stems=${listen.stems} downloadGroups=${listen.downloads} audioCtx=${listen.ctx}`);
  if (listen.route !== "listen") problems.push(`expected the listen route, got ${listen.route}`);
  if (listen.stems < 1) problems.push("no stems rendered");
  if (listen.downloads < 1) problems.push("no downloads offered");

  const played = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll(".transport button")][0];
    btn.click();
    await new Promise((r) => setTimeout(r, 700));
    const t = window.__sf.session.transport.now();
    window.__sf.session.transport.stop();
    return { t, state: window.__sf.session.ctx.state };
  });
  note(`play: clock ${played.t.toFixed(2)}s, ctx ${played.state}`);
  if (played.state === "running" && !(played.t > 0)) problems.push("pressing play did not advance the clock");

  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => /open in studio/i.test(b.textContent))?.click();
  });
  await page.waitForSelector(".studiobar", { timeout: 10_000 });
  const studio = await page.evaluate(() => ({
    route: window.__sf.route,
    scheme: document.documentElement.getAttribute("data-scheme"),
    rolls: document.querySelectorAll(".tracklanes canvas").length,
  }));
  note(`studio: route=${studio.route} scheme=${studio.scheme} rolls=${studio.rolls}`);
  if (studio.route !== "studio") problems.push("Open in Studio did not switch screens");
  if (studio.scheme !== "studio") problems.push("Studio did not apply its colour scheme");
  if (studio.rolls < 1) problems.push("Studio rendered no piano rolls");
}

async function runUpload(page, { expectError } = {}) {
  await page.goto(`${BASE}/?backend=${encodeURIComponent(MOCK)}`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 30_000 });

  const input = await page.$('input[type="file"]');
  if (!input) {
    problems.push("no file input on the landing page");
    return null;
  }
  await input.uploadFile(SAMPLE);
  await page.waitForSelector(".btn--primary", { timeout: 15_000 });
  await page.waitForFunction("window.__sf.job.kind === 'picked'", { timeout: 15_000 });

  // Pick the server explicitly. The default depends on whether this machine has a GPU,
  // so without this the scenario would quietly run locally on some runners.
  const where = await page.evaluate(() => {
    const opts = [...document.querySelectorAll(".where__opt")];
    const server = opts.find((o) => /On the server/.test(o.textContent));
    if (server) server.click();
    return { count: opts.length, chose: !!server };
  });
  if (where.count !== 2) problems.push(`expected two places to run, saw ${where.count}`);
  if (!where.chose) problems.push("no server option to choose");

  const picked = await page.evaluate(() => ({ route: window.__sf.route, job: window.__sf.job }));
  note(`picked: route=${picked.route} ${picked.job.file.name} ${picked.job.file.durationS?.toFixed?.(1)}s`);
  if (picked.route !== "run") problems.push(`choosing a file should go to the run screen, got ${picked.route}`);
  if (!picked.job.file.durationS) problems.push("preflight did not read the duration in the browser");

  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Flip it")?.click();
  });

  await page.waitForFunction(
    "['ready','error'].includes(window.__sf.job.kind)",
    { timeout: 90_000, polling: 100 },
  );
  const final = await page.evaluate(() => ({ job: window.__sf.job, log: window.__sf.jobLog, route: window.__sf.route }));
  note(`phases: ${final.log.join(" -> ")}`);
  if (!expectError) {
    for (const want of ["uploading", "running", "ready"]) {
      if (!final.log.includes(want)) problems.push(`the run never reported "${want}" (saw ${final.log.join(",")})`);
    }
  }
  return final;
}

async function scenarioUpload(page) {
  const final = await runUpload(page);
  if (!final) return;
  if (final.job.kind !== "ready") {
    problems.push(`upload ended as ${final.job.kind}: ${final.job.error?.message}`);
    return;
  }
  await page.waitForSelector(".stemrow", { timeout: 15_000 });
  const listen = await page.evaluate(() => ({
    route: window.__sf.route,
    stems: document.querySelectorAll(".stemrow").length,
    zip: !!window.__sf.job.result.zipUrl,
    bytes: window.__sf.job.result.zipBytes,
    bigButton: [...document.querySelectorAll("a.btn")].some((a) => /Everything/.test(a.textContent)),
  }));
  note(`result: route=${listen.route} stems=${listen.stems} zip=${listen.zip} (${listen.bytes} bytes) button=${listen.bigButton}`);
  if (listen.route !== "listen") problems.push("a finished run should land on Listen");
  if (!listen.zip) problems.push("the bundle zip URL was dropped (this is the v2 bug)");
  if (!listen.bigButton) problems.push('no "Everything" download button');

  // Reloading used to lose a finished run entirely, even though the bundle sits on the
  // server for six hours. It should be offered back.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 30_000 });
  const offered = await page.evaluate(() =>
    [...document.querySelectorAll(".card--quiet")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  );
  note(`after reload: ${offered.join(" | ") || "(nothing offered)"}`);
  if (!offered.some((t) => /still on the server/i.test(t))) {
    problems.push("a finished run was not offered again after a reload");
    return;
  }
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open")?.click();
  });
  await page.waitForSelector(".stemrow", { timeout: 30_000 });
  const reopened = await page.evaluate(() => ({ route: window.__sf.route, stems: document.querySelectorAll(".stemrow").length }));
  note(`reopened from the server: ${reopened.stems} stems`);
  if (reopened.route !== "listen" || !reopened.stems) problems.push("reopening a server run after a reload failed");
}

async function scenarioRuns(page) {
  const final = await runUpload(page, { expectError: true });
  if (!final) return;
  const e = final.job.error;
  note(`error: code=${e?.code} recovery=${(e?.recovery || []).join(",")}`);
  if (e?.code !== "quota_runs") {
    problems.push(`a runs limit was classified as "${e?.code}"`);
    return;
  }
  // A cheaper preset cannot buy more runs, so offering it would be useless advice.
  if (e.recovery.includes("use_fast")) problems.push("a runs limit should not suggest a cheaper preset");
  if (!e.recovery.includes("paste_token")) problems.push("a runs limit should offer a token");

  const panel = await page.evaluate(() => ({
    title: document.querySelector(".notice__title")?.textContent || "",
    actions: [...document.querySelectorAll(".notice__actions button, .notice__actions a")].map((b) => b.textContent.trim()),
    tokenFieldPresent: !!document.querySelector('input[type="password"]'),
  }));
  note(`panel: "${panel.title}" | ${panel.actions.join(" | ")}`);
  if (/GPU time/i.test(panel.title)) problems.push("a runs limit is described as running out of time");
  if (!panel.tokenFieldPresent) problems.push("the token field is not on the screen that recommends it");

  // The recommended fix must actually be reachable from the panel.
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => /hugging face token/i.test(b.textContent))?.click();
  });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("type") === "password",
    { timeout: 5000 },
  ).catch(() => problems.push("the token button did not open and focus the field"));
}

async function scenarioQuota(page) {
  const final = await runUpload(page, { expectError: true });
  if (!final) return;
  if (final.job.kind !== "error") {
    problems.push(`expected a quota failure, got ${final.job.kind}`);
    return;
  }
  const e = final.job.error;
  note(`error: code=${e.code} left=${e.leftS} requested=${e.requestedS} retryAfter=${e.retryAfterS}`);
  if (e.code !== "quota") problems.push(`quota refusal classified as "${e.code}"`);
  if (e.leftS !== 59 || e.requestedS !== 60) problems.push("quota numbers were not parsed out of the message");
  if (!e.retryAfterS) problems.push("no retry time parsed");

  const panel = await page.evaluate(() => {
    const el = document.querySelector(".notice--error");
    return {
      text: el?.textContent || "",
      actions: [...(el?.querySelectorAll(".notice__actions button, .notice__actions a") || [])].map((b) => b.textContent.trim()),
    };
  });
  note(`panel actions: ${panel.actions.join(" | ")}`);
  if (!/GPU time/i.test(panel.text)) problems.push("the error panel does not explain the quota");
  if (!panel.actions.some((a) => /Fast/i.test(a))) problems.push("no way to retry on a cheaper preset");
  if (/Traceback|Error:/.test(panel.text)) problems.push("the error panel is showing a raw error");
}

async function scenarioKeep(page) {
  await page.goto(`${BASE}/?fixture=${FIXTURE}`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForSelector(".stemrow", { timeout: 30_000 });

  const before = await page.evaluate(() => window.__sf.renderMix({ to: 2 }));

  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => /keep in this browser/i.test(b.textContent))?.click();
  });
  await page.waitForFunction(() => /Kept in this browser/.test(document.body.textContent), { timeout: 60_000 });
  note("kept");

  // A real reload: nothing in memory survives, so what comes back came from IndexedDB.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 30_000 });
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll(".card--quiet")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  );
  note(`after reload: ${listed.join(" | ") || "(nothing listed)"}`);
  if (!listed.length) {
    problems.push("a kept song did not survive a reload");
    return;
  }

  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open")?.click();
  });
  await page.waitForSelector(".stemrow", { timeout: 30_000 });
  await page.evaluate(() => window.__sf.waitForInstruments());

  const state = await page.evaluate(() => ({
    kind: window.__sf.state.source?.kind,
    stems: document.querySelectorAll(".stemrow").length,
    backendFree: !JSON.stringify(window.__sf.state.source).includes("hf.space"),
  }));
  const after = await page.evaluate(() => window.__sf.renderMix({ to: 2 }));
  note(`reopened from ${state.kind}: ${state.stems} stems, rms ${after.rms.toFixed(4)} (was ${before.rms.toFixed(4)})`);

  if (state.kind !== "blob") problems.push(`reopened song should read from stored blobs, got "${state.kind}"`);
  if (!state.backendFree) problems.push("a kept song still points at the server");
  if (!(after.rms > 0.001)) problems.push("a kept song reopened silent");
  // Same audio in, same audio out — the stored stems are the ones it was playing.
  if (Math.abs(after.rms - before.rms) > 0.02) {
    problems.push(`kept audio differs from the original (rms ${before.rms.toFixed(4)} -> ${after.rms.toFixed(4)})`);
  }

  // The other durable copy: the bundle zip someone downloaded. Dropping it back on the
  // page must reopen the song with no server and no stored state.
  const zipPath = bundleZip(FIXTURE);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 30_000 });
  const input = await page.$('input[type="file"]');
  await input.uploadFile(zipPath);
  await page.waitForSelector(".stemrow", { timeout: 30_000 });
  const fromZip = await page.evaluate(() => ({
    route: window.__sf.route,
    kind: window.__sf.state.source?.kind,
    stems: document.querySelectorAll(".stemrow").length,
    tracks: window.__sf.state.project?.tracks?.length,
  }));
  note(`dropped bundle zip: route=${fromZip.route} source=${fromZip.kind} stems=${fromZip.stems}`);
  if (fromZip.route !== "listen") problems.push("dropping a bundle zip did not open it");
  if (fromZip.kind !== "blob") problems.push(`a dropped zip should read from blobs, got "${fromZip.kind}"`);
  if (!fromZip.stems) problems.push("a dropped zip opened with no stems");
}

/** Zip a fixture directory into a bundle, the shape the pipeline ships. */
function bundleZip(name) {
  const dir = fileURLToPath(new URL(`../public/fixtures/${name}`, import.meta.url));
  const files = {};
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full).split("\\").join("/")] = new Uint8Array(readFileSync(full));
    }
  };
  walk(dir);
  const out = join(tmpdir(), "stemflipper-smoke", `${name}-bundle.zip`);
  mkdirSync(join(tmpdir(), "stemflipper-smoke"), { recursive: true });
  writeFileSync(out, zipSync(files));
  return out;
}

/**
 * The in-browser pipeline, end to end. Opt-in: it fetches a 64 MB model and runs a real
 * neural separation, which is fast on a GPU and very slow without one.
 */
async function scenarioLocal(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 30_000 });

  const cap = await page.evaluate(() => ({ gpu: !!navigator.gpu, isolated: self.crossOriginIsolated }));
  note(`device: webgpu=${cap.gpu} isolated=${cap.isolated}`);

  const input = await page.$('input[type="file"]');
  await input.uploadFile(flag("clip", SAMPLE));
  await page.waitForFunction("window.__sf.job.kind === 'picked'", { timeout: 20_000 });
  await page.evaluate(() => {
    [...document.querySelectorAll(".where__opt")].find((o) => /In your browser/.test(o.textContent))?.click();
  });

  const t0 = Date.now();
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => /Flip it/.test(b.textContent))?.click();
  });
  await page.waitForFunction("['ready','error'].includes(window.__sf.job.kind)", { timeout: 600_000, polling: 500 });

  const final = await page.evaluate(() => {
    const s = window.__sf.state;
    return {
      kind: window.__sf.job.kind,
      error: window.__sf.job.error?.message,
      route: window.__sf.route,
      sourceKind: s.source?.kind,
      device: s.project?.separation?.device,
      tracks: (s.project?.tracks || []).map((t) => `${t.id}:${(s.notes[t.id] || []).length}n`),
      stages: (s.project?.stages || []).map((x) => `${x.name}=${x.status}`),
      phases: window.__sf.jobLog,
    };
  });
  note(`${Math.round((Date.now() - t0) / 1000)}s on ${final.device}: ${final.tracks.join(" ")}`);
  note(`stages: ${final.stages.join(" ")}`);

  if (final.kind !== "ready") {
    problems.push(`local run ended as ${final.kind}: ${final.error}`);
    return;
  }
  if (final.route !== "listen") problems.push("a local run should land on Listen");
  // Nothing may have been uploaded, so the assets must be local blobs.
  if (final.sourceKind !== "blob") problems.push(`local output should be blobs, got "${final.sourceKind}"`);
  if (final.tracks.length !== 2) problems.push(`expected vocals + instrumental, got ${final.tracks.join(",")}`);
  if (!final.stages.includes("samples=skipped")) problems.push("local run should say samples were skipped");

  await page.evaluate(() => window.__sf.waitForInstruments());
  const mix = await page.evaluate(() => window.__sf.renderMix({ to: 3 }));
  note(`render rms=${mix.rms.toFixed(4)} peak=${mix.peak.toFixed(3)}`);
  if (!(mix.rms > 0.001)) problems.push("the locally separated stems render silent");

  const midi = await page.evaluate(async () => {
    const bytes = await window.__sf.exportMidiBytes();
    return { len: bytes.length, head: String.fromCharCode(...bytes.slice(0, 4)) };
  });
  note(`midi: ${midi.len} bytes, header ${midi.head}`);
  if (midi.head !== "MThd") problems.push("MIDI from a local run has a bad header");
}

/** ------------------------------------------------------------------- driver */

const SCENARIOS = {
  fixture: scenarioFixture,
  demo: scenarioDemo,
  upload: scenarioUpload,
  quota: scenarioQuota,
  runs: scenarioRuns,
  keep: scenarioKeep,
  local: scenarioLocal,
};

try {
  const run = SCENARIOS[SCENARIO];
  if (!run) throw new Error(`unknown scenario "${SCENARIO}" (have: ${Object.keys(SCENARIOS).join(", ")})`);
  console.log(`smoke: ${SCENARIO} @ ${BASE}`);
  browser = await puppeteer.launch(launchArgs());
  const page = await browser.newPage();
  watch(page);
  await run(page);
} catch (err) {
  problems.push(`fatal: ${err.message}`);
} finally {
  await browser?.close();
}

if (problems.length) {
  console.error(`\nSMOKE FAILED (${SCENARIO}):`);
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}
console.log(`\nsmoke OK (${SCENARIO})`);
