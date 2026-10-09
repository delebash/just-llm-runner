// SPDX-License-Identifier: MIT
// Edit the bundled llama.cpp engine config — the port of llm/runner_config_api.py: the
// per-(platform, gpu) download URLs, the pinned build, the VRAM safety margin, and the two
// router residency knobs (`models_max` = how many models stay co-resident;
// `sleep_idle_seconds` = the idle-unload TTL, 0 = never). Config is data (DB-backed, seeded),
// so if a release asset ever moves/renames the user can paste the corrected URL from the
// llama.cpp releases page with no code change. GET/PUT + reset on `/v1/ai/engine-config`.
//
// The GET serves the same data as the runner's read-only `/v1/llm-runner/config` (flattened
// for the editor); the runner reads its live config from the same DB rows via
// `buildRunnerConfig()`.

import { Hono } from "hono";
import { HttpError } from "../platform/errors.js";
import { model, nullable, opt, T } from "../platform/models.js";
import { pyInt } from "../platform/py.js";
import { pyFloat } from "../platform/pyjson.js";
import { input } from "../platform/server.js";
import { MAX_DOWNLOAD_CONCURRENT, MAX_DOWNLOAD_SEGMENT_COUNT, MAX_DOWNLOAD_SEGMENT_RETRIES } from "../runner/config.js";

export const RunnerBinaryRow = T.Object({
  platform: T.String(),
  gpu: T.String(),
  source: opt(T.String(), "github"), // "github" | "docker"
  assetUrl: opt(nullable(T.String()), null),
  runtimeUrl: opt(nullable(T.String()), null), // companion (cudart DLLs) unpacked alongside
  image: opt(nullable(T.String()), null), // docker source only
  serverExe: opt(T.String(), "llama-server"),
});

export const EngineConfig = T.Object({
  pinnedBuild: T.String(),
  safetyMarginMb: T.Integer(),
  // Computed-ctx cap for untuned launches (fit-redesign §8.1): min() ceiling, never a
  // pin; explicit ctx from a tune/preset/request always overrides. 0 = off.
  ctxCapTokens: opt(T.Integer(), 32768),
  // Fit-redesign Phase 3 (§8.14 + §13.17 as amended): the speed-band tok/s thresholds and
  // the RAM-headroom floor fact — edited in the Loaded-models knobs group.
  bandFastToks: opt(T.Number(), 20.0),
  bandFineToks: opt(T.Number(), 8.0),
  bandSlowToks: opt(T.Number(), 2.0),
  // Speed-truth plan §5 — a prediction within this fraction of a threshold shows its
  // number instead of a band word.
  bandDeadzoneFrac: opt(T.Number(), 0.1),
  // Speed-truth plan §7 — the fallback pick's floor = bandFineToks × (1 − this).
  speedFloorGrace: opt(T.Number(), 0.2),
  // Speed-truth plan §6 — the one-minute speed check's test model: where it downloads
  // from, its sha256, size, and the two byte facts of THAT file.
  calibModelUrl: opt(T.String(), ""),
  calibModelSha256: opt(T.String(), ""),
  calibModelSizeBytes: opt(T.Integer(), 0),
  calibActiveExpertMb: opt(T.Number(), 0.0),
  calibNonexpertMb: opt(T.Number(), 0.0),
  ramHeadroomMb: opt(T.Integer(), 4096),
  modelsMax: T.Integer(), // router: how many models may stay co-resident (>= 1)
  sleepIdleSeconds: T.Integer(), // router: idle-unload TTL in seconds (0 = never)
  // Segmented downloads (DL-2): N parallel byte-ranges per file.
  downloadSegmentsEnabled: opt(T.Boolean(), true),
  downloadSegmentCount: opt(T.Integer(), 8), // keep in step with config.DEFAULT_DOWNLOAD_SEGMENT_COUNT
  downloadSegmentMinBytes: opt(T.Integer(), 64 * 1024 * 1024), // RETIRED/inert; kept for back-compat
  downloadSegmentRetries: opt(T.Integer(), 3),
  downloadMaxConcurrent: opt(T.Integer(), 4), // CONCURRENT model downloads (2026-07-20)
  // "off" | "notify". Notify = the UI surfaces "update available" and the bump is a
  // deliberate click; NEVER auto-applied — the pin is a VERIFIED pin.
  updatePolicy: opt(T.String(), "notify"),
  // The last "gpu-name|vramMb" fingerprint the UI acknowledged — the hardware-change
  // toast fires ONCE per real gpu/vram change. "" = never seen.
  ackHwFingerprint: opt(T.String(), ""),
  // Acceleration-backend override: the GPU FAMILY the user pinned ("cuda" | "vulkan" |
  // "rocm" | "metal"; "" = Auto / hardware order).
  preferredGpu: opt(T.String(), ""),
  // Hardware-class override (§9): the class key the box FILES UNDER ("" = auto-detect).
  // "Detection proposes, never dictates" — a wrong sensor costs one setting.
  classKeyOverride: opt(T.String(), ""),
  // Warm the default local chat model into VRAM on app startup. The CLIENT gates the
  // actual warm; this flag is the user's on/off master.
  warmDefaultOnStartup: opt(T.Boolean(), true),
  binaries: T.Array(RunnerBinaryRow),
});

