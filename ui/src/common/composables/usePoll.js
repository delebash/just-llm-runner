// SPDX-License-Identifier: GPL-3.0-or-later
// A single-interval poller shared by the runner panels (model catalog, engine
// install). `start()` runs `fn` every `intervalMs`; a second `start()` while
// already running is a no-op; `stop()` clears it; it auto-stops on unmount. One
// home so the interval guards can't drift between components.
import { onUnmounted } from "vue";

export function usePoll(fn, intervalMs = 1000) {
  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(fn, intervalMs);
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  onUnmounted(stop);
  return { start, stop };
}
