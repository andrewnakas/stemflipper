# StemFlipper — DAW Export / Interchange Formats: Technical Research Report

Feeds an implementation plan. Covers universal interchange formats, DAW-specific project formats, the MIDI+audio bundle MVP, sampler instrument formats, metadata detection, and Python libraries — with concrete format details, library links + maintenance status, and MVP vs full-fidelity recommendations.

---

## TL;DR recommendation

- **MVP (ship first):** a **project folder** = separated **stem WAVs** + **per-instrument Standard MIDI Files (Format 1)** + a **JSON/README manifest** (tempo map, key, time sig, instrument→track mapping, suggested plugins). This is the ONLY path that every target DAW (Ableton, FL Studio, Logic, Reaper, Bitwig, + Pro Tools) can import. Low effort (`mido`/`pretty_midi`). Optionally drop a **Reaper `.RPP`** into the same folder that references the WAVs/MIDI — trivial to emit, zero rejection risk, gives one-click open for Reaper users.
- **Full-fidelity (phase 2):** **DAWproject** export (MIT, plain XML+ZIP) — preserves MIDI notes, audio clips/fades, automation, tempo/time-sig, AND embedded plugin/device state. Reaches **Bitwig, Studio One, Cubase, Nuendo, Cubasis, VST Live** natively, and **Reaper via a converter**. Best rich format, but does NOT reach Ableton/FL/Logic.
- **Sampler instruments (sliced stems):** emit **SFZ** (trivial plain-text) and/or **DecentSampler `.dspreset`** (XML) so slices become playable multisample instruments.
- **Ableton `.als`**: possible but hardest/most brittle — do it template-based off a real exported set, phase 3+.
- **AAF/OMF**: audio-only, drops MIDI + instrument chains — skip except as a niche Pro Tools/Logic fallback.

---

## 1. Universal interchange formats

### 1a. DAWproject (recommended rich format)
- **What:** Bitwig+PreSonus open interchange format. `.dawproject` = **ZIP** containing `project.xml` + `metadata.xml` (UTF-8) + embedded media/plugin-state files (exporter chooses directory layout). Schemas `Project.xsd` + `MetaData.xsd` published.
- **Object model:** `Application`, `Transport` (Tempo + TimeSignature), `Structure` (Track hierarchy, `contentType`), `Channel` (Volume/Pan/Mute/Sends, Devices), `Lanes` (timeUnit = beats or seconds, combinable), `Clips`/`Clip`, `Warps` (time-stretch/pitch), `Notes`/`Note` (with velocity + expressions), `Points` (automation for tempo/time-sig/MIDI/volume/pan/sends/plugin params), `Device`/`Vst2Plugin`/`Vst3Plugin`/`ClapPlugin`/`BuiltinDevice` (**full plugin state embedded**), built-in Generic EQ/Compressor/Gate/Limiter.
- **Version:** 1.0, stable. **License: MIT.** Official lib is **Java** (annotated classes → XSD; Gradle/Maven).
- **Support (2025–26):** Bitwig Studio 5.0.9+, Studio One 6.5+, Cubase 14, Nuendo 14, Cubasis 3.7.1, VST Live 2.2, n-Track 10.2.2. **Reaper: no native support** — bridged by **ProjectConverter** (git-moss, Java/LGPLv3, ships as ConvertWithMoss GUI; RPP↔DAWproject only; flattens nested clips, drops AU/video/complex routing). **NOT supported: Ableton, FL Studio, Logic, Pro Tools.**
- **Python:** **roex-audio/dawproject-py** (MIT, **pure Python**, deps `lxml`+`chardet`) — parse/generate/modify/validate. API: `Project()`, `Utility.create_track(...)`, `Equalizer/Compressor`, `DawProject.save(project, metadata, files, path)`, `DawProject.save_xml`, `DawProject.validate`. Install from source (`pip install -e .`). Actively maintained by RoEx. (Alternatives: ruchirlives/dawproject = MIDI→dawproject for Studio One.) Because it's plain XML+ZIP, a bespoke writer against the XSD is also easy.
  - Repos: github.com/bitwig/dawproject · github.com/roex-audio/dawproject-py · github.com/git-moss/ProjectConverter

### 1b. OMF / AAF (older interchange — not recommended)
- **AAF** (successor to **OMF**): moves *edited audio timelines* between NLE↔DAW. Holds audio media (embedded/referenced), clip placement/lengths, fades/crossfades, **volume automation**, pan, clip gain, track names, markers. **NO MIDI, NO instrument/plugin state, NO aux/master.** OMF is a subset (loses vol automation + track names, 2 GB cap).
- **Support:** Pro Tools (full), Logic (import/export, audio + vol automation only), Reaper (import/export). **NOT** Ableton / FL Studio / Bitwig.
- **Python:** **pyaaf2** (markreidvfx, pure Python read/write, v1.7.1 Sept 2025, py2.7–3.11+). Serious but video-post oriented; won't carry your MIDI/chains.
- **Verdict:** Impractical as primary — drops StemFlipper's core value (MIDI + instrument chains). Only a niche fallback to Pro Tools/Logic for stem audio + rough automation.

