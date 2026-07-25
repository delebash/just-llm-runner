<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script setup>
// Shared data table — TanStack Vue Table for headless sort/filter/pagination
// state; visuals are global .ui-table* in common/styles.css. Supersedes JwTable.
// Requires @tanstack/vue-table (host peer dependency) and, for the pager
// tooltips, the global `tooltip` directive (both apps register it).
//
// API:
//   :data                  row array
//   :columns               { id, accessorKey, header, sortable, headerStyle,
//                            cellStyle, enableGlobalFilter, meta }
//                          `sortable` needs an `accessorKey` even when the consumer does the
//                          sorting: TanStack's getCanSort() is `enableSorting && accessorFn`,
//                          so an id-only column renders as a dead, unclickable header.
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
//   :manual-sorting        the CONSUMER sorts :data; this table owns only the sort STATE and
//                          the header UI (TanStack's documented `manualSorting`). For lists
//                          whose order is not a plain column sort — the model catalog groups
//                          into sections and sorts WITHIN each, which a row-model sort would
//                          flatten. Pair with @update:sort.
//   :disable-sort-removal  a third click re-reverses instead of clearing the sort (default:
//                          clearing, TanStack's default).
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
// #empty — shown when the filtered row set is empty.
// #full-row — content for a row matched by :full-width-row (receives { row }). Added
//   2026-07-24 for the model catalog, whose section headers and "doesn't fit this machine"
//   divider are single cells spanning the grid. Without it those components could not adopt
//   this table at all, which is how six hand-rolled copies of a sort/width table came to
//   exist beside it.

import { computed, ref, watch, useSlots } from "vue";
import {
  useVueTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  FlexRender,
} from "@tanstack/vue-table";
import Icon from "./Icon.vue";

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

const tableColumns = computed(() =>
  props.columns.map((c) => ({
    id: c.id || c.accessorKey,
    accessorKey: c.accessorKey,
    header: c.header,
    enableSorting: !!c.sortable,
    enableGlobalFilter: c.enableGlobalFilter !== false,
    // Carried through so the header can read meta.headerClass — the template already
    // referenced it, but this mapping used to drop it, so the class never arrived.
    meta: c.meta,
  })),
);

// Match any of the globalFilterFields by case-insensitive substring on the
// stringified value. Default (no fields) matches every column.
function globalFilterFn(row, _columnId, value) {
  const needle = String(value || "").toLowerCase().trim();
  if (!needle) return true;
  const fields = props.globalFilterFields.length
    ? props.globalFilterFields
    : props.columns.map((c) => c.accessorKey).filter(Boolean);
  for (const f of fields) {
    const v = row.original?.[f];
    if (v != null && String(v).toLowerCase().includes(needle)) return true;
  }
  return false;
}

const table = useVueTable({
  get data() { return props.data; },
  get columns() { return tableColumns.value; },
  state: {
    get sorting() { return sorting.value; },
    get globalFilter() { return filtering.value; },
    get pagination() { return paginationState.value; },
  },
  manualSorting: props.manualSorting,
  enableSortingRemoval: !props.disableSortRemoval,
  onSortingChange: (updater) => {
    sorting.value = typeof updater === "function" ? updater(sorting.value) : updater;
    emit("update:sort", sorting.value[0] || null);
  },
  onGlobalFilterChange: (v) => { filtering.value = v; },
  onPaginationChange: (updater) => {
    paginationState.value = typeof updater === "function" ? updater(paginationState.value) : updater;
  },
  globalFilterFn,
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  getPaginationRowModel: paginationCfg.value ? getPaginationRowModel() : undefined,
});

function onHeaderClick(header) {
  if (!header.column.getCanSort()) return;
  header.column.toggleSorting();
}

function rowKey(row) {
  if (typeof props.dataKey === "function") return props.dataKey(row.original) ?? row.id;
  return row.original?.[props.dataKey] ?? row.id;
}

// false = an ordinary record row. Anything else = a full-width banner row; a string also
// becomes its class, so sections and dividers can look different.
function fullRowClass(original) {
  if (!props.fullWidthRow) return false;
  const r = props.fullWidthRow(original);
  if (!r) return false;
  return typeof r === "string" ? r : "";
}

