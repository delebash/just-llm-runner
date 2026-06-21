# SPDX-License-Identifier: GPL-3.0-or-later
"""The local llama.cpp runner subsystem — hardware detection, prebuilt-binary
acquisition, GGUF download/metadata, VRAM-fit, runner lifecycle/spawn, and the
mountable runner router.

Sibling to `llm_runner.llm` (the cloud-provider + dispatch + prompt layer). The
package root (`llm_runner/__init__.py`) re-exports this subsystem's public names,
so consumers keep importing `from llm_runner import router, detect, …`.
"""
