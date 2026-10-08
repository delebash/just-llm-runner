// SPDX-License-Identifier: MIT
// The model catalog's wire model — from llm/model_catalog_api.py (`CatalogRow` only, the
// one the stores use). The router (`makeModelCatalogRouter`) and the rest of the module's
// models are ported in wave 2.
//
// The downloadable llama.cpp model catalog lives in the host DB so users can add/edit/
// curate without re-shipping. `builtIn` marks seeded rows; reset = restore factory values
// for seeded keys, preserve user-added rows.

import { nullable, opt, T } from "../platform/models.js";

/** One downloadable llama.cpp model — catalog fields only. */
export const CatalogRow = T.Object({
  id: T.String(),
  name: opt(T.String(), ""),
  hfRepo: opt(T.String(), ""),
  quant: opt(T.String(), ""),
  mmproj: opt(nullable(T.String()), null),
  totalParams: opt(T.String(), ""),
  activeParams: opt(T.String(), ""),
  // MTP ENABLED/intent — the user-facing "use MTP" flag (checkbox + grid badge +
  // switch_resolve's auto-mtp layer). Seed/user-owned; identity NEVER writes it.
  mtp: opt(T.Boolean(), false),
  // MTP BUILT-IN — header `nextn_predict_layers>0` (Qwen/GLM in-file heads). Written only
  // by the GGUF identity read; read-only display + auto-detect provenance. A Gemma
  // external-draft model is mtpBuiltin=false yet can still be mtp=true.
  mtpBuiltin: opt(T.Boolean(), false),
  type: opt(T.String(), "dense"), // dense | moe — drives which switch preset applies (§6.5)
  // Gemma-style SEPARATE MTP draft file — facts about the model, feeds --model-draft at
  // load (Plan B, D7). "" everywhere = no external draft (Qwen builds MTP in).
  mtpDraftRepo: opt(T.String(), ""), // "" = the draft lives in the SAME repo as hfRepo
  mtpDraftFile: opt(T.String(), ""), // exact path within the repo (e.g. "MTP/…-Q4_0-MTP.gguf")
  mtpDraftQuant: opt(T.String(), ""), // display/selection metadata; the file path is authoritative
  trainedCtx: opt(nullable(T.Integer()), null), // GGUF `<arch>.context_length`, file-derived (null until read)
  samplers: opt(T.Record(T.String(), T.String()), {}), // file-derived recommended samplers (read-only)
  minVramMb: opt(nullable(T.Integer()), null),
  minRamMb: opt(nullable(T.Integer()), null),
  tier: opt(T.String(), "mid"), // cpu | low-vram-moe | mid | high | high-ram
  license: opt(T.String(), ""), // SPDX id (Apache-2.0 | MIT | Llama-Community | …); "" = unknown
  useLimited: opt(T.Boolean(), false), // not free for unrestricted/commercial use → the ⚠ badge (DB-stored)
  embedding: opt(T.Boolean(), false), // an embedding model (RAG index), not a chat LLM — explicit editable flag
  pooling: opt(T.String(), ""), // embedding pooling: "" | mean | cls | last | rank (intrinsic per-model)
  qualityRank: opt(T.Integer(), 100), // curated overall-quality order (LOWER = better); 100 = unranked
  // FILE/LINK-OWNED since 2026-07-07 (user decree): Read-from-link regenerates it.
  description: opt(T.String(), ""),
  // The user's OWN notes — persistent, never written by read/download/backfill/seed.
  notes: opt(T.String(), ""),
  // File-derived identity facts (#141 — persisted so Edit-open == Read-from-link):
  architecture: opt(T.String(), ""), // e.g. "gemma4"
  experts: opt(T.Integer(), 0), // MoE expert count (0 = dense)
  sizeLabel: opt(T.String(), ""), // e.g. "128x2.6B" / "27B"
  sizeBytes: opt(nullable(T.Integer()), null), // the GGUF file size — QUANT-SPECIFIC (cleared on quant change)
  // Pre-download VRAM estimate (full GPU · 8K ctx) — persisted so Edit-open shows the
  // same "≈ N MB VRAM" line Read-from-link does; null until a header read.
  estVramMb: opt(nullable(T.Integer()), null),
  // The physics FACTS (fit-redesign §13.11): immutable file properties the floors/est/
  // badge are computed FRESH from. Filled by inspect / download / seed refresh; null =
  // header never read (fidelity falls back). Snake keys ON PURPOSE — they mirror the DB
  // columns 1:1 through one dict.
  physicsFacts: opt(nullable(T.Record(T.String(), T.Number())), null),
  position: opt(T.Integer(), 0),
  builtIn: opt(T.Boolean(), false),
});
