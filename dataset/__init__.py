"""StemFlipper synthetic (audio → parameters) dataset scaffold.

Independent of the app pipeline (PLAN.md): its frontier deps (torchsynth,
dasp-pytorch, datasets) live in ``dataset/requirements.txt`` and are deliberately
kept OUT of the app's ``requirements.txt`` so the deployed Space never installs
them. Publish the generator + seeds, not terabytes of audio.
"""

from . import build, effects_gen, synth_gen  # noqa: F401
