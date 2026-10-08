// SPDX-License-Identifier: MIT
// Python's logging, as small as the kit uses it: `getLogger(name)` with debug / info /
// warning / error / exception, one level threshold and a set of sinks. logs_api adds the
// memory ring and the daily file as sinks; with no sink a record goes nowhere unless
// LLM_RUNNER_LOG_STDERR is set (tests stay quiet).

export const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };
export const LEVEL_NAMES = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v, k]));
const sinks = new Set();
let threshold = LEVELS.INFO;

export function setLevel(name) {
  threshold = typeof name === "number" ? name : (LEVELS[String(name).toUpperCase()] ?? LEVELS.INFO);
}
export const getLevel = () => threshold;

/** Add a sink `(record) => void`; returns its remover. */
export function addSink(fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

function emit(name, levelno, msg, err) {
  if (levelno < threshold) return;
  const record = {
    name,
    levelno,
    levelname: LEVEL_NAMES[levelno] || `Level ${levelno}`,
    msg: String(msg),
    created: Date.now() / 1000,
    exc: err ? String(err?.stack || err) : null,
  };
  for (const s of sinks) {
    try {
      s(record);
    } catch {
      /* a sink must never break the caller */
    }
  }
  if (!sinks.size && process.env.LLM_RUNNER_LOG_STDERR) {
    process.stderr.write(`${record.levelname} ${name}: ${record.msg}${record.exc ? `\n${record.exc}` : ""}\n`);
  }
}

const loggers = new Map();
/** logging.getLogger(name). `exception(msg, err)` is an ERROR carrying the error's stack. */
export function getLogger(name) {
  let l = loggers.get(name);
  if (!l) {
    l = {
      name,
      debug: (m) => emit(name, LEVELS.DEBUG, m),
      info: (m) => emit(name, LEVELS.INFO, m),
      warning: (m, err) => emit(name, LEVELS.WARNING, m, err),
      warn: (m, err) => emit(name, LEVELS.WARNING, m, err),
      error: (m, err) => emit(name, LEVELS.ERROR, m, err),
      exception: (m, err) => emit(name, LEVELS.ERROR, m, err),
      log: (levelno, m, err) => emit(name, levelno, m, err),
    };
    loggers.set(name, l);
  }
  return l;
}
