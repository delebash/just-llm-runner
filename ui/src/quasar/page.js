// The family's page height: every app's pages are rooted in Quasar's QPage (the layout Quasar's
// CLI creates — pages/<Name>Page.vue in layouts/MainLayout.vue), and each keeps its own scroller
// inside (the family's one-scroller-per-area rule), so a page is exactly as tall as the window under
// the layout's header and footer instead of QPage's default min-height:
//   <q-page :style-fn="pageFill"> … </q-page>
// QPage calls it with the header + footer height and the window's (or a containerized layout's)
// height, both measured by Quasar (quasar.dev, layout/page: "style-fn — Override default CSS style
// applied to the component"). Before Quasar has measured the window (a test's DOM, where the height
// is 0) it sets nothing.
export function pageFill(offset, height) {
  return height ? { height: `${height - offset}px` } : {};
}
