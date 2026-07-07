# StemFlipper on Hugging Face Spaces — Deployment Research & Architecture Report

**Date:** 2026-07-06
**Pipeline:** upload song → source separation (Demucs) → audio-to-MIDI (basic-pitch) → synth/effect reconstruction → downloadable DAW project.
**Constraint:** MVP must LIVE on Hugging Face Spaces.

> Note on figures: HF publishes exact prices/quotas on live pages. Where two sources disagreed (e.g., PRO daily quota, ZeroGPU GPU model), I flag it inline. Verify the two live numbers marked ⚠️ before committing budget: current PRO ZeroGPU daily quota and ZeroGPU GPU model/VRAM.

---

## 1. HF Spaces Hardware Tiers & Pricing (Dec 2025 / 2026)

Billed **per minute**, only while the Space is in **Starting** or **Running** state. Paused Spaces cost nothing. Free hardware auto-sleeps after 48h inactivity; paid tiers run until a configurable sleep timer fires.

### CPU
| Hardware | vCPU | RAM | Disk | $/hr |
|---|---|---|---|---|
| **CPU Basic** (free) | 2 | 16 GB | 50 GB ephemeral | **Free** |
| CPU Upgrade | 8 | 32 GB | 50 GB | $0.03 |

### GPU (dedicated, always-on billing)
| Hardware | vCPU | RAM | VRAM | $/hr |
|---|---|---|---|---|
| **T4 Small** | 4 | 15 GB | 16 GB | **$0.40** |
| T4 Medium | 8 | 30 GB | 16 GB | $0.60 |
| 1× L4 | 8 | 30 GB | 24 GB | $0.80 |
| 1× L40S | 8 | 62 GB | 48 GB | $1.80 |
| **A10G Small** | 4 | 15 GB | 24 GB | **$1.00** |
| A10G Large | 12 | 46 GB | 24 GB | $1.50 |
| **A100 Large** | 12 | 142 GB | 80 GB | **$2.50** |
| 4× A100 | 48 | 568 GB | 320 GB | $10.00 |
| 8× A100 | 96 | 1136 GB | 640 GB | $20.00 |
| 8× L40S | 192 | 1534 GB | 384 GB | $23.50 |

*H100 tier was removed Dec 2025.* Dedicated GPU bills **continuously** whether or not anyone is using it — expensive for bursty demo traffic.

### ZeroGPU (serverless, time-sliced) — **the right tier for this MVP**
- **Free** to attach to a Space; GPU is allocated **per-function-call** only while a `@spaces.GPU`-decorated function runs, then released.
- **GPU model:** ⚠️ In flux. Docs describe "Large = half GPU / 48 GB VRAM, XLarge = full / 96 GB VRAM." HF migrated ZeroGPU from **H200 (141 GB)** to **NVIDIA RTX PRO 6000 Blackwell (96 GB)** in late 2025/2026 — some Spaces lost VRAM headroom. Either way ≥48 GB is plenty for Demucs + basic-pitch.
- **Daily quota (GPU-seconds), by account:**
  - Unauthenticated visitor: ~2 min/day
  - Free account: ~5 min/day
  - **PRO account: ⚠️ 25 min/day (one 2025 source) or 40 min/day (current docs), "extensible"** — reconcile against live page.
  - Team/Enterprise: 40–60 min/day, extensible.
- **Over-quota:** PRO/Team/Enterprise can exceed quota on **pre-paid credits at ~$1 per 10 GPU-minutes** (= $6/GPU-hour effective, but you only pay for seconds actually computed).
- **XLarge consumes 2× quota** vs Large for the same wall-clock.
- **Constraint: ZeroGPU Spaces are Gradio-SDK only** (no Docker/Streamlit). Requires **Python 3.10.13 or 3.12.12**, **PyTorch 2.8.0+**, **Gradio 4+**.

**What runs free vs paid:**
- **Free path:** CPU-Basic Space + ZeroGPU for the Demucs call (free account = ~5 GPU-min/day — enough for a handful of demo separations). basic-pitch runs fine on the CPU side.
- **Paid, still cheap:** attach ZeroGPU under a **PRO account ($9/mo)** for 8× quota + queue priority + credit overflow. This is the recommended MVP spend.
- **Paid, expensive:** dedicated A10G/A100 — only if you outgrow ZeroGPU's per-call 60–120s window or need guaranteed no-cold-start latency.

---

## 2. ZeroGPU Specifics & Model Fit

