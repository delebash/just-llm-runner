// SPDX-License-Identifier: MIT
// Online-provider model-list cleanup — the config-driven ruleset (the port of
// llm/model_list_rules.py, #8, 2026-07-20).
//
// An online provider's `/v1/models` dump is mostly noise for a writing/voice app: OpenAI
// returns 400+ ids (image / realtime / audio / tts / whisper / moderation / legacy chat),
// Gemini returns imagen / veo / lyria / tts / image variants. The app uses ONLY chat +
// embedding models. This module classifies + prunes that list by DATA (per-provider-TYPE
// rules), never hardcoded logic.
//
// THE AGING CONTRACT (read before editing the seeds):
//   • The DESIGNED failure mode is UNDER-filtering: when a provider ships a NEW noise
//     family the seeds don't know yet, its ids appear as noise until the seed updates.
//     That is acceptable and self-healing (a seed bump reaches unmodified installs).
//   • OVER-filtering must be impossible BY ACCIDENT. Every drop is an ANCHORED regex with
//     a deliberate boundary — there is NO bare-prefix mechanism. A prefix "gpt-4" would
//     silently swallow a future flagship "gpt-45"; `^gpt-4($|[.o-])` drops the gpt-4/4o
//     legacy family and spares "gpt-45"/"gpt-5". A user's escape hatches are always
//     present: `?all=1` (show everything), free-text model entry, and editable rules.
//   • OpenAI's list endpoint carries NO capability metadata, so NAME rules are the only
//     tool there. Gemini stays metadata-first (its adapter's D7 `supportedActions`
//     filter drops veo/imagen/lyria/aqa before these rules ever run); the name rules
//     below only prune the residue Google still tags as generateContent/embedContent.
//
// The rules are ONE seeded JSON document ("model_list_rules") in the runner-settings store
// (stores.getModelListRules / seed.seedModelListRules), GET/PUT-editable at
// /v1/ai/model-list-rules. Rules are keyed by provider TYPE; per-INSTANCE overrides are
// out of scope for now.
//
// The patterns are PYTHON regexes (stored, user-editable): `pyRegex` below compiles them
// with Python's meaning.

import { getLogger } from "../platform/log.js";
import { B, NOT_W, pyMax, strRepr, W } from "../platform/py.js";

const log = getLogger("llm_runner.llm.model_list_rules");

// Bump this when the seed rules below change so an UNMODIFIED stored doc refreshes to the
// new seed on the next boot (seed.seedModelListRules); a user-edited doc is kept.
export const SEED_VERSION = 1;

// Per-provider-TYPE rules. Anchored regexes ONLY (no bare prefixes — see above).
// `embedPatterns` re-buckets an id as an EMBEDDING model; `dropPatterns` hides it;
// `collapseDated` folds `-YYYY-MM-DD` snapshots under their bare alias.
export const SEED_RULES = {
  openai: {
    collapseDated: true,
    embedPatterns: ["^text-embedding-"],
    dropPatterns: [
      // legacy chat generations — anchored so gpt-5+/gpt-45 survive; o-series KEPT
      // (reasoning models, they match none of these).
      "^gpt-3\\.5",
      "^gpt-4($|[.o-])",
      "^chatgpt-",
      // non-chat families: image / realtime / audio / tts / transcription / moderation /
      // video / tools / legacy completions.
      "^gpt-image",
      "^gpt-live",
      "^gpt-realtime",
      "^gpt-audio",
      "^sora",
      "^dall-e",
      "^tts-",
      "^whisper",
      "^omni-moderation",
      "^text-moderation",
      "^computer-use",
      "^davinci",
      "^babbage",
      // preview / instant snapshots of any family
      "-preview(-|$)",
      "-instant(-|$)",
    ],
  },
  gemini: {
    // Gemini ships new models PREVIEW-first (a 3.5 Pro lands as -preview before GA), so a
    // blanket -preview drop would hide the NEWEST model — deliberately absent.
    collapseDated: false,
    embedPatterns: ["^text-embedding-", "^embedding-", "^gemini-embedding-"],
    dropPatterns: [
      "^imagen-",
      "^veo-",
      "^lyria-",
      "^aqa$",
      "^learnlm-",
      "^gemini-1\\.0",
      "^gemini-1\\.5",
      "^gemini-2\\.0", // 2.0 retired 2026-06
      "-tts(-|$)",
      "-live(-|$)",
      "-image(-|$)",
      "-exp(-|$)",
    ],
  },
  // Anthropic's list endpoint is already curated/clean; it exposes no embeddings.
  anthropic: { collapseDated: false, embedPatterns: [], dropPatterns: [] },
  // openai-compat is the BYO universe (LM Studio / OpenRouter-compat / vLLM / a
  // self-hosted box): the id space is unknowable, so drop NOTHING (over-filter-safe) and
  // only keep the /embed/i split so an embedding model still lands in the embed bucket.
  // Users edit these per install.
  "openai-compat": { collapseDated: false, embedPatterns: ["embed"], dropPatterns: [] },
  // The other metered-cloud types: no drops seeded (their lists are already close to
  // chat-only) — under-filter until a seed says otherwise; classify embeddings only.
  deepseek: { collapseDated: false, embedPatterns: ["embed"], dropPatterns: [] },
  openrouter: { collapseDated: false, embedPatterns: ["embed"], dropPatterns: [] },
  xai: { collapseDated: false, embedPatterns: ["embed"], dropPatterns: [] },
  mistral: { collapseDated: false, embedPatterns: ["embed"], dropPatterns: [] },
};

