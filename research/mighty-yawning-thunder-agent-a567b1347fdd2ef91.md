# StemFlipper — State of the Art in Automatic Music Transcription (Audio Stems → MIDI)

Technical research report. Date: 2026-07-06. Scope: converting separated audio stems into editable MIDI for a web app (HuggingFace Spaces, CPU-first with optional GPU). All accuracy figures cited; limitations flagged honestly.

---

## 0. Executive summary — the recommended stack

The proven, dominant pattern is **Demucs (separation) → per-stem transcriber → librosa (beat grid) → pretty_midi (assemble/quantize/write)**. No single transcriber is best for every stem; the differentiators are (a) upgrading piano to the ByteDance model and (b) how you handle drums (nobody does it cleanly).

| Stage | Recommended tool | pip package | License | CPU? |
|---|---|---|---|---|
| **Separation (default)** | Demucs `htdemucs` (4-stem) | `demucs` | MIT | Yes (~1.5× track duration) |
| **Separation (6-stem / HQ)** | Demucs `htdemucs_6s`; RoFormer via `audio-separator` for GPU HQ mode | `demucs`, `audio-separator[cpu]` | MIT | Yes / GPU better |
| **Vocals** | `basic-pitch` (fallback: torchcrepe/PESTO + Viterbi) | `basic-pitch` | Apache-2.0 | Yes |
| **Bass** | `basic-pitch` + octave clamp (fallback: torchcrepe/pyin, tight fmin/fmax + Viterbi) | `basic-pitch` | Apache-2.0 | Yes |
| **Drums** | ADT is the weak link — see §4. librosa-onset + band heuristic → GM drum map (permissive MVP); ADTOF-pytorch or omnizart for accuracy | `librosa` / `omnizart` | ISC / MIT | Yes |
| **Piano / keys** | ByteDance `piano_transcription_inference` (fallback: `basic-pitch`) | `piano-transcription-inference` | MIT | Yes |
| **Guitar / other** | `basic-pitch` | `basic-pitch` | Apache-2.0 | Yes |
| **Beat/tempo/onset** | librosa | `librosa==0.11.0` | ISC | Yes |
| **MIDI assembly** | pretty_midi (+ mido for byte-level) | `pretty_midi`, `mido` | MIT | Yes |

Design rule: **do NOT pull in full TensorFlow, note-seq, or madmom** if avoidable. A `basic-pitch` (TFLite/ONNX) + `piano-transcription-inference` (PyTorch) + `librosa` + `pretty_midi` stack installs cleanly on Python 3.10–3.12 with modest RAM and is HF-Spaces-friendly.

---

## 1. Polyphonic transcription models (2024–2026)

### 1a. Spotify Basic Pitch — the lightweight generalist (TOP PICK for pitched stems)
- **pip:** `pip install basic-pitch` (TF optional: `pip install basic-pitch[tf]`). Latest v0.4.0. Python 3.7–3.11 (M1 → 3.10).
- **GitHub:** github.com/spotify/basic-pitch · **HF model:** huggingface.co/spotify/basic-pitch · **TS/npm port:** spotify/basic-pitch-ts · **Demo:** basicpitch.spotify.com
- **License:** **Apache-2.0** (commercial-safe).
- **Architecture:** fully-convolutional CNN, **only ~16,782 params (<17K), <20 MB memory**. Input resampled to 22.05 kHz mono → CQT (3 bins/semitone) → harmonic stacking (HCQT approximation). Three posteriorgram heads: **onsets, note/frame activations, multipitch contour** (contour enables **pitch-bend detection**).
- **Instrument-agnostic + polyphonic**, "works best on one instrument at a time" — i.e. exactly the post-separation use case. Reads mp3/ogg/wav/flac/m4a.
- **Runtimes:** CoreML (macOS default), **TFLite (Linux default)**, ONNX (Windows default), TF (optional). CPU inference faster-than-real-time; **no GPU needed**. On a Linux HF Space it uses TFLite by default — light.
- **API:** `from basic_pitch.inference import predict; model_output, midi_data, note_events = predict("audio.wav")`. Tunable: `onset_threshold`, `frame_threshold`, `minimum_note_length`, `minimum_frequency`, `maximum_frequency`. Output is `pretty_midi`-compatible.
- **Accuracy (honest):** GuitarSet note-F ≈ **79%** (good); vocals (Molina) frame ≈ 63% / note-F ≈ **52%** (decent for monophonic); **dense polyphonic piano (MAESTRO) ≈ 38% — WEAK** (worst case). Not SOTA on any single instrument, but the best "throw any audio at it" option and trivially deployable. Full-band mixes degrade badly → always feed it separated stems.
- **Maintained:** Yes, PRs through 2025.

