// SPDX-License-Identifier: MIT
// Starting an external program — always with no console to inherit (the port of
// llm_runner/platform/procs.py; kit register §5).
//
// A child started on Windows without CREATE_NO_WINDOW inherits the server's console; when
// the shell that started the app is gone, that console has no host and Windows can't
// start the child at all (exit 0xC0000142). Node's `windowsHide: true` gives
// CREATE_NO_WINDOW — but libuv sets it only when NO stdio is inherited (an fd handed
// down counts), so every door here pipes the child's output instead of passing a file.
//
// `run` and `checkOutput` are async (Python's blocked a thread); their results keep
// subprocess's names: {args, returncode, stdout, stderr}.

import { spawn } from "node:child_process";
import { FileNotFoundError } from "./py.js";

/** CREATE_NO_WINDOW on Windows (what windowsHide gives with piped stdio), else 0. */
export const NO_CONSOLE = process.platform === "win32" ? 0x08000000 : 0;

/** Windows' "the program could not start" (STATUS_DLL_INIT_FAILED), as an exit code. */
export const CANT_START = 0xc0000142;

export class TimeoutExpired extends Error {
  constructor(cmd, timeout, stdout, stderr) {
    super(`Command '${cmd}' timed out after ${timeout} seconds`);
    this.name = "TimeoutExpired";
    this.cmd = cmd;
    this.timeout = timeout;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class CalledProcessError extends Error {
  constructor(returncode, cmd, output, stderr) {
    super(`Command '${cmd}' returned non-zero exit status ${returncode}.`);
    this.name = "CalledProcessError";
    this.returncode = returncode;
    this.cmd = cmd;
    this.output = output;
    this.stdout = output;
    this.stderr = stderr;
  }
}

/** An exit code as Python reports it (Windows: unsigned 32-bit; a signal: -signo). */
function exitCodeOf(code, signal) {
  if (code != null) return process.platform === "win32" ? code >>> 0 : code;
  const SIG = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return -(SIG[signal] ?? 1);
}

/**
 * `subprocess.Popen` with no console to inherit: a ChildProcess, stdio piped (ignore
 * stdin) unless `opts.stdio` says otherwise — never an inherited fd (see above).
 */
export function popen(argv, opts = {}) {
  const { stdio = ["ignore", "pipe", "pipe"], ...rest } = opts;
  return spawn(argv[0], argv.slice(1), { windowsHide: true, stdio, ...rest });
}

/**
 * `subprocess.run(argv, capture_output=True, …)`, async. Options: `input` (string or
 * Buffer), `timeout` (seconds, as Python's), `cwd`, `env`, `text` (default true: decode
 * as UTF-8; false: Buffers). A program that can't be found throws FileNotFoundError, as
 * Python's does; a timeout kills the child and throws TimeoutExpired.
 */
export function run(argv, { input, timeout, cwd, env, text = true } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        windowsHide: true,
        stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
        cwd,
        env,
      });
    } catch (e) {
      reject(e.code === "ENOENT" ? new FileNotFoundError(`[WinError 2] ${e.message}`) : e);
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    let timer = null;
    let timedOut = false;
    if (timeout != null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout * 1000);
    }
    const decode = (bufs) => {
      const b = Buffer.concat(bufs);
      return text ? b.toString("utf8") : b;
    };
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e.code === "ENOENT" ? new FileNotFoundError(`No such file or directory: '${argv[0]}'`) : e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdout = decode(out);
      const stderr = decode(err);
      if (timedOut) {
        reject(new TimeoutExpired(argv.join(" "), timeout, stdout, stderr));
        return;
      }
      resolve({ args: argv, returncode: exitCodeOf(code, signal), stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
  });
}

/** `subprocess.check_output`: stdout, or CalledProcessError on a non-zero exit. */
export async function checkOutput(argv, opts = {}) {
  const r = await run(argv, opts);
  if (r.returncode !== 0) throw new CalledProcessError(r.returncode, argv.join(" "), r.stdout, r.stderr);
  return r.stdout;
}

/**
 * What a failed run says: the program's own words, or — when it never started — that,
 * rather than a bare Windows code.
 */
export function failed(name, returncode, stderr) {
  if (returncode >>> 0 === CANT_START) return `${name} could not start (Windows error 0xC0000142)`;
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr || "");
  const errText = text.trim().slice(-1500);
  return `${name} failed (exit ${returncode})${errText ? `: ${errText}` : ""}`;
}
