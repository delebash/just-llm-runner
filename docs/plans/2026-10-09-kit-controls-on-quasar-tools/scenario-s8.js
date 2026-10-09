// Slice 8's states: tables at rest, a column sorted each way, a row hovered, keyboard focus in a
// cell control, the empty row, the pager, dark — JustVoice's Personas / Voices / Settings, JustWrite's
// characters index, docgen's dashboard.
const JW = [8781, 8782];
const JV = [8783, 8784];
const DG = [8785, 8786];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const sortBy = (n, times) => `(() => { for (let i = 0; i < ${times}; i++) document.querySelectorAll('table.ui-table')[0].querySelectorAll('thead th.is-sortable')[${n}].click(); })()`;
const grow = `(() => { const el = document.querySelector('#q-app') ?? document.querySelector('[data-v-app]'); const s = el.__vue_app__.config.globalProperties.$pinia._s.get('project'); const b = s.characters[0]; for (let i = 0; i < 37; i++) s.characters.push({ ...b, id: 'chr_pg_' + i, name: 'Zed ' + String(i).padStart(2, '0') }); })()`;
export default [
  { app: "jv", port: JV, route: "/personas", name: "personas-head", clip: "table.ui-table thead" },
  { app: "jv", port: JV, route: "/personas", name: "personas-sorted-asc", prep: sortBy(0, 1), clip: "table.ui-table thead" },
  { app: "jv", port: JV, route: "/personas", name: "personas-sorted-desc", prep: sortBy(0, 2), clip: "table.ui-table thead" },
  { app: "jv", port: JV, route: "/personas", name: "personas-head-hover", hover: "table.ui-table thead th.is-sortable", clip: "table.ui-table thead" },
  { app: "jv", port: JV, route: "/personas", name: "personas-row-hover", hover: "table.ui-table tbody tr.ui-table-row:nth-child(3)", clip: "table.ui-table tbody tr.ui-table-row:nth-child(3)" },
  { app: "jv", port: JV, route: "/personas", name: "personas-row-focus", focus: "table.ui-table tbody tr.ui-table-row:nth-child(2) button", clip: "table.ui-table tbody tr.ui-table-row:nth-child(2)" },
  { app: "jv", port: JV, route: "/personas", name: "personas-dark", prep: dark, clip: ".ui-table-wrap" },
  { app: "jv", port: JV, route: "/personas", name: "personas-dark-hover", prep: dark, hover: "table.ui-table tbody tr.ui-table-row:nth-child(3)", clip: "table.ui-table tbody tr.ui-table-row:nth-child(3)" },
  { app: "jv", port: JV, route: "/voices", name: "voices-top", clip: "table.ui-table thead" },
  { app: "jv", port: JV, route: "/voices", name: "voices-sorted", prep: sortBy(1, 1), clip: ".ui-table-wrap" },
  { app: "jv", port: JV, route: "/settings", name: "settings-table", clip: ".ui-table-wrap" },
  { app: "jw", port: JW, route: "/characters", name: "characters-table", clip: ".ui-table-wrap" },
  { app: "jw", port: JW, route: "/characters", name: "characters-sorted", prep: sortBy(1, 2), clip: ".ui-table-wrap" },
  { app: "jw", port: JW, route: "/characters", name: "characters-row-hover", hover: "table.ui-table tbody tr.ui-table-row:nth-child(2)", clip: "table.ui-table tbody tr.ui-table-row:nth-child(2)" },
  { app: "jw", port: JW, route: "/characters", name: "characters-pager", prep: grow, clip: ".ui-table-pager" },
  { app: "jw", port: JW, route: "/characters", name: "characters-pager-hover", prep: grow, hover: ".ui-table-pager-btn:nth-of-type(3)", clip: ".ui-table-pager" },
  { app: "jw", port: JW, route: "/characters", name: "characters-dark", prep: dark, clip: ".ui-table-wrap" },
  { app: "dg", port: DG, route: "/", name: "dashboard-table", clip: ".ui-table-wrap" },
  { app: "dg", port: DG, route: "/", name: "dashboard-empty", prep: "(() => { const i = document.querySelector('input'); })()", clip: ".ui-table-wrap" },
  { app: "dg", port: DG, route: "/runs", name: "runs-table", clip: ".ui-table-wrap" },
];