### 1c. Standard MIDI Files + stem WAVs (lowest common denominator — the MVP)
- **SMF Format 1** (use this): multi-track, **Track 0 = conductor** (global tempo map, time sigs, key sigs); subsequent tracks = per-instrument notes. Carries: Set Tempo (full tempo map), Time Signature, Key Signature (`sf` −7..+7, `mi` 0/1), Track/Sequence Name, Program Change (GM patch hints), markers. Default 120 BPM / 4/4 if unspecified. Format 0 = single merged track (avoid).
- **Universal:** every DAW (Ableton, FL, Logic, Reaper, Bitwig, Pro Tools) imports SMF. Combined with drag-drop stem WAVs + a manifest, this is zero-lock-in. Only thing not conveyed: automatic instrument/plugin assignment (no format solves that cross-DAW reliably).

---

## 2. DAW-specific project formats

### Ableton `.als` (hardest; phase 3+)
- **Encoding:** gzip-compressed XML, single file (build XML → gzip → write `.als`).
- **Hierarchy:** `Ableton(MajorVersion="4" MinorVersion Creator SchemaChangeCount) → LiveSet → Tracks → {MidiTrack|AudioTrack|ReturnTrack} → DeviceChain → MainSequencer → ClipSlotList → ClipSlot → {MidiClip|AudioClip}`; `MasterTrack` (renamed `MainTrack` in newer versions).
- **MIDI notes** grouped per pitch: `MidiClip → Notes → KeyTracks → KeyTrack → {Notes → MidiNoteEvent(Time,Duration,Velocity,OffVelocity), MidiKey(Value=0..127)}`. Time/Duration in **beats** (quarter=1.0). **Tempo:** `MasterTrack → DeviceChain → Mixer → Tempo → Manual(Value=120)`. **Audio:** `AudioClip → SampleRef → FileRef` (write BOTH RelativePath + absolute Path).
- **Risk:** schema large/undocumented/version-sensitive; Live rejects or silently drops malformed content. **Strategy: template surgery** — start from a real `.als` exported by the exact target Live version, inject tracks/notes/sample refs.
- **Tooling:** **Ableton official export library** (ableton.github.io/export/ — write-only, Obj-C/iOS-oriented, license-gated; Project→tracks/clips/notes/tempo/timesig, enforces edition track limits). **abletoolz** (elixirbeats/abletoolz — XML read/edit/dump, good for templates). alsd/loive/pyableton = parse-only. **pylive** = drives a *running* Live over OSC (not file generation). No mature pure-Python "MIDI→.als from scratch" generator.

### FL Studio `.flp`
- **PyFLP** (demberto/PyFLP): pure-Python parser+editor, `pyflp.parse()`/`pyflp.save()`, py3.8+/PyPy, GPLv3, **v2.2.1 (Jun 2023, "Alpha")**. Can set tempo, channels (samplers/instruments), patterns, mixer, sample paths, plugin flags. **Key limits: modifier not from-scratch generator; "doesn't work for FL Studio 21 projects"; missing samples error; backup + verify-in-FL advised.** GPLv3 is a licensing consideration for a hosted app. Verdict: risky/low-priority target.

### Reaper `.RPP` (easiest to generate)
- **Plain text**, forgiving. Two constructs: single-line tokens (`TEMPO 120 4 4`, `POSITION 2.0`, `LENGTH 10.2`, `FILE "x.wav"`) and `<BLOCK ... >` nestable blocks. Skeleton: `<REAPER_PROJECT → TEMPO → <TRACK NAME → <ITEM POSITION LENGTH → <SOURCE WAVE FILE "stem.wav" > > >`. Audio items reference WAV by path. **MIDI is embedded inline** in `<SOURCE MIDI` via `HASDATA 1 960 QN` + `E <delta-ticks> <hex bytes>` event lines.
- **Python:** **Perlence/rpp** (PLY+attrs, BSD, `rpp.loads`/`rpp.dumps`, ElementTree-like) — **inactive** (v0.5, Apr 2023). **reathon** (jamesb93/reathon) — Python RPP *constructor*, more generation-oriented. rppxml (Python), rppp (JS). Format is simple enough to emit with plain string templates.

### Bitwig
- No standalone open Bitwig project format; interchange = **DAWproject** (native since 5.0.9). See §1a.

---

## 3. MIDI + audio bundle (the pragmatic MVP)
Export a folder:
```
song_name/
  stems/  {vocals,bass,drums,other,...}.wav
  midi/   {bass,keys,...}.mid   (Format 1, one instrument each OR one multi-track file)
  instruments/  {slice-based .sfz / .dspreset}   (optional, §4)
  manifest.json   (tempo BPM + tempo map, key, time signature, per-track instrument names,
                   suggested GM programs / plugin hints, sample-rate, bar/beat offsets)
  README.txt      (human instructions: drag WAVs in, import MIDI, set project BPM/key)
  project.RPP     (optional — references ../stems/*.wav + inline MIDI; one-click Reaper open)
  project.dawproject (optional phase-2 — Bitwig/Studio One/Cubase)
```
Every DAW can consume the WAVs + MIDI + manifest. RPP/DAWproject are convenience add-ons that make specific DAWs open the arrangement directly.

