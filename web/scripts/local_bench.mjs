/**
 * Measure what the run screen promises.
 *
 * `local/engines.ts` quotes a `costPerSecond` per engine, and `localEstimateSeconds` turns
 * it into the wait a visitor is shown BEFORE they commit. So the number has to be the whole
 * local run — decode, separate, transcribe every stem, assemble — not just separation, or
 * the estimate flatters itself. This drives the real built app through the real UI and
 * divides wall clock by audio length.
 *
 * Usage:
 *   npx vite preview --port 4173 --strictPort
 *   node scripts/local_bench.mjs --clip path/to/song.mp3 [--engine spleeter4] [--all]
 *
 * Paste the table it prints into HANDOFF.md, and make `engines.ts` agree with it.
 */
import { existsSync } from "node:fs";
import puppeteer from "puppeteer";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = (flag("base", "http://localhost:4173/stemflipper/")).replace(/\/+$/, "");
const CLIP = flag("clip");
const ENGINES = argv.includes("--all")
  ? ["spleeter4", "mdx2", "htdemucs4"]
  : [flag("engine", "spleeter4")];
const LABELS = { spleeter4: "Four stems", mdx2: "Two stems", htdemucs4: "best quality" };

if (!CLIP || !existsSync(CLIP)) {
  console.error("need --clip <audio file> (an mp3 under 40 MB: the app's own upload limit)");
  process.exit(2);
}

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
    // Models are cached per profile, so a second run does not re-download 79-180 MB.
    userDataDir: process.env.BENCH_PROFILE || "/tmp/claude-501/stemflipper-bench-profile",
    protocolTimeout: 3_600_000,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  };
}

const rows = [];
const browser = await puppeteer.launch(launchArgs());

for (const engine of ENGINES) {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.waitForFunction("window.__sf && window.__sf.ready === true", { timeout: 30_000 });
    const cap = await page.evaluate(() => ({ gpu: !!navigator.gpu, isolated: self.crossOriginIsolated }));

    const input = await page.$('input[type="file"]');
    await input.uploadFile(CLIP);
    await page.waitForFunction("window.__sf.job.kind === 'picked'", { timeout: 30_000 });
    await page.evaluate(() => {
      [...document.querySelectorAll(".where__opt")].find((o) => /In your browser/.test(o.textContent))?.click();
    });
    const ok = await page.evaluate((want, labels) => {
      const btn = [...document.querySelectorAll(".engine")].find((e) =>
        new RegExp(labels[want], "i").test(e.textContent),
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, engine, LABELS);
    if (!ok) throw new Error(`engine ${engine} not offered`);

    const shown = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".engine--on .nowrap")][0];
      return el ? el.textContent.trim() : null;
    });
    const duration = await page.evaluate(() => window.__sf.job.file?.durationS ?? null);

    const t0 = Date.now();
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => /Flip it/.test(b.textContent))?.click();
    });
    await page.waitForFunction("['ready','error'].includes(window.__sf.job.kind)", {
      timeout: 3_600_000,
      polling: 1000,
    });
    const wall = (Date.now() - t0) / 1000;
    const out = await page.evaluate(() => ({
      kind: window.__sf.job.kind,
      error: window.__sf.job.error?.message,
      device: window.__sf.state.project?.separation?.device,
      residual: window.__sf.state.project?.separation?.residual_db ?? null,
      tracks: (window.__sf.state.project?.tracks || []).length,
    }));

    rows.push({
      engine,
      device: out.device ?? (cap.gpu ? "webgpu?" : "wasm?"),
      isolated: cap.isolated,
      audioS: duration,
      wallS: Math.round(wall),
      costPerSecond: duration ? Number((wall / duration).toFixed(2)) : null,
      stems: out.tracks,
      residualDb: out.residual,
      predicted: shown,
      status: out.kind === "ready" ? "ok" : `FAILED: ${out.error}`,
    });
  } catch (e) {
    rows.push({ engine, status: `FAILED: ${e.message}` });
  }
  await page.close();
}
await browser.close();

console.log("\nMeasured end to end (decode + separate + transcribe + assemble):\n");
console.log(
  ["engine", "device", "audio s", "wall s", "cost/s", "stems", "residual dB", "UI said", "status"]
    .map((h) => h.padEnd(12))
    .join(""),
);
for (const r of rows) {
  console.log(
    [r.engine, r.device ?? "-", r.audioS ?? "-", r.wallS ?? "-", r.costPerSecond ?? "-",
     r.stems ?? "-", r.residualDb ?? "-", r.predicted ?? "-", r.status]
      .map((c) => String(c).padEnd(12))
      .join(""),
  );
}
console.log("\nIf cost/s disagrees with engines.ts, engines.ts is wrong — it is quoted to people.");