### The `spaces.GPU` decorator
```python
import spaces

@spaces.GPU(duration=120)          # max wall-clock this call may hold the GPU (default 60s)
def separate(audio_path):
    # everything GPU-touching lives INSIDE this function
    ...
    return stems
```
- **Default duration = 60 s.** Set higher for slow jobs: `@spaces.GPU(duration=120)`. No hard documented ceiling, but **longer durations cost more quota and worsen queue priority** — request the smallest realistic value.
- **Dynamic duration:** pass a *callable* that receives the same args as the function and returns a duration, e.g. scale by audio length: `@spaces.GPU(duration=lambda audio: min(300, int(get_len(audio)*0.5)+30))`.
- **Effect-free off-ZeroGPU:** the decorator is a no-op on normal hardware, so the same code runs locally.

### Critical constraints / gotchas
1. **GPU functions must be self-contained.** All CUDA work (model `.to("cuda")`, inference) must happen **inside** the decorated function. Outside it, PyTorch runs in a CPU "emulation" mode — calling `.cuda()` at module import time will break.
2. **Load models at module level (CPU), move to GPU inside the function.** Recommended pattern: instantiate/download weights once at startup on CPU; inside `@spaces.GPU` do `model.to("cuda")`, infer, and let it release. Re-`.to("cuda")` each call is cheap relative to inference.
3. **`torch.compile` is unsupported.** Use PyTorch 2.8+ ahead-of-time compilation if you need it (usually unnecessary for Demucs).
4. **Cold starts:** first call after idle pays a few seconds to acquire+init the GPU. Keep weights cached locally so you don't re-download inside the window.
5. **Non-PyTorch frameworks:** PyTorch has best support. **basic-pitch is TensorFlow/CoreML/ONNX** — safest to run it on the **CPU side (outside `@spaces.GPU`)** rather than fight TF+CUDA inside ZeroGPU. It's fast enough on CPU anyway (see below).

### Does the pipeline fit?
- **Demucs (htdemucs / htdemucs_ft):** hybrid-transformer, ~few GB VRAM. On an A100-class/Blackwell GPU a 3–4 min song separates in roughly **15–45 s**. **Fits comfortably in a 120 s window**; use `duration` scaled to song length to be safe on longer tracks. Weights are hundreds of MB — cache them, don't download inside the GPU call.
- **basic-pitch (Spotify audio→MIDI):** lightweight NN. **~5–15 s for a 3-min song on CPU, no GPU needed.** Run it on the CPU side after separation. This keeps all GPU-quota spend on Demucs only.
- **Synth/effect reconstruction + DAW export:** pure CPU (pretty_midi / mido / DAWproject or Reaper RPP / .als generation). No GPU.

**Net:** only the Demucs stem-split needs GPU; everything else is CPU. This is the ideal ZeroGPU shape — small, bounded GPU bursts.

---

## 3. Gradio vs Streamlit vs Docker

| | Gradio SDK | Streamlit | Docker (custom, e.g. FastAPI) |
|---|---|---|---|
| ZeroGPU support | **Yes (only Gradio works)** | No | No |
| Audio in/out widgets | **First-class** `gr.Audio`, `gr.File` | Basic | DIY |
| Built-in queue + SSE (no POST timeout) | **Yes** | No | DIY |
| Progress bars / streaming | **`gr.Progress`, `yield`** | Limited | DIY |
| Auto REST API endpoint | **Yes** | No | You build it |
| Setup effort | Lowest | Low | Highest |

**Recommendation: Gradio SDK.** It is the *only* framework compatible with ZeroGPU, and it natively covers the whole upload→process→download UX. Docker+FastAPI would force a **dedicated always-on GPU** (much pricier) and rebuild everything Gradio gives free. Choose Docker only if you later need a public multi-tenant API, custom auth, or a job queue Gradio can't express — not for the MVP.

**Gradio audio specifics:**
- `gr.Audio(type="filepath")` for upload; outputs auto-show a **download button**. `format=` controls output codec.
- **Upload cap:** `demo.launch(max_file_size="50mb")` (or `gr.FileSize.MB`) to reject oversized files early. Set a sane limit (songs are ~10–40 MB).
- Multiple stem outputs → several `gr.Audio` components or a single `gr.File`/zip for the DAW project download.

---

## 4. Long-Running Job Handling

