// SPDX-License-Identifier: GPL-3.0-or-later
// Shared task-label resolver — map a taskKind id → its user-facing label. Used by every
// AI view (FeatureWorkbench, TaskKinds) so the UI NEVER shows the
// raw internal id (e.g. "prose.generate") in user-facing copy — global RULE #1 §5.
// `tasks` is the loaded task catalog (list of {id, label}). An id unknown to the catalog
// falls back to a humanized form, never the bare dotted id.
export function taskLabel(id, tasks) {
  if (!id) return "";
  const hit = (tasks || []).find((t) => t.id === id);
  if (hit && hit.label) return hit.label;
  return String(id).replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
