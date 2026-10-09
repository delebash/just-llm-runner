// SPDX-License-Identifier: MIT
// The family's Quasar theme, part 3: Quasar's own icons — the select arrow, a chip's remove, a
// table's sort arrow and pager, the expansion chevron — drawn with the kit's line icons
// (../common/iconPaths.js) instead of Material's. Moved here from JustWrite's phone UI-library
// test (docs/plans/2026-10-08-phone-ui-library-test.md in justwrite-app). Quasar takes an SVG
// icon as "path@@style|viewBox" (QIcon); the keys the kit has no icon for keep the Material SVGs
// of Quasar's svg-material-icons set. installQuasarTheme() (./install.js) sets it.
import base from "quasar/icon-set/svg-material-icons.js";
import { ICON_PATHS } from "../common/iconPaths.js";

const LINE = "fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round";
const kit = (name) => `${ICON_PATHS[name]}@@${LINE}|0 0 24 24`;

export default {
  ...base,
  name: "family-line-icons",
  arrow: { ...base.arrow, up: kit("ArrowUp"), down: kit("ArrowDown"), dropdown: kit("ChevDown") },
  chevron: { left: kit("ChevLeft"), right: kit("ChevRight") },
  chip: { remove: kit("Close"), selected: kit("Check") },
  field: { ...base.field, clear: kit("Close") },
  expansionItem: { icon: kit("ChevDown"), denseIcon: kit("ChevDown") },
  fab: { icon: kit("Plus"), activeIcon: kit("Close") },
  pagination: { ...base.pagination, prev: kit("ChevLeft"), next: kit("ChevRight") },
  table: { ...base.table, arrowUp: kit("ArrowUp"), prevPage: kit("ChevLeft"), nextPage: kit("ChevRight") },
};
