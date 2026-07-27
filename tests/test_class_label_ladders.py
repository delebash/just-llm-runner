"""The kit's class-label ladders must equal this repo's.

WHY THIS TEST LIVES HERE, IN PYTHON. `ui/src/classTunes.js` copies three ladders out
of `runner/hardware.py` so it can say what a class key COVERS ("8-11 GB VRAM") instead
of printing only the band's floor. Python stays the only place a key is COMPUTED, so a
drifted copy can mislabel but never misroute — still, the copy has to be pinned, and it
has to be pinned in the repo where the originals change. A guard living in justwrite-app's
vitest would never run for someone editing `hardware.py` and running pytest here, which is
exactly the person who would break it.

Adding a band later (the §22 escape hatch: "a future card class that deserves its own band
adds ONE ladder value") therefore fails HERE, naming the JS file to update.
"""
import re
from pathlib import Path

from llm_runner.runner.hardware import _DGPU_RAM_RUNGS, _VRAM_BANDS

CLASS_TUNES_JS = Path(__file__).resolve().parents[1] / "ui" / "src" / "classTunes.js"


def _js_int_array(source: str, name: str) -> list[int]:
    """Parse `export const NAME = [1, 2, 3];` out of the kit module."""
    m = re.search(rf"export const {name} = \[([^\]]*)\];", source)
    assert m, f"{name} not found in {CLASS_TUNES_JS} — was it renamed or reformatted?"
    values = [int(v) for v in re.findall(r"\d+", m.group(1))]
    # Vacuity guard: a rename/reformat that made the regex match an EMPTY body would
    # otherwise sail through the equality assert below with two empty lists.
    assert values, f"{name} parsed as empty — the guard would compare nothing"
    return values


def test_kit_label_ladders_match_hardware_py():
    assert CLASS_TUNES_JS.is_file(), f"the kit module is missing at {CLASS_TUNES_JS}"
    src = CLASS_TUNES_JS.read_text(encoding="utf-8")

    assert _js_int_array(src, "VRAM_BANDS") == list(_VRAM_BANDS)
    assert _js_int_array(src, "DGPU_RAM_RUNGS") == list(_DGPU_RAM_RUNGS)
    # RAM_LADDER used to be copied into the kit as well, because the RANGE label named the
    # nominal capacities inside a rung ("32 or 48 GB RAM"). That label is gone (2026-07-26,
    # the user ruled the floor form), the JS copy went with it, and only Python still snaps
    # with `_RAM_LADDER` — so there is no second copy left to drift. If a kit label ever
    # needs those capacities again, re-copy the ladder AND restore an assertion here.
    # Match a DECLARATION, not the bare word: the kit's comments still explain why the
    # ladder left, and a substring test flagged that prose as a re-copy on the first run.
    assert not re.search(r"export const RAM_LADDER\s*=", src), (
        "the kit re-declared RAM_LADDER — restore the equality assertion against _RAM_LADDER"
    )