/** The factory rules document — {seedVersion, rules}. A deep copy, so a caller (the
 * store, a reset) can never mutate the module seed. */
export function seedDoc() {
  return { seedVersion: SEED_VERSION, rules: structuredClone(SEED_RULES) };
}

/** Python's FilterResult dataclass: chat ids (post drop + dated-collapse), embedding ids,
 * and hidden_count = raw − shown (drops + snapshots folded under an alias). */
export function FilterResult({ models, embeddings, hidden_count }) {
  return { models, embeddings, hidden_count };
}

const DATED = /-\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u; // Python's \d is Unicode on str
const warnedPatterns = new Set();

// ── Python regex → JavaScript (candidate for platform/py.js) ─────────────────
const W_INNER = W.slice(1, -1);
const NOT_B = `(?:(?<=${W})(?=${W})|(?<!${W})(?!${W}))`;
// Python's \s on str = str.isspace(): it has \x1c-\x1f and \x85, JavaScript's has ﻿.
const S_INNER = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);
// The letter escapes Python's `re` knows (any other is "bad escape" — an invalid pattern).
const PY_LETTER_ESCAPES = new Set([..."abBdDfnrsStvwWxuUAZ"]);

/**
 * Compile a Python `re` pattern (str) with Python's meaning: `\d \D \w \W \s \S \b \B` as
 * Python reads them on str (Unicode), `.` not matching only "\n", `$` also matching
 * before a final "\n", `(?P<n>…)` / `(?P=n)` named groups, `(?#…)` comments, leading
 * global flags `(?ims)`, `\A` / `\Z` / `\a` / `\U…`, `{,n}`, and the lone `{ } ]` and
 * punctuation escapes Python accepts but a `u`-flag JavaScript pattern rejects. A
 * construct this doesn't translate (verbose mode, possessive quantifiers, conditionals,
 * `\S` inside a class, …) throws SyntaxError, as does a pattern Python itself rejects.
 */
export function pyRegex(pattern) {
  let p = String(pattern);
  let flags = "u";
  const lead = /^\(\?([aiLmsux]+)\)/.exec(p);
  if (lead) {
    for (const f of lead[1]) {
      if (f === "i" || f === "m" || f === "s") flags += f;
      else if (f !== "u") throw new SyntaxError(`unsupported inline flag ${f}`);
    }
    p = p.slice(lead[0].length);
  }
  const multiline = flags.includes("m");
  const dotall = flags.includes("s");
  let out = "";
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      const n = p[i + 1];
      if (n === undefined) throw new SyntaxError("bad escape (end of pattern)");
      i++;
      if (/[A-Za-z]/.test(n) && !PY_LETTER_ESCAPES.has(n)) throw new SyntaxError(`bad escape \\${n}`);
      if (n === "d") out += "\\p{Nd}";
      else if (n === "D") out += "\\P{Nd}";
      else if (n === "w") out += inClass ? W_INNER : W;
      else if (n === "s") out += inClass ? S_INNER : `[${S_INNER}]`;
      else if (n === "W" || n === "S") {
        if (inClass) throw new SyntaxError(`\\${n} inside a class is not translated`);
        out += n === "W" ? NOT_W : `[^${S_INNER}]`;
      } else if (n === "b") out += inClass ? "\\x08" : B;
      else if (n === "B") out += NOT_B;
      else if (n === "A") out += "(?<![\\s\\S])";
      else if (n === "Z") out += "(?![\\s\\S])";
      else if (n === "a") out += "\\x07";
      else if (n === "U") {
        const hex = p.slice(i + 1, i + 9);
        if (!/^[0-9A-Fa-f]{8}$/.test(hex)) throw new SyntaxError("incomplete escape \\U");
        out += `\\u{${hex}}`;
        i += 8;
      } else if (/[0-9A-Za-z]/.test(n)) out += `\\${n}`; // \n \t \f \v \r \x.. \u.... \1 …
      else if (SYNTAX.has(n) || (inClass && n === "-")) out += `\\${n}`;
      else out += n; // Python accepts `\#`, `\-` …; a u-flag pattern rejects them
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      else if (c === "[") {
        out += "\\["; // a literal in Python (it only warns)
        continue;
      }
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      if (p[i + 1] === "^") out += p[++i];
      if (p[i + 1] === "]") out += `\\${p[++i]}`; // `[]…]`: a leading ] is literal in Python
      continue;
    }
    if (c === ".") {
      out += dotall ? "[\\s\\S]" : "[^\\n]"; // JavaScript's `.` also refuses \r, U+2028, U+2029
      continue;
    }
    if (c === "$") {
      out += multiline ? "(?=\\n|(?![\\s\\S]))" : "(?=\\n?(?![\\s\\S]))";
      continue;
    }
    if (c === "^") {
      out += multiline ? "(?:(?<![\\s\\S])|(?<=\\n))" : "^";
      continue;
    }
    if (c === "(" && p.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
      continue;
    }
    if (c === "(" && p.startsWith("(?P=", i)) {
      const end = p.indexOf(")", i);
      if (end < 0) throw new SyntaxError("bad backreference");
      out += `\\k<${p.slice(i + 4, end)}>`;
      i = end;
      continue;
    }
    if (c === "(" && p.startsWith("(?#", i)) {
      const end = p.indexOf(")", i);
      if (end < 0) throw new SyntaxError("unterminated comment");
      i = end;
      continue;
    }
    if (c === "{") {
      const q = /^\{(\d*)(,?)(\d*)\}/.exec(p.slice(i));
      if (q && (q[1] || q[2])) {
        out += `{${q[1] || "0"}${q[2]}${q[3]}}`; // Python's {,n} = {0,n} and {,} = {0,}
        i += q[0].length - 1;
      } else out += "\\{"; // not a quantifier (incl. `{}`) → a literal brace in Python
      continue;
    }
    if (c === "}" || c === "]") {
      out += `\\${c}`;
      continue;
    }
    out += c;
  }
  if (inClass) throw new SyntaxError("unterminated character set");
  return new RegExp(out, flags);
}

