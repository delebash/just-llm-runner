# Notices

Code in this repository that was copied or ported from another project, with its licence. The full
licence notice of each is kept in the file named; the family rule is `docs/family-rules.md`.

## The UI kit (`ui/`)

- **`ui/src/common/components/tableRows.js`** — UiTable's global filter, sort functions, automatic
  sort choice, first direction and click cycle, ported from TanStack Table's table-core 8
  (`sortingFns`, `features/RowSorting`, `utils/getSortedRowModel`, `features/GlobalFiltering`).
  MIT License, Copyright (c) 2016 Tanner Linsley.
- **`ui/src/common/services/toastBridge.js`** — the toasts' four kind icons, Heroicons paths (MIT
  License, Copyright (c) Tailwind Labs, Inc.) as vue-sonner 2.0.9 shipped them. MIT License,
  Copyright (c) 2022 Yunwei Xiao.

The apps that bundle the kit list these in their own `NOTICE.md` too.