export const EngineConfigUpdate = T.Object({
  pinnedBuild: opt(nullable(T.String()), null),
  updatePolicy: opt(nullable(T.String()), null), // "off" | "notify"
  ackHwFingerprint: opt(nullable(T.String()), null), // the acknowledged gpu|vram fingerprint (Task E)
  preferredGpu: opt(nullable(T.String()), null), // backend override family ("" = Auto; cuda|vulkan|rocm|metal)
  classKeyOverride: opt(nullable(T.String()), null), // hardware-class override ("" = auto-detect; free text)
  safetyMarginMb: opt(nullable(T.Integer()), null),
  ctxCapTokens: opt(nullable(T.Integer()), null),
  bandFastToks: opt(nullable(T.Number()), null),
  bandFineToks: opt(nullable(T.Number()), null),
  bandSlowToks: opt(nullable(T.Number()), null),
  bandDeadzoneFrac: opt(nullable(T.Number()), null),
  speedFloorGrace: opt(nullable(T.Number()), null),
  calibModelUrl: opt(nullable(T.String()), null),
  calibModelSha256: opt(nullable(T.String()), null),
  calibModelSizeBytes: opt(nullable(T.Integer()), null),
  calibActiveExpertMb: opt(nullable(T.Number()), null),
  calibNonexpertMb: opt(nullable(T.Number()), null),
  ramHeadroomMb: opt(nullable(T.Integer()), null),
  modelsMax: opt(nullable(T.Integer()), null),
  sleepIdleSeconds: opt(nullable(T.Integer()), null),
  downloadSegmentsEnabled: opt(nullable(T.Boolean()), null),
  downloadSegmentCount: opt(nullable(T.Integer()), null),
  downloadSegmentMinBytes: opt(nullable(T.Integer()), null),
  downloadSegmentRetries: opt(nullable(T.Integer()), null),
  downloadMaxConcurrent: opt(nullable(T.Integer()), null),
  warmDefaultOnStartup: opt(nullable(T.Boolean()), null), // warm the default local chat model into VRAM on startup
  binaries: opt(nullable(T.Array(RunnerBinaryRow)), null), // each upserted by (platform, gpu)
});

const strip = (s) => String(s ?? "").trim();
// Python's min/max return the FIRST of equals; for these numbers that only shows on ±0.
const pyMax2 = (a, b) => (b > a ? b : a);
const pyMin2 = (a, b) => (b < a ? b : a);
/** `str(int(x))` / `str(float(x))` as Python writes them into the setting row. */
const intText = (x) => String(pyInt(x));
const floatText = (x) => pyFloat(Number(x));

/** `getStore()` → {getConfig(), upsertBinary(row), setSetting(key, value),
 * resetToDefaults()} — the host's runner_binary + runner_setting persistence. */
