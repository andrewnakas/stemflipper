"""Audio loading — the front door, and the place a real upload broke.

A user uploaded `charli.mp3` and the Space failed inside the GPU stage with
libmpg123's "Giving up searching valid MPEG header after 65536 bytes of junk" followed by
libsndfile's misleading "File does not exist or is not a regular file". The file was not
actually MP3 — a `.mp3` extension on AAC data, which is common for downloaded audio — and
`load_stereo` called soundfile with no fallback. These tests pin the fallback chain.
"""

import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

from stemflipper import audio_io

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg/ffprobe not installed")


@pytest.fixture(scope="module")
def wav_path(tmp_path_factory):
    sr = 22050
    t = np.arange(sr * 2) / sr
    tone = 0.5 * np.sin(2 * np.pi * 220 * t)
    stereo = np.stack([tone, tone * 0.6], axis=1).astype(np.float32)
    path = tmp_path_factory.mktemp("audio") / "tone.wav"
    sf.write(str(path), stereo, sr)
    return path


def _encode(src, dest, *args):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src), *args, str(dest)],
        check=True, capture_output=True, timeout=120,
    )
    return dest


def test_wav_loads_two_dimensional(wav_path):
    y, sr = audio_io.load_stereo(wav_path)
    assert y.ndim == 2 and y.shape[1] == 2
    assert sr == 22050
    assert y.flags["C_CONTIGUOUS"], "the pipeline slices this; it must be contiguous"


def test_mono_wav_is_still_two_dimensional(tmp_path):
    path = tmp_path / "mono.wav"
    sf.write(str(path), np.zeros(1000, dtype=np.float32) + 0.1, 22050)
    y, _ = audio_io.load_stereo(path)
    assert y.ndim == 2 and y.shape[1] == 1


@needs_ffmpeg
def test_mp3_loads(wav_path, tmp_path):
    mp3 = _encode(wav_path, tmp_path / "tone.mp3", "-codec:a", "libmp3lame", "-b:a", "128k")
    y, sr = audio_io.load_stereo(mp3)
    assert y.ndim == 2 and len(y) > 0
    assert sr == 22050


@needs_ffmpeg
def test_m4a_loads(wav_path, tmp_path):
    """libsndfile cannot read AAC at all, and the app advertises m4a support."""
    m4a = _encode(wav_path, tmp_path / "tone.m4a", "-c:a", "aac", "-b:a", "128k")
    with pytest.raises(Exception):
        sf.read(str(m4a))  # the tier that used to be the only one
    y, _ = audio_io.load_stereo(m4a)
    assert y.ndim == 2 and len(y) > 0


@needs_ffmpeg
def test_aac_data_with_an_mp3_extension_loads(wav_path, tmp_path):
    """THE reported failure: a `.mp3` that is really AAC.

    soundfile emits "Giving up searching valid MPEG header after 65536 bytes of junk" and
    then reports the file as missing, which is what reached the user as a crash.
    """
    # -ar pinned: AAC otherwise picks its own rate (128k lands on 16 kHz), and this test
    # is about the DECODE path, not the encoder's rate choice.
    m4a = _encode(wav_path, tmp_path / "real.m4a", "-c:a", "aac", "-b:a", "128k", "-ar", "22050")
    fake = tmp_path / "charli.mp3"
    shutil.copy(m4a, fake)

    with pytest.raises(Exception):
        sf.read(str(fake))

    y, sr = audio_io.load_stereo(fake)
    assert y.ndim == 2 and len(y) > 0
    assert sr == 22050
    assert audio_io.duration_of(fake) == pytest.approx(2.0, abs=0.2)


@needs_ffmpeg
@pytest.mark.parametrize(
    "name,args",
    [("tone.flac", ()), ("tone.ogg", ("-c:a", "libvorbis")), ("tone.opus", ("-c:a", "libopus"))],
)
def test_other_containers_load(wav_path, tmp_path, name, args):
    try:
        path = _encode(wav_path, tmp_path / name, *args)
    except subprocess.CalledProcessError:
        pytest.skip(f"this ffmpeg build cannot encode {name}")
    y, _ = audio_io.load_stereo(path)
    assert len(y) > 0


@needs_ffmpeg
def test_ffmpeg_tier_decodes_on_its_own(wav_path, tmp_path):
    m4a = _encode(wav_path, tmp_path / "tone.m4a", "-c:a", "aac")
    decoded = audio_io._ffmpeg_decode(m4a)
    assert decoded is not None
    y, sr = decoded
    assert y.ndim == 2 and y.shape[1] == 2 and sr == 22050


def test_ffmpeg_tier_returns_none_for_rubbish(tmp_path):
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"not audio" * 5000)
    assert audio_io._ffmpeg_decode(junk) is None


def test_undecodable_file_raises_something_actionable(tmp_path):
    """Not libsndfile's "File does not exist", which sent me looking for a missing file."""
    junk = tmp_path / "broken.mp3"
    junk.write_bytes(b"\x00" * 200_000)
    with pytest.raises(RuntimeError, match="could not decode"):
        audio_io.load_stereo(junk)


def test_duration_matches_the_decoded_length(wav_path):
    y, sr = audio_io.load_stereo(wav_path)
    assert audio_io.duration_of(wav_path) == pytest.approx(len(y) / sr, abs=0.01)


@needs_ffmpeg
def test_decoded_audio_matches_across_formats(wav_path, tmp_path):
    """A lossy round trip should still line up with the original, not be silence."""
    m4a = _encode(wav_path, tmp_path / "tone.m4a", "-c:a", "aac", "-b:a", "192k")
    original, _ = audio_io.load_stereo(wav_path)
    decoded, _ = audio_io.load_stereo(m4a)
    n = min(len(original), len(decoded))
    assert n > 1000
    assert float(np.abs(decoded[:n]).max()) > 0.1, "decoded to near-silence"
    a = audio_io.to_mono(original[:n])
    b = audio_io.to_mono(decoded[:n])
    corr = float(np.corrcoef(a, b)[0, 1])
    assert corr > 0.5, f"decoded audio does not match the source (r={corr:.2f})"


def test_load_audio_shares_the_hardened_path(wav_path):
    """load_audio must not call librosa directly: that path silently short-decodes."""
    mono, sr = audio_io.load_audio(wav_path, mono=True)
    assert mono.ndim == 1 and sr == 22050
    stereo, _ = audio_io.load_audio(wav_path, mono=False)
    assert stereo.ndim == 2 and stereo.shape[0] == 2, "non-mono is (channels, samples)"
    assert len(mono) == stereo.shape[1]


def test_load_audio_resamples_only_when_asked(wav_path):
    y_native, sr_native = audio_io.load_audio(wav_path)
    assert sr_native == 22050
    y_down, sr_down = audio_io.load_audio(wav_path, sr=16000)
    assert sr_down == 16000
    assert len(y_down) == pytest.approx(len(y_native) * 16000 / 22050, rel=0.01)


@needs_ffmpeg
def test_load_audio_decodes_the_reported_failure(wav_path, tmp_path):
    m4a = _encode(wav_path, tmp_path / "real.m4a", "-c:a", "aac", "-b:a", "128k", "-ar", "22050")
    fake = tmp_path / "charli.mp3"
    shutil.copy(m4a, fake)
    y, sr = audio_io.load_audio(fake, mono=True)
    # the whole point: not a 15 ms fragment
    assert len(y) / sr == pytest.approx(2.0, abs=0.2)