---

## 4. Sampler instrument formats (slices → playable instruments)

### SFZ (open text — easiest)
- Plain-text opcodes; trivially generated from Python (string templating). Hierarchy: `<global>`/`<group>`/`<region>`. Per-slice mapping opcodes: `sample=`, `key=` or `lokey=`/`hikey=`, `pitch_keycenter=`, `lovel=`/`hivel=`, `offset=`, `loop_mode=`.
- **Players:** sforzando (Plogue, free, SFZ2 + ARIA), sfizz (open source, VST/LV2/AU), LinuxSampler, liquidsfz, Surge XT, Vital. Loads in all major DAWs via those plugins.

### DecentSampler `.dspreset` (XML)
- XML: `DecentSampler(minVersion) → ui(tab) → groups(env attrs) → group → sample(path, rootNote, loNote, hiNote, loVel, hiVel, start/end, loopStart/loopEnd, tuning) → effects → midi`. `.dslibrary` = ZIP of `.dspreset` + WAVs. Docs: decentsampler-developers-guide.readthedocs.io; XSD: praashie/DecentSampler-schema. Free plugin, cross-DAW.
- Both formats are generate-from-Python-friendly; SFZ is the simplest, DecentSampler adds bundled UI/effects.

---

## 5. Metadata detection (populate tempo/key/time-sig)
- **librosa** (BSD): `beat.beat_track`/`feature.tempo` for BPM; chroma-based key estimation (roll your own via `feature.chroma_cqt` + key profiles). numpy/scipy/numba deps.
- **madmom** (CPJKU, BSD-ish/academic): state-of-the-art RNN beat/downbeat/tempo + meter tracking (`RNNDownBeatProcessor` + `DBNDownBeatTrackingProcessor` → time signature), also transcription. Best accuracy offline; heavier install, older-Python leanings — pin versions.
- **essentia** (UPF, AGPL/commercial): `RhythmExtractor2013` (multifeature/degara) for beat+BPM, `TempoCNN`, `KeyExtractor` for key/scale. AGPL license — note for a hosted product.
- **Spaces/pip note:** librosa installs cleanly (pure-py + numpy/scipy/numba wheels). madmom/essentia are heavier (compiled/Cython, occasional Python-version friction) — pin versions and test in the target runtime. AGPL (essentia) and academic licenses matter for a commercial deploy.

---

## 6. Python library summary (name · role · license · status · Spaces-fit)
| Library | Role | License | Status | Notes |
|---|---|---|---|---|
| mido | SMF read/write (Format 0/1, all meta) | MIT | Maintained | Pure Python, tick-based. **Core MVP.** |
| pretty_midi | High-level MIDI create/analyze | MIT | Maintained | numpy dep, seconds-based, easiest note authoring |
| roex-audio/dawproject-py | DAWproject parse/generate | MIT | Active | Pure Python (lxml, chardet). Phase-2 rich export |
| Perlence/rpp | Reaper RPP parse/emit | BSD-3 | **Inactive (2023)** | PLY+attrs; or emit RPP via plain templates / reathon |
| reathon | Reaper RPP constructor | — | Niche | Generation-oriented |
| PyFLP | FL Studio .flp modify | GPLv3 | Alpha (2023) | Not from-scratch; no FL21; GPL caveat |
| pyaaf2 | AAF read/write | MIT | Maintained (2025) | Audio-only; no MIDI/chains |
| Ableton export lib | .als generation | Ableton license | Official | Obj-C/iOS; write-only |
| abletoolz | .als XML surgery | Open | Community | Template editing |
| librosa / madmom / essentia | Tempo/key/meter detection | BSD / academic / AGPL | Maintained | essentia AGPL + heavier installs |

---

## Recommended roadmap
1. **MVP:** WAV stems + SMF Format 1 + JSON manifest + README (mido/pretty_midi). Metadata via librosa (+ madmom for downbeat/meter if install allows). Universal, ships fast.
2. **+ Reaper `.RPP`** emitter in the same folder (string templates or Perlence/rpp) — one-click open, near-zero risk.
3. **+ Sampler instruments:** SFZ first (trivial), DecentSampler `.dspreset` for richer packaged instruments.
4. **+ DAWproject** (dawproject-py or bespoke XSD writer) — full-fidelity for Bitwig/Studio One/Cubase/Nuendo; Reaper via ProjectConverter.
5. **(Optional, later) Ableton `.als`** via template surgery off a real exported set / official export lib. **Skip AAF/OMF and `.flp`** unless a specific user segment demands them.