### 1b. MT3 / MR-MT3 — true multitrack, but not production-friendly
- **MT3:** github.com/magenta/mt3, arXiv:2111.03017 (ICLR 2022). T5 encoder-decoder transformer; transcribes **multiple instruments simultaneously** to separate MIDI tracks (seq2seq token task). Apache-2.0.
- **Checkpoints:** in GCS bucket `gs://mt3/checkpoints/` (multi-instrument + ISMIR2021 piano + ismir2022 base/small), via `gsutil` — not a clean pip/HF download. Inference only ("training not easily supported").
- **HF Spaces (community, often stale):** `akhaliq/MT3` (original), `suxiaomi/MT3`, `hero-intelligent/MT3`, `oniati/mrt2`. PyTorch reimplementations: `kunato/mt3-pytorch`, `rlax59us/MT3-pytorch`.
- **Deps/cost:** T5X + JAX/Flax + gin-config + note_seq. Brittle install; **TPU/GPU-oriented**, autoregressive decoding slow + memory-hungry. **CPU inference impractical.** Colab is the intended entry point.
- **MR-MT3** (arXiv:2403.10024, 2024, github.com/gudgud96/MR-MT3): adds memory-retention to fix MT3's **instrument leakage** (notes scattered to wrong tracks). +2.1 pp MIDI-class F1 on Slakh2100. Research artifact, same practicality caveats.
- **Verdict:** only option for full-mix → multitrack MIDI, but **not for CPU-first deployment**. StemFlipper separates first, so it does not need MT3.

### 1c. YourMT3+ — newer multi-instrument SOTA (2024), but GPL + GPU
- github.com/mimbres/YourMT3, arXiv:2407.04822 (MLSP 2024). SOTA on multi-instrument transcription **and drum recognition**. HF Space with **free GPU** (Aug 2024); a CPU Space exists (`mimbres/YourMT3-cpu`) but is heavy. **License: GPL-3.0** (contaminates proprietary derivatives) and **GPU-dependent**. The modern MT3 successor; licensing + GPU make it a poor fit for a commercial CPU-first app.

### 1d. Onsets and Frames (Magenta) — best classic piano, but ARCHIVED TF1
- Inside the `magenta` pip package (`magenta/models/onsets_frames_transcription`). MAESTRO-trained piano + separate E-GMD drums model. Apache-2.0.
- Checkpoints: `maestro_checkpoint.zip` (piano), `e-gmd_checkpoint.zip` (drums) on `storage.googleapis.com/magentadata`.
- **State-of-the-art-class for solo piano** at release (dual onset+frame objective) — far better than Basic Pitch on dense piano (94.80% onset F1). Piano-only, no pitch bends. Runs on CPU.
- **CRITICAL: the `magenta` monorepo is ARCHIVED / read-only** (last release v2.1.4, Aug 2022; repo archived Jan 2026). Built on **TensorFlow 1.15** → dependency-resolution pain in 2026. README recommends migrating to MT3. **For piano, use ByteDance instead.**

