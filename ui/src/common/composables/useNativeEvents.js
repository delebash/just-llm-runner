// SPDX-License-Identifier: MIT
// The kit's text fields are Quasar's QInput (docs/plans/2026-10-09-kit-controls-on-quasar.md); before,
// each was the native <input>/<textarea> itself, and a caller's listeners (`@input`, `@change`,
// `@keydown.enter.prevent`, `@blur`…) were the element's own events. QInput handles some of those
// itself — its `input`, `change`, `paste`, `blur` and `focus` replace a caller's, and it emits
// `change` with a string. So a field passes Quasar no listeners and listens on its native element
// instead, with this: every listener in the caller's $attrs, and the field's own re-emitted
// events, get the element's own events, exactly as before. The handler is read when the event
// fires, so an inline handler that closes over a v-for row is always the current one.
//
//   const attrs = useAttrs();                      // with defineOptions({ inheritAttrs: false })
//   useNativeEvents(nativeEl, attrs, { blur: (e) => emit("blur", e) });
//   <QInput v-bind="withoutListeners(attrs)" … />
import { onBeforeUnmount, onUpdated, watch } from "vue";

const LISTENER = /^on[A-Z]/;
const MODIFIERS = ["Capture", "Once", "Passive"];

/** The caller's attributes without its listeners — what goes to the Quasar component. */
export function withoutListeners(attrs) {
  const out = {};
  for (const [key, value] of Object.entries(attrs)) if (!LISTENER.test(key)) out[key] = value;
  return out;
}

/** `onKeydownCapture` → ["keydown", { capture: true }] (Vue's own naming of a listener prop). */
function parse(key) {
  let name = key.slice(2);
  const options = {};
  for (let found = true; found;) {
    found = false;
    for (const mod of MODIFIERS) {
      if (name.endsWith(mod)) {
        options[mod.toLowerCase()] = true;
        name = name.slice(0, -mod.length);
        found = true;
      }
    }
  }
  return [name.charAt(0).toLowerCase() + name.slice(1), options];
}

export function useNativeEvents(elRef, attrs, own = {}) {
  let element = null;
  let bound = new Map(); // attr key | "own:<type>" → [type, fn, options]

  function unbindAll() {
    if (element) for (const [type, fn, options] of bound.values()) element.removeEventListener(type, fn, options);
    bound = new Map();
  }
  function sync() {
    if (!element) return;
    const wanted = new Set();
    for (const key of Object.keys(attrs)) {
      if (!LISTENER.test(key)) continue;
      wanted.add(key);
      if (bound.has(key)) continue;
      const [type, options] = parse(key);
      const fn = (e) => {
        for (const handler of [attrs[key]].flat()) if (typeof handler === "function") handler(e);
      };
      element.addEventListener(type, fn, options);
      bound.set(key, [type, fn, options]);
    }
    for (const [type, handler] of Object.entries(own)) {
      const key = `own:${type}`;
      wanted.add(key);
      if (bound.has(key)) continue;
      element.addEventListener(type, handler);
      bound.set(key, [type, handler, undefined]);
    }
    for (const [key, [type, fn, options]] of bound) {
      if (!wanted.has(key)) {
        element.removeEventListener(type, fn, options);
        bound.delete(key);
      }
    }
  }

  watch(elRef, (el) => {
    unbindAll();
    element = el || null;
    sync();
  }, { flush: "post", immediate: true });
  onUpdated(sync);
  onBeforeUnmount(unbindAll);
}
