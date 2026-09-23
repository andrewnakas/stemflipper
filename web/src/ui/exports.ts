/** Saving what is in the browser: the rendered mix, and an edited bundle. */

import { buildExportZip } from "../export/bundle";
import { encodeWav } from "../export/wav";
import { bufferRms, renderMix } from "../engine/render";
import { formatTime } from "../model/grid";
import { assetSource, busy, mixer, notesByTrack, project, status } from "../model/store";
import { toast } from "./components/Toast";

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadMix(): Promise<void> {
  const p = project.value;
  const src = assetSource.value;
  const m = mixer.value;
  if (!p || !src || !m) return;
  busy.value = true;
  status.value = { text: "Rendering the mix…" };
  try {
    const buf = await renderMix(p, src, m, notesByTrack.value);
    save(encodeWav(buf, 16), "stemflipper-mix.wav");
    status.value = { text: `Rendered ${formatTime(buf.duration)} (RMS ${bufferRms(buf).toFixed(3)}).` };
  } catch (e) {
    status.value = { text: `Render failed: ${(e as Error).message}`, error: true };
    toast(`Render failed: ${(e as Error).message}`, { tone: "error" });
  } finally {
    busy.value = false;
  }
}

export async function downloadBundle(opts: { stems?: boolean } = {}): Promise<void> {
  const p = project.value;
  const src = assetSource.value;
  const m = mixer.value;
  if (!p || !src || !m) return;
  busy.value = true;
  try {
    const blob = await buildExportZip(p, src, m, notesByTrack.value, {
      midi: true,
      mix: true,
      stems: Boolean(opts.stems),
      onProgress: (text) => (status.value = { text }),
    });
    save(blob, "stemflipper-export.zip");
    status.value = { text: `Exported ${(blob.size / 1e6).toFixed(1)} MB.` };
  } catch (e) {
    status.value = { text: `Export failed: ${(e as Error).message}`, error: true };
    toast(`Export failed: ${(e as Error).message}`, { tone: "error" });
  } finally {
    busy.value = false;
  }
}
