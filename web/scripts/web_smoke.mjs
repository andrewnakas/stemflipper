/**
 * Headless smoke test: load the fixture project, assert the page renders without errors,
 * and check that each lane (original / synth / sampler) actually produces audio.
 *
 * Usage: node scripts/web_smoke.mjs [baseUrl]
 * Assumes `npm run build && npm run preview` (or `npm run dev`) is serving the app.
 */

import { existsSync } from "node:fs";
import puppeteer from "puppeteer";

const BASE = process.argv[2] || "http://localhost:4173/stemflipper/";
const URL = `${BASE.replace(/\/+$/, "")}/app.html?fixture=song`;

const problems = [];
let browser;

try {
  // The puppeteer-managed Chrome download is unreliable here (it lands without its
  // framework bundle), so prefer a system Chrome when one is installed.
  const systemChrome = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ].find((p) => existsSync(p));

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || systemChrome || undefined,
    headless: "new",
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      // a deterministic silent device so OfflineAudioContext renders in CI too
      "--use-fake-device-for-media-stream",
    ],
  });
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()} ${res.url()}`);
  });

  await page.goto(URL, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 60_000 });

  const state = await page.evaluate(() => {
    const s = window.__sf.state;
    return {
      hasProject: !!s.project,
      schema: s.project?.schema_version,
      tracks: (s.project?.tracks || []).map((t) => ({
        id: t.id,
        notes: (s.notes[t.id] || []).length,
        engine: t.transcription.engine,
        sampler: !!t.instrument.sampler,
        audio: t.audio.src,
      })),
      tempo: s.project?.grid?.tempo,
      duration: s.project?.song?.duration,
    };
  });

  console.log(`project: schema ${state.schema}, tempo ${state.tempo}, ${state.duration}s`);
  for (const t of state.tracks) {
    console.log(`  ${t.id.padEnd(8)} notes=${String(t.notes).padStart(4)} engine=${t.engine} sampler=${t.sampler}`);
  }
  if (!state.hasProject) problems.push("no project loaded");
  if (state.schema !== 2) problems.push(`unexpected schema_version ${state.schema}`);

  const canvases = await page.$$eval("canvas", (els) => els.length);
  console.log(`canvases rendered: ${canvases}`);
  if (canvases < 2) problems.push("piano rolls did not render");

  // Each lane must actually make sound.
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
    console.log(`  lane ${lane.padEnd(9)} rms=${result.rms.toFixed(4)} peak=${result.peak.toFixed(3)}`);
    if (!(result.rms > 0.001)) problems.push(`lane ${lane} rendered silence (rms ${result.rms})`);
    if (result.peak > 1.05) problems.push(`lane ${lane} clipped (peak ${result.peak})`);
  }

  // Transport: play advances the clock.
  const advanced = await page.evaluate(async () => {
    const s = window.__sf.session;
    if (!s) return null;
    await s.ctx.resume?.();
    s.transport.play(0);
    const before = s.transport.now();
    await new Promise((r) => setTimeout(r, 500));
    const after = s.transport.now();
    const state = s.ctx.state;
    s.transport.seek(3);
    const seeked = s.transport.now();
    s.transport.stop();
    return { before, after, state, seeked, playing: false };
  });
  if (advanced) {
    console.log(
      `transport: ctx=${advanced.state} ${advanced.before.toFixed(3)} -> ${advanced.after.toFixed(3)}, seek(3) -> ${advanced.seeked.toFixed(3)}`,
    );
    if (Math.abs(advanced.seeked - 3) > 0.2) problems.push("seek did not move the playhead");
    if (advanced.state === "running" && !(advanced.after > advanced.before)) {
      problems.push("transport clock did not advance while the context was running");
    }
  }
} catch (err) {
  problems.push(`fatal: ${err.message}`);
} finally {
  await browser?.close();
}

if (problems.length) {
  console.error("\nSMOKE FAILED:");
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}
console.log("\nsmoke OK");
