/**
 * The separation engines that can run in a browser.
 *
 * One table, imported by both the worker (which needs the URLs) and the UI (which needs
 * the sizes, the speeds and the honest trade-offs). Every cost below was MEASURED on the
 * dev machine (Apple M1, 8 GB) by `web/scripts/local_bench.mjs` against a 4-minute track,
 * because the run screen quotes them to someone before they commit to a wait.
 *
 * **They are END-TO-END costs — decode, separate, transcribe every stem, assemble — not
 * separation alone.** That distinction is not pedantic. Measured on a 4-minute track with
 * the default engine: separation was 58 s (0.24x) but transcribing four stems was another
 * 112 s (0.47x), so a table built from separation alone would have promised about a minute
 * and delivered three. Transcription is now the larger half of a local run, because there
 * are four stems to transcribe instead of two.
 *
 * The download is deliberately NOT in these numbers: it happens once per device, and the
 * picker says "79 MB to fetch first" or "already downloaded" instead of hiding it in an
 * average. Hugging Face served that 79 MB at about a quarter of a megabyte a second on the
 * machine this was written on, so folding it in would make every later run look terrible.
 *
 * Why these three and not others, recorded so the next person does not re-derive it:
 *
 * - **Spleeter 4stems** is the default. Four independent 19.7 MB U-Nets that take
 *   magnitudes and return magnitudes, so the STFT, the soft ratio mask and the iSTFT are
 *   ours (`spleeter.ts`). Its masks sum to 1 by construction, so the stems reconstruct the
 *   mix to −165 dB — the "Original lanes play the song back" invariant, for free. It is
 *   faster than realtime even on single-threaded WASM, which is why the browser path no
 *   longer needs cross-origin isolation to be usable.
 * - **UVR-MDX-NET-Voc_FT** stays because it is a better *vocal* isolator than Spleeter and
 *   it is what audiosaw has run in production for a long time. Two stems only.
 * - **htdemucs** is the quality ceiling and the closest thing to what the Space produces
 *   (correlation 0.91-0.99 against real Space output), but it costs ~18x realtime on an
 *   M1 — a 3:30 song is over an hour. Offered, never defaulted.
 *
 * ⚠️ Do not reach for `StemSplitio/htdemucs-onnx` or `-6s-onnx`. They are valid ONNX and
 * they load in full onnxruntime, but their traced export is 24,917 nodes (11,684 Constant,
 * 2,968 Shape, 2,090 Slice) for ~90 real convolutions, and onnxruntime-web aborts inside
 * the wasm heap initialising them — on the WASM EP as well as WebGPU, at every
 * optimization level. `timcsy`'s export of the same network is 1,524 nodes and loads in
 * 7 s. There is no working 6-stem export at all, from anyone.
 */

/** Wall-clock seconds of work per second of audio, per device class. */
export interface EngineCost {
  gpu: number;
  threads: number;
  slow: number;
}

export interface LocalEngineSpec {
  id: LocalEngine;
  /** Short name for the picker. */
  label: string;
  /**
   * What goes in `project.json` as `separation.chain[].model`. The server writes real
   * checkpoint names there, so this should name the model, not the UI card.
   */
  modelName: string;
  /** Stem ids, in the order the model emits them. */
  stems: string[];
  /** Total download, MB, rounded for display. */
  downloadMb: number;
  cost: EngineCost;
  /** One line under the label: what you get. */
  summary: string;
  pros: string[];
  cons: string[];
}

export type LocalEngine = "spleeter4" | "mdx2" | "htdemucs4";

export const DEFAULT_ENGINE: LocalEngine = "spleeter4";

/**
 * Spleeter 4stems, Apache-2.0. Four separate U-Nets; all four must run because the ratio
 * mask denominator needs every stem.
 */
export const SPLEETER_BASE =
  "https://huggingface.co/Best-Practice/spleeter-4stems-onnx/resolve/main/";
export const SPLEETER_STEMS = ["vocals", "drums", "bass", "other"] as const;

export const MDX_URL =
  "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Voc_FT.onnx";

