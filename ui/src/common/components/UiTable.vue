<!-- SPDX-License-Identifier: MIT -->
<script setup>
// Shared data table — visuals are global .ui-table* in common/styles.css. Supersedes JwTable.
// Requires, for the pager tooltips, the global `tooltip` directive (the apps register it).
//
// Quasar's QTable underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md, slice 8; TanStack Vue Table before it): QTable
// renders the table, and its header and body slots draw the same markup as before — <table
// class="ui-table">, th.is-sortable/.is-sorted with .ui-table-th-inner, tr.ui-table-row and
// tr.ui-table-fullrow, the empty row, the pager below — so every rule that styles a table's
// insides still reaches them. The global filter, the sort (its automatic comparison, its first
// direction and its click cycle) and the page reset are TanStack's rules, kept in ./tableRows.js,
// so no list re-orders. QTable's own look is reset by the kit's theme (../../quasar/theme.css,
// "Table").
//
// API:
//   :data                  row array
//   :columns               { id, accessorKey, header, sortable, headerStyle,
//                            cellStyle, enableGlobalFilter, meta }
//                          `sortable` needs an `accessorKey` even when the consumer does the
//                          sorting: a column sorts only when it has a value to sort by (TanStack's
//                          rule, kept), so an id-only column renders as a dead, unclickable header.
//   data-key               id field on rows (drives :key)
//   :global-filter         text to match across global-filter-fields
//   :global-filter-fields  column accessors to search (default: all)
//   :pagination            false | { pageSize, pageSizeOptions }
//   :default-sort          { id, desc } applied on mount
//   row-hover              hover highlight
//   :full-width-row        (row) => falsy | true | "class-name" — rows that span EVERY column
//                          instead of rendering cells (section headers, group dividers),
//                          rendered through the `full-row` slot. Returning a STRING also puts
//                          that class on the <tr>, so one list can carry two kinds of banner
//                          row with different looks. Omit the prop and nothing changes.
//   :row-class             (row) => falsy | string | string[] | object — class(es) for the
//                          <tr> of an ORDINARY record row, taking whatever `:class` takes.
//                          For per-row STATE that CSS reads: the row playing right now, a
//                          row whose backing file is missing, a stale row. Added 2026-08-21:
//                          only full-width banner rows could be classed, so adopting this
//                          table meant losing every row state a hand-rolled <tr :class> had,
//                          and consumers pushed the class onto an inner <div> where a
//                          `tr:hover`/`td` rule can no longer see it.
//   :manual-sorting        the CONSUMER sorts :data; this table owns only the sort STATE and
//                          the header UI (TanStack's `manualSorting`, kept). For lists
//                          whose order is not a plain column sort — the model catalog groups
//                          into sections and sorts WITHIN each, which a row-model sort would
//                          flatten. Pair with @update:sort.
//   :disable-sort-removal  a third click re-reverses instead of clearing the sort (default:
//                          clearing).
//   @update:sort           { id, desc } whenever the header changes the sort state
//   @row-click             emits { data, originalEvent }
//
// Opt-in LOOK modifiers — plain classes on the component (visual variants are CSS, per the
// three-tier rule), defined in common/styles.css. Absent = today's look, so no existing
// table moves: `ui-table-fixed` (table-layout: fixed — column widths become SHARES the
// browser divides, so the grid can never outgrow its container), `ui-table-sticky` (header
// pinned while the body scrolls), `ui-table-top` (cells top-aligned, for rows whose first
// column is a tall stack and the rest are one-liners).
//
// Cell rendering: a slot named after column.id — <template #title="{ row, value }">.
// HEADER rendering: `head-<column.id>` — <template #head-sel>. Added 2026-08-03: cells
//   had slots and headers did not, so a control that belongs in a header (the canonical
//   place for a select-all checkbox, above its column of row checkboxes) had nowhere to
//   go. The i18n dashboard parked its select-all in a footer strip instead — a workaround
//   in an app for a gap in the kit. The sort affordance still wraps whatever the slot
//   renders, so a sortable column keeps its caret; put interactive controls in
//   non-sortable columns (a click on the header also toggles sorting).
// #empty — shown when the filtered row set is empty.
// #full-row — content for a row matched by :full-width-row (receives { row }). Added
//   2026-07-24 for the model catalog, whose section headers and "doesn't fit this machine"
//   divider are single cells spanning the grid. Without it those components could not adopt
//   this table at all, which is how six hand-rolled copies of a sort/width table came to
//   exist beside it.