export function makeRunnerConfigRouter(getStore) {
  const app = new Hono();
  app.get("/v1/ai/engine-config", async (c) => c.json(model(EngineConfig, getStore().getConfig())));

  app.put("/v1/ai/engine-config", input({ body: EngineConfigUpdate }), async (c) => {
    const body = model(EngineConfigUpdate, c.req.valid("json"));
    const store = getStore();
    if (body.pinnedBuild != null) {
      const pb = strip(body.pinnedBuild);
      if (!pb) throw new HttpError(400, "pinnedBuild cannot be blank");
      store.setSetting("pinned_build", pb);
    }
    if (body.updatePolicy != null) {
      const up = strip(body.updatePolicy).toLowerCase();
      if (!["off", "notify"].includes(up)) throw new HttpError(400, "updatePolicy must be 'off' or 'notify'");
      store.setSetting("update_policy", up);
    }
    if (body.ackHwFingerprint != null) store.setSetting("ack_hw_fingerprint", strip(body.ackHwFingerprint));
    if (body.preferredGpu != null) {
      const pg = strip(body.preferredGpu).toLowerCase();
      if (!["", "cuda", "vulkan", "rocm", "metal"].includes(pg)) {
        throw new HttpError(400, "preferredGpu must be blank (Auto) or one of: cuda, vulkan, rocm, metal");
      }
      store.setSetting("preferred_gpu", pg);
    }
    if (body.classKeyOverride != null) {
      // Free text, trimmed — the class-tunes library accepts free-typed keys (class-tunes
      // PUT), so the override does too; "" = auto-detect.
      store.setSetting("class_key_override", strip(body.classKeyOverride));
    }
    if (body.safetyMarginMb != null) store.setSetting("safety_margin_mb", intText(body.safetyMarginMb));
    if (body.ctxCapTokens != null) store.setSetting("ctx_cap_tokens", intText(pyMax2(0, pyInt(body.ctxCapTokens))));
    // Phase 3 (§8.14/§13.17): band thresholds are tok/s minimums — floored at 0; ordering
    // (fast ≥ fine ≥ slow) is NOT enforced here (the band mapper walks top-down, so a
    // crossed pair just merges bands — harmless), the user's number is kept as typed.
    if (body.bandFastToks != null) store.setSetting("band_fast_toks", floatText(pyMax2(0.0, Number(body.bandFastToks))));
    if (body.bandFineToks != null) store.setSetting("band_fine_toks", floatText(pyMax2(0.0, Number(body.bandFineToks))));
    if (body.bandSlowToks != null) store.setSetting("band_slow_toks", floatText(pyMax2(0.0, Number(body.bandSlowToks))));
    // A fraction: clamped to [0, 0.5] — 0 turns the dead zone off; past 0.5 the zones
    // around fine and slow would swallow the whole scale.
    if (body.bandDeadzoneFrac != null) {
      store.setSetting("band_deadzone_frac", floatText(pyMin2(0.5, pyMax2(0.0, Number(body.bandDeadzoneFrac)))));
    }
    // A fraction of the fine line: [0, 0.9] — 0 = a hard floor at band_fine_toks.
    if (body.speedFloorGrace != null) {
      store.setSetting("speed_floor_grace", floatText(pyMin2(0.9, pyMax2(0.0, Number(body.speedFloorGrace)))));
    }
    // The speed check's test model. The sha is checked after every download, so a
    // malformed one would make the check fail forever — refuse it here instead.
    if (body.calibModelUrl != null) {
      const url = strip(body.calibModelUrl);
      if (url && !(url.startsWith("https://") || url.startsWith("http://"))) {
        throw new HttpError(400, "calibModelUrl must be an http(s) URL");
      }
      store.setSetting("calib_model_url", url);
    }
    if (body.calibModelSha256 != null) {
      const sha = strip(body.calibModelSha256).toLowerCase();
      if (sha.length !== 64 || [...sha].some((c) => !"0123456789abcdef".includes(c))) {
        throw new HttpError(400, "calibModelSha256 must be 64 hex characters");
      }
      store.setSetting("calib_model_sha256", sha);
    }
    if (body.calibModelSizeBytes != null) {
      store.setSetting("calib_model_size_bytes", intText(pyMax2(0, pyInt(body.calibModelSizeBytes))));
    }
    if (body.calibActiveExpertMb != null) {
      store.setSetting("calib_active_expert_mb", floatText(pyMax2(0.0, Number(body.calibActiveExpertMb))));
    }
    if (body.calibNonexpertMb != null) {
      store.setSetting("calib_nonexpert_mb", floatText(pyMax2(0.0, Number(body.calibNonexpertMb))));
    }
    if (body.ramHeadroomMb != null) store.setSetting("ram_headroom_mb", intText(pyMax2(0, pyInt(body.ramHeadroomMb))));
    if (body.modelsMax != null) store.setSetting("models_max", intText(pyMax2(1, pyInt(body.modelsMax))));
    if (body.sleepIdleSeconds != null) {
      store.setSetting("sleep_idle_seconds", intText(pyMax2(0, pyInt(body.sleepIdleSeconds))));
    }
    if (body.downloadSegmentsEnabled != null) {
      store.setSetting("download_segments_enabled", body.downloadSegmentsEnabled ? "1" : "0");
    }
    if (body.downloadSegmentCount != null) {
      // #10 (2026-07-17): clamp to [1, MAX] — a bare "20" spawned 20 parallel Range
      // requests; >~8 only loads the CDN, no speed. saveKnobs re-reads the returned config,
      // so the field snaps back to the clamped value the user sees.
      store.setSetting(
        "download_segment_count",
        intText(pyMax2(1, pyMin2(MAX_DOWNLOAD_SEGMENT_COUNT, pyInt(body.downloadSegmentCount)))),
      );
    }
    if (body.downloadSegmentMinBytes != null) {
      // RETIRED/inert (the downloader falls back to single-stream itself) — still accepted
      // + persisted so an existing UI/DB round-trips without a 422; nothing reads it.
      store.setSetting("download_segment_min_bytes", intText(pyMax2(0, pyInt(body.downloadSegmentMinBytes))));
    }
    if (body.downloadSegmentRetries != null) {
      store.setSetting(
        "download_segment_retries",
        intText(pyMax2(0, pyMin2(MAX_DOWNLOAD_SEGMENT_RETRIES, pyInt(body.downloadSegmentRetries)))),
      );
    }
    if (body.downloadMaxConcurrent != null) {
      // Clamp to [1, MAX] — the same ONE-source belt as the segment knobs; the lifecycle
      // gate re-clamps on read too, so a raw DB poke can't spawn more than MAX parallel
      // downloads.
      store.setSetting(
        "download_max_concurrent",
        intText(pyMax2(1, pyMin2(MAX_DOWNLOAD_CONCURRENT, pyInt(body.downloadMaxConcurrent)))),
      );
    }
    if (body.warmDefaultOnStartup != null) {
      store.setSetting("warm_default_on_startup", body.warmDefaultOnStartup ? "1" : "0");
    }
    for (const row of body.binaries || []) {
      if (!strip(row.platform) || !strip(row.gpu)) throw new HttpError(400, "each binary needs platform + gpu");
      // The URL must be CONCRETE — a `{…}` placeholder never composes to a real asset and
      // would 404 at install time (the pin drives the URL; the UI re-points it on a pin
      // change). Reject it at the save boundary so a bad row can't reach the DB.
      for (const [label, val] of [
        ["assetUrl", row.assetUrl],
        ["runtimeUrl", row.runtimeUrl],
      ]) {
        if (val && (val.includes("{") || val.includes("}"))) {
          throw new HttpError(400, `${row.platform}/${row.gpu} ${label} still has a placeholder: ${val}`);
        }
      }
      store.upsertBinary(row);
    }
    return c.json(model(EngineConfig, store.getConfig()));
  });

  app.post("/v1/ai/engine-config/reset", async (c) => {
    const store = getStore();
    store.resetToDefaults();
    return c.json(model(EngineConfig, store.getConfig()));
  });
  return app;
}