/** timcsy/demucs-web-onnx, MIT. STFT and iSTFT live outside the graph. */
export const HTDEMUCS_URL =
  "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";
export const HTDEMUCS_STEMS = ["drums", "bass", "other", "vocals"] as const;

export const ENGINES: Record<LocalEngine, LocalEngineSpec> = {
  spleeter4: {
    id: "spleeter4",
    label: "Four stems",
    modelName: "spleeter-4stems (onnx, fp16)",
    stems: [...SPLEETER_STEMS],
    downloadMb: 79,
    // Measured end to end on a 4-minute track: 0.71 on WebGPU (0.24 separating + 0.47
    // transcribing). Separation alone on one CPU core measured 0.66, and transcription does
    // not change with the GPU, so the slow path is 0.66 + 0.47. `threads` is interpolated
    // between the two and is the one number here not measured.
    cost: { gpu: 0.71, threads: 0.9, slow: 1.15 },
    summary: "Vocals, drums, bass and everything else.",
    pros: [
      "Four separate parts to play with, not two",
      "Quicker than the song is long on a graphics card, about the same without",
      "The smallest download of the four-stem options",
    ],
    cons: ["Separation is a little rougher than the server's"],
  },
  mdx2: {
    id: "mdx2",
    label: "Two stems, cleaner vocal",
    modelName: "UVR-MDX-NET-Voc_FT",
    stems: ["vocals", "instrumental"],
    downloadMb: 64,
    // Separation measured at 1.1 / 10 / 31; two stems to transcribe adds about 0.24.
    cost: { gpu: 1.35, threads: 10.25, slow: 31.25 },
    summary: "Just the vocal and the backing track, split more cleanly.",
    pros: [
      "The cleanest vocal of any option here",
      "The instrumental is exactly the mix minus the vocal",
    ],
    cons: [
      "Two parts only — no separate drums or bass",
      "Very slow without a graphics card",
    ],
  },
  htdemucs4: {
    id: "htdemucs4",
    label: "Four stems, best quality",
    modelName: "htdemucs (onnx, timcsy)",
    stems: [...HTDEMUCS_STEMS],
    downloadMb: 180,
    // Separation measured at ~18 on WebGPU; the CPU numbers are extrapolated, and nobody
    // should be running this one on a CPU anyway.
    cost: { gpu: 18.5, threads: 40, slow: 90 },
    summary: "The same model the server uses, run on your machine.",
    pros: [
      "As good as the server's separation",
      "Still never uploads your audio",
    ],
    cons: [
      "Far slower than the others — minutes per minute of audio",
      "The largest download",
      "Really only worth it for short clips",
    ],
  },
};

export const ENGINE_IDS = Object.keys(ENGINES) as LocalEngine[];

export function engineSpec(id: LocalEngine): LocalEngineSpec {
  return ENGINES[id] ?? ENGINES[DEFAULT_ENGINE];
}

/** Every file an engine needs. One entry for most; Spleeter is a bag of four. */
export function modelUrls(id: LocalEngine): string[] {
  if (id === "spleeter4") return SPLEETER_STEMS.map((s) => `${SPLEETER_BASE}${s}.fp16.onnx`);
  if (id === "mdx2") return [MDX_URL];
  return [HTDEMUCS_URL];
}

/** The Cache the worker keeps models in; shared so the UI can ask what is already here. */
export const MODEL_CACHE = "stemflipper-models-v1";

/**
 * Has this device already downloaded this engine?
 *
 * Worth asking before quoting a wait. The download is once per device but it is not quick —
 * Hugging Face served the 79 MB bag at about a quarter of a megabyte a second on the machine
 * this was written on, which is minutes, and an estimate that ignores it is a promise the
 * first visit cannot keep.
 */
export async function isEngineCached(id: LocalEngine): Promise<boolean> {
  try {
    const cache = await caches.open(MODEL_CACHE);
    for (const u of modelUrls(id)) if (!(await cache.match(u))) return false;
    return true;
  } catch {
    return false; // private browsing, or no Cache API
  }
}