import { computed, onMounted, onUpdated, ref, watch, useSlots } from "vue";
import { QTable } from "quasar";
import Icon from "./Icon.vue";
import { canGlobalFilter, firstSortDir, nextSortingOrder, sortRows } from "./tableRows.js";

const props = defineProps({
  data:               { type: Array, default: () => [] },
  columns:            { type: Array, required: true },
  // A String names the row's id field; a Function resolves it — needed when one list mixes
  // record rows with section/divider sentinels that carry no id.
  dataKey:            { type: [String, Function], default: "id" },
  globalFilter:       { type: String, default: "" },
  globalFilterFields: { type: Array, default: () => [] },
  pagination:         { type: [Boolean, Object], default: false },
  defaultSort:        { type: Object, default: null }, // { id, desc }
  rowHover:           { type: Boolean, default: false },
  // Predicate over the ORIGINAL row object; true → render one full-width cell via #full-row.
  fullWidthRow:       { type: Function, default: null },
  // Class(es) for an ordinary record row's <tr>, from the ORIGINAL row object.
  rowClass:           { type: Function, default: null },
  manualSorting:      { type: Boolean, default: false },
  disableSortRemoval: { type: Boolean, default: false },
});
const emit = defineEmits(["row-click", "update:sort"]);
const slots = useSlots();

const sorting = ref(props.defaultSort ? [props.defaultSort] : []);
const filtering = ref(props.globalFilter || "");
watch(() => props.globalFilter, (v) => { filtering.value = v || ""; });

const paginationCfg = computed(() => {
  if (!props.pagination) return null;
  if (props.pagination === true) return { pageSize: 25, pageSizeOptions: [10, 25, 50] };
  return {
    pageSize: props.pagination.pageSize ?? 25,
    pageSizeOptions: props.pagination.pageSizeOptions ?? [10, 25, 50],
  };
});
const paginationState = ref({ pageIndex: 0, pageSize: paginationCfg.value?.pageSize ?? 25 });
watch(paginationCfg, (cfg) => {
  if (cfg) paginationState.value = { ...paginationState.value, pageSize: cfg.pageSize };
});

// One entry per column: its id, the value it reads (an accessorKey with dots reads a nested
// field, as TanStack's did) and the definition it came from.
const cols = computed(() =>
  props.columns.map((c) => {
    const key = c.accessorKey;
    const path = key && key.includes(".") ? key.split(".") : null;
    return {
      id: c.id || key,
      def: c,
      value: key ? (row) => (path ? path.reduce((o, k) => o?.[k], row) : row?.[key]) : () => undefined,
      canSort: !!c.sortable && !!key,
    };
  }),
);
const colById = computed(() => new Map(cols.value.map((c) => [c.id, c])));

// Data order, for ties and for the rows that carry no key of their own.
const order = computed(() => new Map(props.data.map((row, i) => [row, i])));
const indexOf = (row) => order.value.get(row) ?? 0;

// Match any of the globalFilterFields by case-insensitive substring on the
// stringified value. Default (no fields) matches every column.
function matches(row, value) {
  const needle = String(value || "").toLowerCase().trim();
  if (!needle) return true;
  const fields = props.globalFilterFields.length
    ? props.globalFilterFields
    : props.columns.map((c) => c.accessorKey).filter(Boolean);
  for (const f of fields) {
    const v = row?.[f];
    if (v != null && String(v).toLowerCase().includes(needle)) return true;
  }
  return false;
}
const filteredRows = computed(() => {
  const value = filtering.value;
  if (!value) return props.data;
  // the filter applies only when some column can take part in it (its first row's value is a
  // string or a number, and it hasn't opted out)
  const first = props.data[0];
  const filterable = cols.value.some((c) => c.def.accessorKey && c.def.enableGlobalFilter !== false && canGlobalFilter(c.value(first)));
  if (!filterable) return props.data;
  return props.data.filter((row) => matches(row, value));
});