- **No POST timeout in the browser:** Gradio's built-in **queue uses server-sent events (SSE)**, so multi-minute jobs don't hit the ~1-min browser POST timeout that plagues raw API calls. Keep the queue **enabled** (default).
- **Space-level:** there is **no hard runtime cap on the Space itself**; the constraint is the **ZeroGPU per-call duration** (your `duration=` value) — so keep the *GPU portion* short and do CPU work outside it.
- **Startup timeout:** a Space must become healthy within **`startup_duration_timeout` (default 30 min)**. Large model downloads at first boot can blow this — mitigate by caching weights (see §5).
- **Progress UX with `gr.Progress` + `yield`:**
```python
@spaces.GPU(duration=180)
def _separate_gpu(audio_path):
    return run_demucs(audio_path)          # GPU-only, returns stems

def pipeline(audio_path, progress=gr.Progress()):
    progress(0.1, desc="Separating stems (GPU)…")
    stems = _separate_gpu(audio_path)      # ZeroGPU call
    progress(0.6, desc="Transcribing to MIDI…")
    midi  = basic_pitch_transcribe(stems)  # CPU
    progress(0.85, desc="Building DAW project…")
    daw   = build_daw_project(stems, midi) # CPU
    progress(1.0, desc="Done")
    return stems_audio, daw                # files → download buttons
```
- **Split GPU from CPU:** wrap **only Demucs** in `@spaces.GPU`; run basic-pitch + DAW export on CPU. This minimizes GPU-quota burn and keeps each GPU acquisition short.
- **Concurrency:** default queue = 1 job at a time per event. Fine for a demo; raise `concurrency_limit` cautiously (ZeroGPU quota is shared/per-user).

---

## 5. Storage & Model Caching

- **Ephemeral disk:** 50 GB, **wiped on restart/rebuild.** Fine for per-request temp WAVs (clean up after each job).
- **Persistent storage (paid add-on):** Small 20 GB **$5/mo** ($0.01/hr) · Medium 150 GB **$25/mo** ($0.03/hr) · Large 1 TB **$100/mo** ($0.14/hr). Mounts at **`/data`**.
- **Model caching strategy:**
  - Best: **preload weights at build time** via the README `models:`/`preload_from_hub:` field so they land in `~/.cache/huggingface/hub` in the image — first request is warm, no startup-timeout risk. (Demucs weights come from its own store; can also pin them into the repo or a startup fetch.)
  - Or set **`HF_HOME=/data/.huggingface`** with persistent storage so restarts skip re-download. Only worth $5/mo if cold rebuilds are frequent.
  - Enable **`hf_transfer`** (`HF_HUB_ENABLE_HF_TRANSFER=1`) for fast, retrying downloads.
  - **Do NOT download weights inside the `@spaces.GPU` function** — it burns GPU-seconds and risks blowing the duration.
- Demucs + basic-pitch weights total well under a GB; the free 50 GB ephemeral disk holds them easily. Persistent storage is optional for the MVP.

---

## 6. Architecture Recommendation

**Single monolithic Gradio Space on ZeroGPU (PRO account).** Do **not** split into multiple Spaces for the MVP — the whole pipeline is seconds of GPU + seconds of CPU; the orchestration/latency cost of multi-Space hops outweighs any benefit.