### 1e. ByteDance high-resolution piano transcription — BEST PIANO (recommended)
- **pip:** `pip install piano_transcription_inference` (v0.0.6, 2025-01-26). **GitHub:** qiuqiangkong/piano_transcription_inference (inference), bytedance/piano_transcription (training). arXiv:2010.01815. **License: MIT.**
- Trained on MAESTRO V2; regresses precise onset/offset times (sub-frame resolution) + pedals. **Note onset F1 = 96.72%, pedal onset F1 = 91.86% on MAESTRO** — the widely-cited SOTA onset result, beats Onsets & Frames (94.80%).
- **Usage:**
  ```python
  import librosa
  from piano_transcription_inference import PianoTranscription, sample_rate
  audio, _ = librosa.load(path, sr=sample_rate, mono=True)
  PianoTranscription(device='cpu').transcribe(audio, 'output.mid')  # 'cuda' if GPU
  ```
- Checkpoint auto-downloads from Zenodo record 4034264 (~150 MB `Note_pedal` CRNN) — cache it in the image to avoid cold-start download. Needs ffmpeg for MP3. **CPU supported** (slower-than-realtime on long pieces → chunk + show progress). PyTorch (~1.5 GB) + torchlibrosa + librosa. Trained on solo piano → degrades on synths/e-piano; feed the separated piano stem.