const isSorted = (id) => {
  const s = sorting.value.find((e) => e.id === id);
  return !s ? false : s.desc ? "desc" : "asc";
};
const sortedRows = computed(() => {
  const rows = filteredRows.value;
  if (props.manualSorting) return rows;
  const entry = sorting.value.find((e) => colById.value.get(e.id)?.canSort);
  if (!entry) return rows;
  return sortRows(rows, colById.value.get(entry.id).value, !!entry.desc, indexOf);
});

function onHeaderClick(col) {
  if (!col.canSort) return;
  const next = nextSortingOrder(isSorted(col.id), firstSortDir(col.value(filteredRows.value[0])), !props.disableSortRemoval);
  sorting.value = next === false ? [] : [{ id: col.id, desc: next === "desc" }];
  emit("update:sort", sorting.value[0] || null);
}

// A new list, a new filter or a new sort puts the pager back on its first page, as before.
watch([() => props.data, filtering, sorting], () => {
  if (paginationState.value.pageIndex !== 0) paginationState.value = { ...paginationState.value, pageIndex: 0 };
});

const totalRows = computed(() => filteredRows.value.length);
const pageIndex = computed(() => paginationState.value.pageIndex);
const pageCount = computed(() => (paginationCfg.value ? Math.ceil(totalRows.value / paginationState.value.pageSize) : 1));
const pageStart = computed(() => totalRows.value === 0 ? 0 : pageIndex.value * paginationState.value.pageSize + 1);
const pageEnd = computed(() => Math.min(totalRows.value, (pageIndex.value + 1) * paginationState.value.pageSize));
const canPrev = computed(() => pageIndex.value > 0);
const canNext = computed(() => pageCount.value > 0 && pageIndex.value < pageCount.value - 1);
const visibleRows = computed(() => {
  if (!paginationCfg.value) return sortedRows.value;
  const size = paginationState.value.pageSize;
  return sortedRows.value.slice(pageIndex.value * size, pageIndex.value * size + size);
});
function goTo(i) {
  paginationState.value = { ...paginationState.value, pageIndex: Math.max(0, Math.min(i, Math.max(0, pageCount.value - 1))) };
}
function setPageSize(n) {
  paginationState.value = { pageIndex: 0, pageSize: Number(n) };
}

function rowKey(row) {
  const k = typeof props.dataKey === "function" ? props.dataKey(row) : row?.[props.dataKey];
  return k ?? `ui-table-row-${indexOf(row)}`;
}

// false = an ordinary record row. Anything else = a full-width banner row; a string also
// becomes its class, so sections and dividers can look different.
function fullRowClass(original) {
  if (!props.fullWidthRow) return false;
  const r = props.fullWidthRow(original);
  if (!r) return false;
  return typeof r === "string" ? r : "";
}

// Per-row state class for ordinary record rows. Null-safe so the common case
// (no prop) adds nothing to the <tr>.
function recordRowClass(original) {
  return props.rowClass ? props.rowClass(original) : null;
}

function onRowClick(row, event) {
  emit("row-click", { data: row, originalEvent: event });
}

// QTable draws the <table> itself (class q-table) inside a scroll wrapper it makes focusable;
// the table keeps its .ui-table class (every rule that styles a table reads it) and the wrapper
// — which scrolls nothing here — takes no Tab stop. Neither attribute is one QTable's render
// changes later, so Vue leaves both as set.
const qtable = ref(null);
// QTable shows every row it is given (the paging is this table's, above)
const ALL_ROWS = { rowsPerPage: 0 };
function adoptTable() {
  const el = qtable.value?.$el;
  const table = el?.querySelector?.(":scope > .q-table__middle > table.q-table");
  if (table && !table.classList.contains("ui-table")) table.classList.add("ui-table");
  const middle = el?.querySelector?.(":scope > .q-table__middle");
  if (middle?.hasAttribute("tabindex")) middle.removeAttribute("tabindex");
}
onMounted(adoptTable);
onUpdated(adoptTable);
</script>

