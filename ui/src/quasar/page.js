// The family's page height: every app's pages are rooted in Quasar's QPage (the layout Quasar's
// CLI creates — pages/<Name>Page.vue in layouts/MainLayout.vue), and each keeps its own scroller
// inside (the family's one-scroller-per-area rule), so a page is exactly as tall as the layout under
// its header instead of growing with its content:
//   <q-page :style-fn="pageFill"> … </q-page>
// QPage's `style-fn` replaces its default style (quasar.dev, layout/page: "Override default CSS
// style applied to the component"), a min-height in window pixels. A pixel height would be wrong:
// the appearance engine zooms <html> for the UI size (common/services/appearance.js) while Quasar
// measures the window in unzoomed pixels. So the page is 100% of the page container, which the
// theme makes fill the layout (theme.css, "Layout"), whose root each app fixes to the window.
const FILL = Object.freeze({ height: "100%" });

export function pageFill() {
  return FILL;
}