### 1f. Transkun — newer expressive piano (ISMIR 2024)
- **pip:** `pip install transkun` (v2.0.1, 2024-09-28). GitHub: Yujia-Yan/Transkun. MIT, Python 3.6+, PyTorch, **CPU by default**. CLI: `transkun input.mp3 output.mid`.
- **~95.05% note onset+offset F1 on MAESTRO V3** — the *stricter* onset+offset metric (ByteDance's 96.7% is onset-only), so Transkun is at/above SOTA for expressive piano. Strong modern alternative.

### 1g. omnizart — all-in-one toolkit (use with caution)
- github.com/Music-and-Culture-Technology-Lab/omnizart, `pip install omnizart`, arXiv:2106.00497, **MIT**. Six modules: piano/music, **drums**, chords, **vocal** (note+F0), beat/downbeat, multi-instrument. `omnizart download-checkpoints` after install.
- **NOT abandonware** — v0.6.3 released 2026-05-31; setup.py modernized (targets Python 3.10/3.11 via tf-keras shim, tensorflow≥2.5). BUT install fragile: native deps `madmom`, `pyfluidsynth`, `vamp`, `pyaudio`. **Incompatible with Apple-Silicon macOS** (x86_64 Linux Spaces OK, but local M-series dev painful). Drum *training* has non-converging bugs (inference from checkpoints works).
- **Accuracy:** piano 79.6% note-F (MAPS, well below ByteDance); drums 74% note-F (ENST) / 71% (MDB-Drums); vocal note 68.4% F1. **Only adopt for its drums/chords/beat breadth.**

### 1h. PatchCNN — vocal melody extraction (2018, dated)
- Su, ICASSP 2018, arXiv:1804.09202, repo leo-so/VocalMelodyExtPatchCNN; shipped as omnizart's `patch-cnn` module. Extracts monophonic vocal melody F0 from polyphonic audio. Superseded by CREPE / SwiftF0 / RMVPE for modern vocal pitch. Not a reason to adopt omnizart alone.

---

## 2. Per-stem strategy (the key synthesis)

Insight: separating first is what makes transcription tractable (basic-pitch and pitch trackers are excellent on a clean single instrument and fall apart on a dense mix). Recommended mapping:

- **Vocals (monophonic melody → MIDI):** primary **basic-pitch** (pitch bends, fast, CPU). For a stricter single melody line, **torchcrepe/PESTO** F0 → note-segment with Viterbi. Vocals need good voicing detection (confidence gate or pyin's `voiced_flag`).
- **Bass (monophonic, octave-error-prone):** primary **basic-pitch** (bass is among its best cases). #1 failure = octave errors → mitigate with **Viterbi decoding + tight `fmin`/`fmax` range clamp** (bass ~30–350 Hz) + force monophony. Fallbacks: torchcrepe (Viterbi) or `librosa.pyin` (low fmin, longer frame). SwiftF0's 46.9 Hz floor may miss low-B bass.
- **Drums (ADT → MIDI drum map):** **basic-pitch does NOT do drums** (garbage output). See §4. Permissive MVP = librosa onset + spectral-band heuristic → GM drum map; accuracy upgrades = ADTOF-pytorch or omnizart drum module.
- **Piano/keys (polyphonic):** primary **ByteDance `piano_transcription_inference`** (96.7% F1, pedals, CPU); fallback basic-pitch for synths/e-piano. Transkun a strong newer alternative.
- **Guitar/other (polyphonic):** **basic-pitch** (instrument-agnostic). "Other" is a residual mix → expect ghost notes.
- **Guitar tablature:** no mature CPU pip package as of 2026 — all research-grade (SynthTab, TART, Fretting-Transformer, GOAT). Path: basic-pitch audio→MIDI, then a separate MIDI→tab step if needed.

---

## 3. Monophonic pitch tracking (vocals & bass f0 → MIDI)

Two-stage everywhere: **(1) f0 estimation → (2) note segmentation/quantization → MIDI.** No single tool is best at both.

**Classic / canonical:**
- **CREPE** (`pip install crepe`, github marl/crepe, **MIT**): deep CNN, sizes tiny→full, output time/freq/confidence CSV, `--viterbi` smoothing. Accuracy very high on clean audio (RWC-Synth RPA 0.999) but degrades in noise and reports pitch in silence (gate on confidence). **Slow on CPU + TensorFlow dep** → poor first choice for a CPU Space.
- **torchcrepe** (`pip install torchcrepe`, MIT, maintained 2025): PyTorch port, same weights, **no TensorFlow**, easy GPU, built-in `filter.median/mean`, `threshold.At/Hysteresis/Silence` (useful for segmentation), Viterbi default decoder (penalizes octave jumps). `fmax` capped ~2006 Hz. **The pragmatic way to run CREPE.**
- **pYIN / `librosa.pyin`** (in librosa, **ISC** — clean-room, no GPL): classic DSP, no ML/model download, returns `(f0, voiced_flag, voiced_probs)` (explicit voicing aids segmentation). Fast, pure-CPU. Competitive on **clean** stems (your case post-separation); weaker in noise. Bass: low `fmin`, longer `frame_length`.

**Modern (2024–2025) — substantially faster on CPU, recommended:**
- **PESTO** (`pip install pesto-pitch`, arXiv:2309.02265): self-supervised, ~130k params (~800× smaller than CREPE), ~12× real-time on CPU (a file CREPE does in ~12 min, PESTO does in ~13 s). MIR-1K RPA ~97.7%. Ideal CPU f0 stage.
- **SwiftF0** (`pip install swift-f0`, **MIT**, arXiv:2508.18440): ONNX CNN, ~96k params, ~42–90× faster than CREPE on CPU, best-overall in lars76 benchmark (~90.2% HM), **includes `segment_notes()` + `export_to_midi()`**. Caveat: frequency floor 46.875 Hz may miss lowest bass.
- **RMVPE:** best specifically for **vocals/singing** (tops MIR-1K & Vocadito), heavier to integrate.
- Independent lars76/pitch-benchmark (harmonic-mean): SwiftF0 90.2% > RMVPE 87.2% > CREPE 85.3% > torchcrepe 80.6% > pYIN 78.7%.

**f0 → MIDI note segmentation** (the under-appreciated hard half): voicing gate (+ hysteresis) → `midi = 69 + 12*log2(f0/440)` → group frames into notes on onset / pitch-deviation > ~0.8 semitone / unvoiced gap → drop notes < ~50–80 ms → optional grid quantize. Vibrato: running-median pitch + wide split threshold (or emit pitch bends). Turnkey f0→MIDI: **SwiftF0** (MIT, built-in) or **basic-pitch** (Apache-2.0). **AVOID `crepe-notes` (GPLv3 via madmom)** and **`audio_to_midi_melodia`** (unmaintained, needs non-commercial MELODIA Vamp binary).

**License cheat-sheet:** crepe MIT · torchcrepe MIT · librosa.pyin ISC · basic-pitch Apache-2.0 · SwiftF0 MIT · PESTO permissive · **crepe-notes GPLv3** · MELODIA non-commercial.

---

## 4. Drum transcription (ADT → MIDI drum pattern) — the weakest link

Goal: drum stem → MIDI drum pattern (kick/snare/hihat timing) on the General MIDI percussion map. **GM drum map** (channel 10 / index 9): kick **36** (or 35), acoustic snare **38**, side-stick/rimshot 37, hand clap 39, closed hi-hat **42**, pedal hi-hat 44, open hi-hat **46**, crash 49, ride 51, toms 41–50. Minimal ADT = kick→36, snare→38, closed hi-hat→42. Write via `pretty_midi` (`Instrument(is_drum=True)`).

**Ranked options:**
1. **ADTOF-pytorch** (fork of MZehren/ADTOF): best purpose-built ADT that installs on modern Python — **PyTorch-only**, trained on real music, detects kick/snare/hihat + toms/cymbals (~-0.2% F vs original). **License CC BY-NC-SA 4.0 → NON-COMMERCIAL only.**
2. **librosa onset + spectral classifier** (ISC/BSD, permissive, CPU-fast, always installs): `librosa.onset.onset_detect` + spectral centroid/ZCR/low-band energy to classify (low→kick 36, mid/noise→snare 38, high→hi-hat 42). **Honest:** solid on clean isolated hits, **fails on simultaneous/overlapping hits** (can't split kick+hihat on one onset frame). **Recommended guaranteed MVP baseline.**
3. **omnizart drum** (MIT): CNN ADT with checkpoints, ~74% note-F (ENST). TF2-heavy/fragile install; drum model has acknowledged bugs. Best isolated in its own env.
4. **madmom** (github CPJKU/madmom): best onset + beat/downbeat *grid* building block (RNN/DBN), no drum model. **PyPI 0.16.1 (2018) FAILS on Python 3.10+** (`collections.MutableSequence` import error) + Cython build-order bug. Must use git master (0.17.dev) with `pip install "numpy<2" cython` first. **Models are CC BY-NC-SA (non-commercial)**; code BSD. **Avoid on a Space** — use librosa beats instead.
5. **ADTLib** (github CarlSouthall/ADTLib, BSD): 3 classes → txt onsets + tab PDF (no native MIDI). Deps TF1.x + old madmom → **won't pip install on Python 3.10+. Abandonware, skip.**
6. **Magenta Onsets-and-Frames Drums (E-GMD):** SOTA quality, Apache-2.0, but drum-solo-only, TF1.15, **repo archived Jan 2026** → abandonware in practice.
7. **LarsNet** (polimi-ispl/larsnet): drum *source separation* into 5 pieces (kick/snare/toms/hihat/cymbals), then onset-detect each — better classification but it's a pre-step not a transcriber. **CC BY-NC 4.0 (non-commercial).**
8. **YourMT3+/MT3:** transformer multi-instrument incl. drums; CPU Space exists but heavy, drums secondary, GPL. Overkill for drums-only.

**Honest verdict:** No single permissive, pip-installable, pretrained drum model is the clear standard in mid-2026. Ship the **librosa onset + band-mapping heuristic** (permissive, always works) for the MVP; upgrade to **ADTOF-pytorch** (if non-commercial is acceptable) or **omnizart** (isolated env) if accuracy demands it.

---

## 5. Python packages (maintained + HF-Spaces-compatible)

| Package | pip | Latest | License | numpy 2.x | Maintained | HF Spaces |
|---|---|---|---|---|---|---|
| **pretty_midi** | `pretty_midi` | 0.2.11 (2025-10) | MIT | Yes | Active | Ideal — the MIDI-building workhorse |
| **mido** | `mido` | 1.3.3 (2024-10) | MIT | Yes (no numpy) | Active | Ideal — byte-level, don't install `ports` extras |
| **librosa** | `librosa` | 0.11.0 (2025-03) | ISC | Yes w/ numba≥0.61 | Active | Yes — add `libsndfile1`+`ffmpeg` to packages.txt |
| **note-seq** | `note-seq` | 0.0.5 (2022-07) | Apache-2.0 | stale | **ARCHIVED** | Avoid — drags bokeh/pandas/pydub + **protobuf≥4.21 conflicts**. Reimplement quantization on pretty_midi (~30 lines) |
| **madmom** | `madmom` | 0.16.1 (2017) | BSD/CC-BY-NC-SA | No (PyPI) | git-only | **Avoid** — fails on Py3.10+, Cython build pain |
| **basic-pitch** | `basic-pitch` | 0.4.0 | Apache-2.0 | Yes | Active | Yes — TFLite (Linux) / ONNX, no full TF needed |

**note-seq clarification:** does NOT pull TensorFlow directly (common myth) — TF only comes with full `magenta`. But it's archived with heavy transitive deps and a protobuf≥4.21 landmine → skip it, quantize on pretty_midi yourself.

**pretty_midi core:** `PrettyMIDI` → `Instrument(program, is_drum)` → `Note(velocity, pitch, start, end)` + `PitchBend`. `get_beats()`, `get_downbeats()`, `get_piano_roll(fs)`, `time_to_tick`, `.write('out.mid')`. Small deps (numpy, mido, six), numpy-2-safe.

**When mido vs pretty_midi:** pretty_midi for absolute-seconds/note-objects (95% of pipeline); mido for byte-level control (custom meta events, exact ticks, SysEx, surgical edits).

---

## 6. Quality / limitations — separation, tempo, beat, quantization

**Stem separation quality (MUSDB-HQ avg SDR):** Spleeter ~5.4 < Open-Unmix ~5.3–6.3 < htdemucs ~7.7–9.0 < htdemucs_ft ~8.5–9.2 < BS-RoFormer ~9.8 (no extra data) up to ~12.0 (+500 songs). Higher SDR = cleaner stem = better transcription, but **diminishing returns above ~9 dB for MIDI**; the Spleeter→Demucs jump matters far more than Demucs→RoFormer. **htdemucs_6s piano stem has heavy bleeding/artifacts** (official caveat) — the piano-transcription path inherits this; guitar stem is "okay."

**Separation tooling:** Demucs (`pip install demucs`, MIT) is the backbone — one pass → 4 (or 6) clean stems; RoFormer models are typically 2-stem/single-target so you'd cascade them (why Demucs stays the 4/6-stem backbone). CPU ≈1.5× track duration; GPU ~4–6× real-time (`htdemucs_ft` ~4× slower). `demucs-onnx` (numpy+onnxruntime, no PyTorch) shrinks the image. For RoFormer/MDX without hand-porting weights: **`audio-separator`** (`pip install audio-separator[cpu]`, MIT, actively maintained, auto-downloads UVR weights, wraps MDX-Net/BS-RoFormer/Mel-Band RoFormer/Demucs). Offer RoFormer as a GPU "HQ" mode. Note the FB demucs repo is only lightly maintained (adefossez fork gets critical fixes).

**Beat/tempo for quantization:**
- `librosa.beat.beat_track(y, sr)` → `(tempo, beat_frames)`; `librosa.frames_to_time(beats, sr)` → seconds. Good for steady-tempo pop/EDM. Subdivide each beat interval into N slots (4 → 16ths).
- madmom `DBNBeatTracker` is more robust on real recordings but the install is a liability (§4/§5) → stay with librosa unless you need SOTA beats.

**Quantization pitfalls (all real):**
- **Tempo drift:** scalar `tempo` assumes constant BPM; live/acoustic drift. Snap to the **actual detected `beat_times` grid** (follows the drift), not a synthetic fixed-BPM grid. librosa 0.11 has a time-varying beat tracker + tempogram for diagnosis.
- **Octave/half-tempo errors:** DP/autocorrelation trackers lock onto 2× or ½ true tempo — sanity-check BPM vs 70–180 and multiply/divide.
- **Swing:** a straight 16th grid destroys swing → detect swing ratio / use 8th-triplets / soften (`t = (1-s)*t + s*snap(t)`).
- **Downbeat/phase:** `beat_track` gives beat positions, not bar phase → `get_downbeats` for bar alignment.
- **Onset mismatch:** model vs audio onsets differ by tens of ms → quantize transcribed note starts with a small look-ahead tolerance.
- **Don't over-quantize durations:** snapping `end` to grid can make zero-length notes → enforce a minimum duration.

Quantization does NOT need note-seq — build a subdivided grid from `beat_times` and snap each pretty_midi `Note.start` to the nearest grid point (or quantize in the tick domain via `time_to_tick`, round to `resolution/4`).

**numpy/numba pin (important):** librosa 0.11 needs `numba>=0.61` to use numpy 2.1/2.2; else pin `numpy<2.1`. Pin explicitly in requirements to avoid resolver failures.

---

## 7. Existing end-to-end pipelines to learn from

- **MoriTang/stemscore** — closest reference: `Audio → Demucs (htdemucs/6s) → per-stem WAV → Basic Pitch → MIDI → LilyPond → MusicXML/PDF`. Uses basic-pitch *uniformly*, varies only post-processing (bass/percussion clef, grand staff) → weak drum output. **StemFlipper beats it by swapping in stem-specific transcribers** (ByteDance piano, real ADT).
- **Beats to Blocks** (beatstoblocks.github.io): Demucs → Basic Pitch → Minecraft note blocks. Confirms Demucs+BasicPitch is the de-facto standard.
- **HF Spaces to study:** `abidlabs/music-separation`, `r3gm/Audio_separator`, `asigalov61/ByteDance-Solo-Piano-Audio-to-MIDI-Transcription`, `avans06/Audio-To-MIDI-And-Advanced-Renderer`.
- **Architectural takeaway:** dominant pattern = **Demucs + Basic Pitch for pitched stems**; the two high-value upgrades = **ByteDance for piano** and **real ADT for drums**.

---

## 8. Recommended CPU-friendly HF Space recipe

`requirements.txt`:
```
gradio
demucs                        # separation (htdemucs)
basic-pitch                   # pitched stems (TFLite/ONNX runtime, not full TF)
piano-transcription-inference # piano stem (SOTA, PyTorch, CPU-ok)
librosa==0.11.0               # beat/tempo/onset + drum-onset heuristic
numba>=0.61                   # so numpy 2.1/2.2 resolves; else pin numpy<2.1
pretty_midi                   # assemble/quantize/write MIDI
# audio-separator[cpu]        # optional: RoFormer HQ separation mode
```
`packages.txt`:
```
libsndfile1
ffmpeg
```
Pipeline: **Demucs → per-stem transcriber (basic-pitch / ByteDance / librosa-ADT) → librosa beat grid → snap onsets → pretty_midi assemble & write → Gradio download.** Avoids full TensorFlow, madmom, note-seq; keeps numpy/numba pinned. All core licenses permissive (MIT/Apache-2.0/ISC); avoid LarsNet & ADTOF (CC-BY-NC), crepe-notes & YourMT3+ (GPL), MELODIA (non-commercial).

---

## 9. Key open risks / decisions for the implementation plan
1. **Drums** are the weakest link — decide MVP heuristic (permissive, ships now) vs ADTOF-pytorch (accurate but non-commercial) vs omnizart (isolated env).
2. **Piano stem quality** from htdemucs_6s is poor (bleeding) → ByteDance transcription inherits it; consider gating the 6-stem piano path or transcribing keys from the 4-stem "other" when confident.
3. **numpy/numba version triangle** must be pinned (librosa needs numba≥0.61 for numpy 2.1+).
4. **CPU latency:** Demucs ≈1.5× track duration + ByteDance slower-than-realtime on long piano → chunk long audio, show progress, consider optional GPU tier.
5. **Quantization** is genre-dependent (swing, drift) → expose per-instrument min-note-length and quantization-strength controls.
6. **Licensing discipline:** commercial deployment must exclude GPL (YourMT3+, crepe-notes) and CC-BY-NC (LarsNet, ADTOF, MELODIA, madmom models). The recommended stack is clean (MIT/Apache-2.0/ISC/BSD).