<template>
  <div class="ui-table-wrap" :class="{ 'ui-table-hover': rowHover }">
    <QTable
      ref="qtable"
      :rows="visibleRows"
      :columns="[]"
      :row-key="rowKey"
      :pagination="ALL_ROWS"
      flat
      square
      wrap-cells
      separator="none"
      hide-bottom
      hide-no-data
    >
      <template #header>
        <tr>
          <th
            v-for="col in cols"
            :key="col.id"
            :class="[
              { 'is-sortable': col.canSort, 'is-sorted': !!isSorted(col.id) },
              col.def.meta?.headerClass,
            ]"
            :style="col.def.headerStyle"
            @click="onHeaderClick(col)"
          >
            <span class="ui-table-th-inner">
              <slot v-if="slots[`head-${col.id}`]" :name="`head-${col.id}`" />
              <template v-else>{{ col.def.header }}</template>
              <span v-if="isSorted(col.id)" class="ui-table-sort" :class="{ desc: isSorted(col.id) === 'desc' }">
                <Icon name="ChevDown" :size="11" />
              </span>
            </span>
          </th>
        </tr>
      </template>
      <template #top-row>
        <tr v-if="!visibleRows.length" class="ui-table-empty-row">
          <td :colspan="props.columns.length">
            <slot name="empty"><span>No results.</span></slot>
          </td>
        </tr>
      </template>
      <template #body="{ row }">
        <!-- A full-width row spans the grid instead of rendering cells (section header,
             group divider). Not clickable: it carries no record. -->
        <tr v-if="fullRowClass(row) !== false" :key="rowKey(row)"
          class="ui-table-fullrow" :class="fullRowClass(row)">
          <td :colspan="props.columns.length">
            <slot name="full-row" :row="row" />
          </td>
        </tr>
        <tr v-else :key="rowKey(row)" class="ui-table-row" :class="recordRowClass(row)" @click="onRowClick(row, $event)">
          <td v-for="col in cols" :key="col.id" :style="col.def.cellStyle">
            <slot :name="col.id" :row="row" :value="col.value(row)">{{ col.value(row) }}</slot>
          </td>
        </tr>
      </template>
    </QTable>

    <div v-if="paginationCfg" class="ui-table-pager">
      <span class="ui-table-pager-count">{{ pageStart }}–{{ pageEnd }} of {{ totalRows }}</span>
      <span class="ui-table-pager-controls">
        <button class="ui-table-pager-btn ui-table-pager-edge" :disabled="!canPrev" @click="goTo(0)" v-tooltip.bottom="'First page'">
          <Icon name="ChevLeft" :size="12" /><Icon name="ChevLeft" :size="12" />
        </button>
        <button class="ui-table-pager-btn" :disabled="!canPrev" @click="goTo(pageIndex - 1)" v-tooltip.bottom="'Previous page'">
          <Icon name="ChevLeft" :size="12" />
        </button>
        <span class="ui-table-pager-page">Page {{ pageIndex + 1 }} / {{ Math.max(1, pageCount) }}</span>
        <button class="ui-table-pager-btn" :disabled="!canNext" @click="goTo(pageIndex + 1)" v-tooltip.bottom="'Next page'">
          <Icon name="ChevRight" :size="12" />
        </button>
        <button class="ui-table-pager-btn ui-table-pager-edge" :disabled="!canNext" @click="goTo(pageCount - 1)" v-tooltip.bottom="'Last page'">
          <Icon name="ChevRight" :size="12" /><Icon name="ChevRight" :size="12" />
        </button>
        <label class="ui-table-pager-size-label" for="ui-table-pager-size">Rows per page</label>
        <select id="ui-table-pager-size" class="ui-table-pager-size" :value="paginationState.pageSize" @change="setPageSize($event.target.value)">
          <option v-for="n in paginationCfg.pageSizeOptions" :key="n" :value="n">{{ n }} / page</option>
        </select>
      </span>
    </div>
  </div>
</template>