/** Compile user-editable patterns defensively: an invalid regex is SKIPPED (warned once),
 * never a 500 — under-filter beats crashing the picker. (`rx.test` on these flagless
 * RegExps is `re.search` — no lastIndex state.) */
function compile(patterns) {
  const out = [];
  for (const p of patterns || []) {
    try {
      out.push(pyRegex(p));
    } catch (e) {
      if (!warnedPatterns.has(p)) {
        warnedPatterns.add(p);
        log.warning(`model-list-rules: skipping invalid regex ${strRepr(p)} (${e.message})`);
      }
    }
  }
  return out;
}

function dedup(xs) {
  return [...new Set(xs)];
}

/** Fold `-YYYY-MM-DD` snapshots under their bare alias. For each base: emit the bare alias
 * IF it was itself fetched, else the NEWEST dated snapshot verbatim. NEVER emit an id that
 * was not in the fetched list. First-appearance order is kept. */
function collapseDated(ids) {
  const present = new Set(ids);
  const groups = new Map();
  for (const mid of ids) {
    const base = mid.replace(DATED, "");
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(mid);
  }
  const out = [];
  for (const [base, members] of groups) {
    if (present.has(base)) {
      out.push(base); // the bare alias was fetched → prefer it
      continue;
    }
    const dated = members.filter((m) => DATED.test(m));
    // YYYY-MM-DD sorts lexicographically → max() is the newest snapshot.
    out.push(dated.length ? pyMax(dated) : members[0]);
  }
  return out;
}

/**
 * Split a provider's raw model-id list into chat + embedding buckets per `rule` (the
 * provider TYPE's rule, or null = passthrough). `showAll` bypasses every rule (the
 * picker's "show all" escape hatch): everything is returned as chat, nothing hidden.
 * Classification wins over dropping — an id matched as an embedding stays in the embed
 * bucket even if it also matches a drop pattern.
 */
export function applyRules(ids, rule, { showAll = false } = {}) {
  const raw = (ids || []).filter((i) => i);
  if (showAll || !rule || !Object.keys(rule).length) {
    return FilterResult({ models: dedup(raw), embeddings: [], hidden_count: 0 });
  }

  const embedRx = compile(rule.embedPatterns);
  const dropRx = compile(rule.dropPatterns);

  let embeddings = [];
  let chat = [];
  for (const mid of raw) {
    if (embedRx.some((rx) => rx.test(mid))) {
      embeddings.push(mid);
      continue;
    }
    if (dropRx.some((rx) => rx.test(mid))) continue; // hidden noise
    chat.push(mid);
  }

  if (rule.collapseDated) chat = collapseDated(chat);

  embeddings = dedup(embeddings);
  chat = dedup(chat);
  const hidden = dedup(raw).length - chat.length - embeddings.length;
  return FilterResult({ models: chat, embeddings, hidden_count: Math.max(0, hidden) });
}