```
┌──────────────────────── HF Space (Gradio SDK, ZeroGPU) ────────────────────────┐
│  gr.Audio upload  ──►  pipeline() [CPU orchestrator, Gradio queue+SSE]          │
│                          │                                                       │
│        ┌─────────────────┴──────────────────┐                                   │
│        │ @spaces.GPU(duration≈song-scaled)   │  ◄── ZeroGPU acquire/release      │
│        │   Demucs stem separation            │                                   │
│        └─────────────────┬──────────────────┘                                   │
│                          ▼ (CPU, no GPU quota)                                   │
│              basic-pitch → MIDI  →  synth/effect recon  →  DAW project (.zip)    │
│                          ▼                                                        │
│  gr.Audio(stems) + gr.File(daw_project.zip)  ──►  download                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Client-side offload (transformers.js / ONNX / WebGPU):** interesting but **not for the MVP.** Transformers.js v4 (2025, WebGPU C++ runtime) runs Whisper-class audio models in-browser, but **there is no maintained Demucs port**, and hybrid-transformer separation is heavy for WebGPU. Revisit later to move basic-pitch (which already ships a JS/ONNX build: `basic-pitch-ts`) into the browser to cut server CPU — a real but secondary optimization.

**Cost estimate for real users (ZeroGPU + PRO):**
- Per song: Demucs ≈ **20–45 GPU-s** (call it ~40 s to be safe). basic-pitch + DAW = CPU, no quota.
- PRO base **$9/mo** includes ⚠️(25–40 GPU-min/day ≈ **37–60 songs/day free**). Beyond that, overflow credits at **$1/10 GPU-min** ⇒ **~$0.067 per song** (~40 GPU-s).
- Example: **1,000 songs/month** ≈ 1,000×40 s = ~11 GPU-hr. If ~20 GPU-hr/mo is inside quota it's just the $9 base; if it all spilled to credits, 11 GPU-hr × $6/hr ≈ **$66/mo**, i.e. **~$0.07/song**. Realistic MVP bill: **$9–$75/mo**.
- Compare a dedicated **A10G Small = $1/hr = $720/mo always-on** (or ~$0.02/hr with aggressive sleep, but then you eat cold-boot on every visit). **ZeroGPU wins decisively for bursty demo traffic.**

---

## 7. Concrete Repo Structure

```
stemflipper/
├── README.md            # YAML config header (below) + docs
├── app.py               # Gradio UI + pipeline + @spaces.GPU
├── requirements.txt     # python deps
├── packages.txt         # apt deps: ffmpeg, libsndfile1
├── src/
│   ├── separate.py      # Demucs wrapper (GPU)
│   ├── transcribe.py    # basic-pitch wrapper (CPU)
│   └── daw_export.py    # MIDI+stems → DAW project zip
└── (no Dockerfile — Gradio SDK, required for ZeroGPU)
```

**README.md YAML header** (all-lowercase keys):
```yaml
---
title: StemFlipper
emoji: 🎛️
colorFrom: purple
colorTo: blue
sdk: gradio
sdk_version: 5.36.2
app_file: app.py
python_version: "3.10.13"      # ZeroGPU-supported (or 3.12.12)
suggested_hardware: zero-a10g  # request ZeroGPU
pinned: false
license: mit
short_description: Song → stems → MIDI → DAW project
models:                        # preload at build so first request is warm
  - spotify/basic-pitch        # (if HF-hosted variant used)
---
```
> Enable ZeroGPU on the Space **Settings → Hardware** page (attach to a PRO account for full quota). `suggested_hardware` is a hint; the actual GPU is chosen in Settings.

**requirements.txt** (pin to ZeroGPU-supported versions):
```
spaces
gradio>=4
torch>=2.8.0
demucs
basic-pitch
pretty_midi
soundfile
```

**packages.txt** (system libs Demucs/soundfile need):
```
ffmpeg
libsndfile1
```

**No Dockerfile** — Gradio SDK is mandatory for ZeroGPU; a Dockerfile would disable it.

---

## Open items to confirm on live HF pages before build
1. ⚠️ Current **PRO ZeroGPU daily quota** (25 vs 40 min) and exact over-quota credit rate.
2. ⚠️ Current **ZeroGPU GPU model & VRAM** (RTX PRO 6000 Blackwell 96 GB vs H200 141 GB) — affects nothing functionally here but worth knowing.
3. Latest **Gradio `sdk_version`** and the exact ZeroGPU-supported **Python/torch** pins at build time.
4. Demucs weight source/caching path for the `preload`/`HF_HOME` approach.

## Sources
- HF Spaces GPUs / pricing: https://huggingface.co/docs/hub/en/spaces-gpus · https://huggingface.co/pricing
- ZeroGPU docs: https://huggingface.co/docs/hub/en/spaces-zerogpu · https://github.com/huggingface/hub-docs/blob/main/docs/hub/spaces-zerogpu.md
- ZeroGPU GPU migration (RTX PRO 6000 vs H200): https://discuss.huggingface.co/t/nvidia-rtx-pro-6000-instead-of-h200-for-zerogpu/175960
- PRO quota discussion: https://discuss.huggingface.co/t/what-is-the-quota-on-zerogpu-for-pro-users/94203
- Spaces storage: https://huggingface.co/docs/hub/en/spaces-storage · https://huggingface.co/storage
- Startup timeout: https://huggingface.co/docs/hub/spaces-config-reference
- Gradio queue/progress: https://gradio.app/guides/queuing · https://gradio.app/guides/streaming-outputs
- Gradio audio / file size: https://gradio.app/docs/gradio/audio · https://github.com/gradio-app/gradio/issues/7825
- Docker vs Gradio Spaces: https://huggingface.co/docs/hub/spaces-sdks-docker · https://huggingface.co/docs/hub/spaces-sdks-gradio
- Demucs Spaces examples: https://huggingface.co/spaces/abidlabs/music-separation · https://github.com/facebookresearch/demucs
- basic-pitch: https://github.com/spotify/basic-pitch · https://github.com/spotify/basic-pitch-ts
- transformers.js v4 / WebGPU: https://huggingface.co/blog/transformersjs-v4 · https://huggingface.co/blog/transformersjs-v3