function onRowClick(row, event) {
  emit("row-click", { data: row.original, originalEvent: event });
}

const pageIndex = computed(() => table.getState().pagination.pageIndex);
const pageCount = computed(() => table.getPageCount());
const totalRows = computed(() => table.getFilteredRowModel().rows.length);
const pageStart = computed(() => totalRows.value === 0 ? 0 : pageIndex.value * paginationState.value.pageSize + 1);
const pageEnd = computed(() => Math.min(totalRows.value, (pageIndex.value + 1) * paginationState.value.pageSize));

function setPageSize(n) {
  paginationState.value = { pageIndex: 0, pageSize: Number(n) };
}
</script>

<template>
  <div class="ui-table-wrap" :class="{ 'ui-table-hover': rowHover }">
    <table class="ui-table">
      <thead>
        <tr v-for="hg in table.getHeaderGroups()" :key="hg.id">
          <th
            v-for="header in hg.headers"
            :key="header.id"
            :class="[
              { 'is-sortable': header.column.getCanSort(), 'is-sorted': !!header.column.getIsSorted() },
              header.column.columnDef.meta?.headerClass,
            ]"
            :style="props.columns.find(c => (c.id || c.accessorKey) === header.column.id)?.headerStyle"
            @click="onHeaderClick(header)"
          >
            <span class="ui-table-th-inner">
              <FlexRender :render="header.column.columnDef.header" :props="header.getContext()" />
              <span v-if="header.column.getIsSorted()" class="ui-table-sort" :class="{ desc: header.column.getIsSorted() === 'desc' }">
                <Icon name="ChevDown" :size="11" />
              </span>
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!table.getRowModel().rows.length" class="ui-table-empty-row">
          <td :colspan="props.columns.length">
            <slot name="empty"><span>No results.</span></slot>
          </td>
        </tr>
        <template v-for="row in table.getRowModel().rows" :key="rowKey(row)">
          <!-- A full-width row spans the grid instead of rendering cells (section header,
               group divider). Not clickable: it carries no record. -->
          <tr v-if="fullRowClass(row.original) !== false"
            class="ui-table-fullrow" :class="fullRowClass(row.original)">
            <td :colspan="props.columns.length">
              <slot name="full-row" :row="row.original" />
            </td>
          </tr>
          <tr v-else class="ui-table-row" @click="onRowClick(row, $event)">
            <td
              v-for="cell in row.getVisibleCells()"
              :key="cell.id"
              :style="props.columns.find(c => (c.id || c.accessorKey) === cell.column.id)?.cellStyle"
            >
              <slot
                :name="cell.column.id"
                :row="row.original"
                :value="cell.getValue()"
              >{{ cell.getValue() }}</slot>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div v-if="paginationCfg" class="ui-table-pager">
      <span class="ui-table-pager-count">{{ pageStart }}–{{ pageEnd }} of {{ totalRows }}</span>
      <span class="ui-table-pager-controls">
        <button class="ui-table-pager-btn" :disabled="!table.getCanPreviousPage()" @click="table.firstPage()" v-tooltip.bottom="'First page'">
          <Icon name="ChevLeft" :size="12" /><Icon name="ChevLeft" :size="12" />
        </button>
        <button class="ui-table-pager-btn" :disabled="!table.getCanPreviousPage()" @click="table.previousPage()" v-tooltip.bottom="'Previous page'">
          <Icon name="ChevLeft" :size="12" />
        </button>
        <span class="ui-table-pager-page">Page {{ pageIndex + 1 }} / {{ Math.max(1, pageCount) }}</span>
        <button class="ui-table-pager-btn" :disabled="!table.getCanNextPage()" @click="table.nextPage()" v-tooltip.bottom="'Next page'">
          <Icon name="ChevRight" :size="12" />
        </button>
        <button class="ui-table-pager-btn" :disabled="!table.getCanNextPage()" @click="table.lastPage()" v-tooltip.bottom="'Last page'">
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
