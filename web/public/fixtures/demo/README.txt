StemFlipper bundle — demo30.mp3
tempo 214.29 BPM · key E minor · 4/4 · 30s

WHAT'S IN HERE

  project.json          everything below, described: grid, chords, per-track notes,
                        which engine transcribed what, and where every asset lives.
                        Open the web app and point it at this bundle to mix and edit.
  stems/*.flac          separated stems (24-bit). stems/drums/ holds the kit split into
                        kick, snare, toms, hi-hat, ride and crash where available.
  midi/song.mid         multitrack MIDI with a real tempo map, time signature, section
                        markers and a chord track. midi/<stem>.mid is one stem alone.
  instruments/<stem>/   a playable instrument built from THIS song's audio:
                          instrument.json / kit.json   the web app's sampler
                          *.sfz                        sfizz, Sforzando, DecentSampler
                          *.dspreset                   DecentSampler (free, all platforms)
                          *.vital                      Vital synth patch (synth-like stems)
                          samples/                     the extracted one-shots / multisamples
  loops/*.wav           bar-aligned loops cut at real downbeats, named with tempo and key.
  phrases/*.wav         silence-bounded phrase chops (mostly vocals), labelled by range.
  effects/*.json        measured EQ curve and reverb time per stem (+ an impulse response).
  project.dawproject    open project format: Bitwig 5+, Studio One 6.5+, Cubase 14+.

HOW TO USE IT

  Any DAW:        drag midi/song.mid in, then drag the stems onto audio tracks.
  Bitwig/S1/Cubase: open project.dawproject — tracks, audio and MIDI arrive together.
  Samplers:       load instruments/<stem>/<stem>.sfz (sfizz) or .dspreset (DecentSampler).
  Browser:        the StemFlipper web app plays the original stems alongside the
                  synthesised and sampled reconstructions, and lets you edit the notes.

HONEST LIMITATIONS

  Transcription is an editable starting point, not a finished score. Drums are the most
  accurate part (each kit piece is separated and transcribed on its own); dense polyphony
  in `other` is the least. Samples inherit whatever bleed and reverb the separation left
  in the stem. The Vital patch and the EQ/reverb match are approximations of the sound,
  not a recreation of the original chain.

  Separation weights are trained on MUSDB18 (non-commercial training data), so this is a
  research/educational tool, not a commercial service.
