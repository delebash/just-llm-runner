import all from "./scenario-s8.js";
const sortBy = (n, times) => `(() => { for (let i = 0; i < ${times}; i++) document.querySelectorAll('table.ui-table')[0].querySelectorAll('thead th.is-sortable')[${n}].click(); })()`;
export default [
  ...all.filter((s) => s.name === "characters-pager-hover"),
  ...all.filter((s) => s.name === "characters-pager-hover").map((s) => ({ ...s, name: "characters-pager-hover-2" })),
  { app: "jv", port: [8783, 8784], route: "/settings", name: "settings-table", clip: "table.ui-table" },
  { app: "jv", port: [8783, 8784], route: "/ai", name: "ai-table", clip: "table.ui-table" },
  { app: "jv", port: [8783, 8784], route: "/ai", name: "ai-table-sorted", prep: sortBy(0, 1), clip: "table.ui-table" },
];
