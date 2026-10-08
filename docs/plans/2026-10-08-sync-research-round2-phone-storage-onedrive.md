<!-- SPDX-License-Identifier: MIT -->
# Sync round 2: the phone's database and the OneDrive folder

Web research only, done 2026-10-08. Every fact below carries its source and "checked 2026-10-08".
"Not found" means no source stated it. A line marked **inference** is my reading of the cited
facts, not a stated fact. Nothing here was run on a device.

Setup under study: a Quasar app on Capacitor 8 (Android System WebView / iOS WKWebView), with the
server code (plain JS, written for a synchronous SQLite API) in a Web Worker on
`@sqlite.org/sqlite-wasm` with `opfs-sahpool`. Sync exchanges change files by export/import, through
a cloud folder (one file per device; OneDrive first), or through our own server.

---

## Section A: can the phone keep a SQLite database in the app, durably?

### Verdict A

**It is possible on paper. It is unproven in practice, and the storage is evictable.**

- The APIs exist in both webviews according to the compatibility data: Android WebView 109+ and iOS 16.4+ for
  the synchronous access-handle methods. That data is copied from Chrome Android and Safari iOS,
  not measured in webviews.
- Capacitor's origins count as secure contexts. Android uses `https://localhost`. On iOS,
  WebKit's code treats a `localhost` host and any scheme-handler scheme as trustworthy.
- No report was found of anyone running `@sqlite.org/sqlite-wasm` on OPFS inside Capacitor, Cordova, an Android WebView or a WKWebView.
- PowerSync, a vendor, reports that in Capacitor OPFS access handles "can be closed when the app is in the
  background".
- The storage is best-effort:
  - Android WebView's code denies `persist()`.
  - How WebKit grants persistence to a non-browser app is not documented.
  - Capacitor's own docs say the OS reclaims webview storage when space runs low.
- Native SQLite plugins avoid webview storage, but every call goes through Capacitor's bridge,
  which is "asynchronous and promise-based". No synchronous route from a native plugin was found.

### Recommended approach A

1. **Run a device spike before committing.** Put `opfs-sahpool` in a Worker in the real Quasar/Capacitor shell, on one real
   Android phone and one real iPhone. Run the checks in the device-test list at the end.
2. **If the spike passes, keep the synchronous server code on `opfs-sahpool`.** Design sync so the phone's local
   database is never the only copy:
   - push changes out promptly;
   - make a fresh install rebuildable from the sync folder or server;
   - offer export.
   - Optionally release the pool's handles when the app goes to the background and take them back
     on resume. `pauseVfs()` / `unpauseVfs()` are documented. Their effect on iOS backgrounding is
     untested.
3. **If the spike fails** (handles lost in the background, data gone after a restart or an update), the fallback is a
   native plugin (`@capacitor-community/sqlite`, MIT). That means the phone's database layer must
   become async. The server code changes, so this needs the user's decision.
4. wa-sqlite is **not** a synchronous alternative. Its `exec`/`step`/`open_v2`/`close` return Promises
   even in its synchronous build (A.5).

### A.1 OPFS and `FileSystemSyncAccessHandle` in the two webviews

**Compatibility data (MDN browser-compat-data, BCD)**

- `FileSystemSyncAccessHandle`:
  - Chrome 102, Chrome Android 109, Safari 15.2.
  - `webview_android`, `safari_ios` and `webview_ios` are all `"mirror"`.
  - The synchronous versions of `close`, `flush`, `getSize` and `truncate`: Chrome 108, Chrome Android 109, Safari 16.4.
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/FileSystemSyncAccessHandle.json, checked 2026-10-08.
- `FileSystemFileHandle.createSyncAccessHandle`:
  - Chrome Android 109, Safari 15.2; the webviews are `"mirror"`.
  - Its `mode` option (`readwrite-unsafe` etc.): Chrome 121, Safari `false`.
  - `createWritable`: Safari 26.
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/FileSystemFileHandle.json, checked 2026-10-08.
- `StorageManager`:
  - `getDirectory`: Chrome Android 109, Safari 15.2.
  - `persist` / `persisted`: Safari 15.2.
  - `estimate`: Safari 17.
  - Webviews `"mirror"`.
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/StorageManager.json, checked 2026-10-08.
- **What `"mirror"` means.** BCD copies the data from the upstream browser "as defined in
  `browsers/<browser>.json`". https://raw.githubusercontent.com/mdn/browser-compat-data/HEAD/schemas/compat-data-schema.md, checked 2026-10-08.
  - `webview_ios` ("WebView on iOS") has `upstream: "safari_ios"`; its current release is 27
    (2026-09-14). https://raw.githubusercontent.com/mdn/browser-compat-data/HEAD/browsers/webview_ios.json, checked 2026-10-08.
  - **So the webview rows are derived from Chrome Android and Safari iOS, not measured in a webview.**
- caniwebview.com marks OPFS for Android WebView and WKWebView (iOS) with an unexplained "\*".
  Its notes say "We do web-features computation using web-features-plus-webview".
  https://caniwebview.com/features/web-feature-origin-private-file-system/, checked 2026-10-08.

**Chromium and SQLite statements**

- Chromium's Intent to Ship for OPFS on Android (2022-09-21, estimated milestone 107) "includes
  Android Chrome and Android WebView", and covers `FileSystemSyncAccessHandle`.
  https://groups.google.com/a/chromium.org/g/blink-dev/c/GyxqF8ZDK5Q, checked 2026-10-08.
- SQLite's docs on `opfs-sahpool`:
  - it "Should work on all major browsers released since March 2023" (that is Safari 16.4);
  - it "Does not require COOP/COEP HTTP headers";
  - the OPFS APIs "are only available in Worker threads".
  - The page says nothing about webviews, Capacitor or Cordova.
  - https://sqlite.org/wasm/doc/trunk/persistence.md, checked 2026-10-08.

**Minimum versions**

- **Inference** from the above: Android System WebView 109+ and iOS 16.4+ for `opfs-sahpool`.
- Capacitor 8's own floor is lower:
  - iOS 15.0 and Android 7.0 (API 24) — https://capacitorjs.com/docs/main/reference/support-policy, checked 2026-10-08.
  - `android.minWebViewVersion` defaults to 60 — https://capacitorjs.com/docs/config, checked 2026-10-08.
  - The app would have to raise both.

**Does the webview differ from Chrome or Safari?**

- Quotas differ on Apple platforms. Since iOS 17 / macOS 14:
  - "other WebKit-based apps that embed web content" (for example WKWebView apps) get about 15% of disk
    per origin and 20% overall;
  - browsers get about 60% per origin and 80% overall.
  - https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria, checked 2026-10-08.
  - The same numbers are in https://webkit.org/blog/14403/updates-to-storage-policy/ (2023-08-10), checked 2026-10-08.
- One unofficial README claims "Each file in the OPFS in a WKWebView is limited to 10MB". No other source
  confirms it. https://github.com/wendylabsinc/opfs-checker, checked 2026-10-08.
- On Android WebView, one unanswered report describes a `SecurityError` from `getFileHandle`, "often" on
  Android 14 with WebView 132, from an HTTPS origin.
  https://www.lune.dev/questions/3454/why-does-android-webview-block-opfs-api-access-on-certain-devices, checked 2026-10-08.
- In a Tauri app on Android, served from `http://tauri.localhost`, `getDirectory` existed but failed. The
  webview did not treat that origin as a secure context.
  https://github.com/imattau/scrollstr/pull/6 (2026-09-29), checked 2026-10-08. This is not Capacitor's origin.

**Capacitor's origin and secure context**

- Defaults:
  - `server.hostname` defaults to `localhost`, "recommended … as it allows the use of Web APIs that would otherwise require a" secure context;
  - `server.iosScheme` defaults to `capacitor` and "Can't be set to schemes that the WKWebView already handles, such as http or https";
  - `server.androidScheme` defaults to `https`.
  - So the origins are `capacitor://localhost` (iOS) and `https://localhost` (Android).
  - https://capacitorjs.com/docs/config, checked 2026-10-08.
- WebKit's current `shouldTreatAsPotentiallyTrustworthy` returns true for a localhost or loopback host
  and for `LegacySchemeRegistry::schemeIsHandledBySchemeHandler(protocol)`.
  https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/SecurityOrigin.cpp, checked 2026-10-08.
- WebKit bug 223423, "Custom scheme handled origins should be considered secure", landed as r274733 on
  2021-03-19. https://bugs.webkit.org/show_bug.cgi?id=223423, checked 2026-10-08.
  Which iOS release first shipped it: not found.
- **Inference:** `capacitor://localhost` is a secure context on current iOS. `https://localhost` is
  HTTPS, so it is a secure context on Android. A device test (`isSecureContext` in the Worker) settles it.

### A.2 Who has run SQLite WASM on OPFS inside a webview?

- **No report was found** of `@sqlite.org/sqlite-wasm` with `opfs-sahpool`, or any OPFS VFS, running in
  production inside Capacitor, Cordova, a plain Android WebView or a WKWebView. The sqlite.org WASM
  docs have no webview notes (persistence.md above). Searches of the sqlite.org forum found nothing either.

**Capacitor issues**

- **Capacitor issue #6965** (iOS, 2023-10-06, @capacitor/ios 4.7.0), "Origin Private File System is not
  peristent" [sic]:
  - OPFS files were lost when the app was closed on iOS; the same site in Safari kept them.
  - The reporter closed it 3 days later: "Nevermind I got it to work in the example". No cause was given.
  - https://github.com/ionic-team/capacitor/issues/6965 and https://api.github.com/repos/ionic-team/capacitor/issues/6965/comments, checked 2026-10-08.
  - The repro repo is https://github.com/poesterlin/CapacitorOPFS, checked 2026-10-08.
- **Capacitor issues #6182 and #7813**:
  - #6182 (2022-12-21, iOS 15.2): custom response headers cannot be set on the top-level
    `capacitor://localhost` document, so `SharedArrayBuffer` is unavailable.
  - #7813 (2024-12-19): a request for headers so SQLite WASM can use OPFS. Closed as not planned.
  - https://github.com/ionic-team/capacitor/issues/6182, https://github.com/ionic-team/capacitor/issues/7813, checked 2026-10-08.
  - **Inference:** the `"opfs"` VFS, which needs COOP/COEP for `SharedArrayBuffer`, is not available in
    Capacitor. `opfs-sahpool` does not need the headers.

**PowerSync reports (vendor)**

- "On Ionic Capacitor, access handles in `OPFSCoopSyncVFS` can be closed when the app is in the
  background", causing errors on resume. Their workarounds are native SQLite or `IDBBatchAtomicVFS`.
  The same post reports `RangeError: Maximum call stack size exceeded` on Safari with
  `IDBBatchAtomicVFS` and large queries.
  https://powersync.com/blog/sqlite-persistence-on-the-web (updated 2026-05-15), checked 2026-10-08.
  - **Inference:** `opfs-sahpool` also keeps its access handles open, so it would likely be exposed to the
    same problem. Untested.
- PowerSync's Capacitor SDK uses native SQLite (`@capacitor-community/sqlite`) on iOS and Android, and
  WA-SQLite only on the web. Their roadmap users said "native SQLite storage is the only real reliable
  permanent storage option on Capacitor mobile apps" and "webview storage seems unreliable".
  https://powersync.com/blog/introducing-the-powersync-capacitor-sdk (2025-11-03), checked 2026-10-08.
- PowerSync's Tauri SDK (2026-03-31): "IndexedDB and OPFS don't persist across app updates in Tauri's
  WebView … the database resets on every new build". This is Tauri, not Capacitor, and no cause or
  platform is stated. https://releases.powersync.com/announcements/ann_mPwGQpcccCyvL, checked 2026-10-08.

**Other reports**

- A point-of-sale project's spec (2026-09-29) uses `@sqlite.org/sqlite-wasm` with
  `installOpfsSAHPoolVfs` on the web only. Its findings:
  - "an ungraceful worker stop poisons OPFS for the browsing context" on WebKit (from Playwright
    WebKit, not real Safari);
  - recovery is "a reload or relaunch".
  - For iOS and Android it uses native `expo-sqlite`.
  - https://github.com/wcpos/monorepo/issues/2242, checked 2026-10-08.
  - Its earlier question issue says of its own stack (rxdb, SQLite WASM and OPFS) that "nobody has ever run this
    combination in production anywhere". https://github.com/wcpos/monorepo/issues/2138, checked 2026-10-08.
- Capawesome's SQLite and Capgo's Fast SQL use SQLite WASM (and OPFS) **only on the web**. On Android
  and iOS they use native SQLite. https://capawesome.io/plugins/sqlite/, https://github.com/Cap-go/capacitor-fast-sql, checked 2026-10-08.

### A.3 Durability: can the OS or the webview evict the data?

**General rules (MDN)**

- Best-effort data persists while under quota and while there is space.
- Under storage pressure, browsers evict the least-recently-used non-persistent origin first.
  Persistent origins are skipped.
- OPFS is listed among the covered storage.
- Safari proactively deletes script-created data of an origin with "no user interaction … in the last seven
  days of browser use" when cross-site tracking prevention is on.
- Safari and most Chromium browsers approve or deny `persist()` automatically, with no prompt.
- https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria, checked 2026-10-08.

**iOS WKWebView**

- **Storage policy** (WebKit, 2023-08-10; Safari 17, iOS 17, iPadOS 17, macOS Sonoma):
  - Eviction can happen when the overall quota is exceeded, under storage pressure, or "when the site has not
    been used for some time". It runs least-recently-used by origin.
  - Persistent-mode origins are excluded.
  - "WebKit currently grants a request based on heuristics like whether the website is opened as a
    Home Screen Web App."
  - It does not say how a WKWebView app's request is decided.
  - https://webkit.org/blog/14403/updates-to-storage-policy/, checked 2026-10-08.
- **The 7-day cap** (WebKit's tracking-prevention page):
  - It deletes "all other script-writeable storage after 7 days of no user interaction with the website".
  - "The first-party domain of home screen web applications is exempt."
  - WKWebView and native apps are **not mentioned**.
  - https://webkit.org/tracking-prevention/, checked 2026-10-08.
  - The 2020 announcement adds that home-screen web apps "have their own counter of days of use". It does
    not mention WKWebView. https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/, checked 2026-10-08.
- **ITP in WKWebView apps** (App-Bound Domains post, 2020-06-26):
  - ITP is "enabled by default in all `WKWebView` applications" from iOS 14.0.
  - Content "supplied by the app through local files, data URLs, and HTML strings are always treated as app bound domains".
  - The post does not mention the 7-day cap or custom schemes.
  - https://webkit.org/blog/10882/app-bound-domains/, checked 2026-10-08.
- **Does the 7-day cap apply to apps? No official statement found.**
  - WebKit bug 211775 (2020): the reporter saw WKWebView localStorage survive the test. The WebKit engineer
    only answered about cookies. The bug was closed as a duplicate in 2022.
    https://bugs.webkit.org/show_bug.cgi?id=211775, checked 2026-10-08.
  - A 2021 consultancy blog post says the WKWebView "has its independent day counter resetting every time it
    starts". This is secondary and gives no WebKit source. https://www.thinktecture.com/?p=8902, checked 2026-10-08.
  - WebKit bug 209563 ("Support longterm persistent storage") is still NEW.
    https://bugs.webkit.org/show_bug.cgi?id=209563, checked 2026-10-08.
- **App-Bound Domains in Capacitor**: `ios.limitsNavigationsToAppBoundDomains`, default false.
  "If the Info.plist file includes `WKAppBoundDomains` key, it's recommended to set this option to true",
  and `localhost` must be in that list. https://capacitorjs.com/docs/config, checked 2026-10-08.
  Any effect of App-Bound Domains on storage eviction: not found.
- **`persist()` in WKWebView**: no source says whether a WKWebView app is granted it. Not found.

**Android System WebView**

- `persist()` is **denied by WebView's code**. In `aw_permission_manager.cc`, `PermissionType::PERSISTENT_STORAGE`
  returns `PermissionStatus::DENIED`, and requests for it are `NOTIMPLEMENTED()` and denied.
  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/android_webview/browser/aw_permission_manager.cc, checked 2026-10-08.
- A WebView engineer (Torne) said in 2017 "We'd have to expose a callback to the embedding app", and on
  2025-09-04: "No, nothing has changed here."
  https://groups.google.com/a/chromium.org/g/chromium-discuss/c/AWMgYFD_gJs, checked 2026-10-08.
- **This conflicts with Capacitor's docs.** They say "on Android, the persisted storage API is available to
  mark IndexedDB as persisted", that "the OS will reclaim local storage from Web Views if a device is running
  low on space", and that "The same can be said for IndexedDB at least on iOS".
  https://capacitorjs.com/docs/guides/storage, checked 2026-10-08.
- A field report from a Capacitor Android app (Super Productivity, 2026-05-31): "total local data loss on
  Android with no sync configured", with about 3% free storage. They hypothesise WebView eviction;
  it is not confirmed. https://github.com/super-productivity/super-productivity/issues/7901, checked 2026-10-08.

**On the desktop**

- One sqlite.org forum thread (2023–2026) reports OPFS data on Windows Chrome/Edge vanishing.
  - Suspects: cleanup tools, Windows Storage Sense, low-storage cleanup.
  - SQLite's developer says "There is nothing in the library which will outright delete your databases."
  - https://sqlite.org/forum/info/23d6de887976a72209c149756c160426fda952d9491270f1d19b6d1cdf696cfc?t=h, checked 2026-10-08.
  - Desktop browsers, not webviews; listed for completeness.

### A.4 Native SQLite plugins

**The bridge is asynchronous**

- Capacitor's plugin method types: "All are asynchronous and promise-based."
  https://capacitorjs.com/docs/plugins/method-types, checked 2026-10-08.

**`@capacitor-community/sqlite`** 8.1.1 (MIT, published 2026-08-06; npm registry, checked 2026-10-08)

- Every method returns a Promise, e.g. `query(options) => Promise<capSQLiteValues>`.
  https://raw.githubusercontent.com/capacitor-community/sqlite/master/docs/API.md, checked 2026-10-08.
- Extension loading is not documented.
- The web build uses `jeep-sqlite` (sql.js, stored in IndexedDB). https://github.com/capacitor-community/sqlite, checked 2026-10-08.

**Capawesome SQLite** ("only available to Capawesome Insiders", a paid subscription)

- Promise API.
- Engines: Android and iOS use system SQLite by default, with optional bundling. The web uses SQLite WASM.
  Electron uses `node:sqlite`.
- **Extensions:**
  - Android loads app-bundled extensions through the `androidExtensions` option of `open(...)`, which
    requires the bundled SQLite backend.
  - iOS extensions must be statically linked and registered at startup.
- SQLCipher encryption is available on Android and iOS.
- https://capawesome.io/plugins/sqlite/, checked 2026-10-08.
- `@capawesome-team/capacitor-sqlite` is not on the public npm registry (404, checked 2026-10-08).

**`@capgo/capacitor-fast-sql`** 8.2.9 (MPL-2.0, published 2026-10-08)

- Native SQLite plus "a local HTTP server on `localhost`". `connect()` returns `port` and `token`. The
  wire protocol is "a custom HTTP-based protocol".
- All documented methods return Promises.
- The web uses `@sqlite.org/sqlite-wasm` with OPFS. It "falls back to a non-persistent database" if OPFS is
  unavailable, and needs COOP/COEP there.
- Setup: iOS needs `NSAllowsLocalNetworking`; Android needs cleartext to localhost.
- Extensions are not mentioned.
- https://github.com/Cap-go/capacitor-fast-sql, checked 2026-10-08.

**Is there a synchronous route? None found.** Two untested ideas, neither with any report found:

- **A synchronous XHR from a Worker** to such a local server. MDN: "Synchronous requests are permitted in
  Workers." https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/open, checked 2026-10-08.
  Nobody doing this with a SQLite plugin was found.
- **Android's `@JavascriptInterface`**, which returns values synchronously to page JS. Whether it is
  reachable from a Web Worker: not found. iOS offers no equivalent: not found.

### A.5 wa-sqlite and its VFSes

- From wa-sqlite's VFS table:
  - Synchronous builds are supported by `AccessHandlePoolVFS` and `OPFSCoopSyncVFS`, both "Worker" only.
  - `IDBBatchAtomicVFS` needs an Asyncify or JSPI build and works in all contexts.
  - `AccessHandlePoolVFS` "is restricted to a single wa-sqlite instance".
  - `OPFSCoopSyncVFS` allows multiple connections and relies on a "retry hack".
  - https://github.com/rhashimoto/wa-sqlite/blob/master/src/examples/README.md, checked 2026-10-08.
- **wa-sqlite's JS API is Promise-based even in its synchronous build.** `exec`, `step`, `open_v2` and
  `close` return `Promise<number>`: "a few functions return a Promise in order to accomodate either a
  synchronous or asynchronous SQLite build". https://rhashimoto.github.io/wa-sqlite/docs/interfaces/SQLiteAPI.html, checked 2026-10-08.
  - **So it cannot serve synchronous server code** without rewriting the calls.
- By contrast, `@sqlite.org/sqlite-wasm`'s oo1 API returns directly: `Stmt.step()` "a truthy value is
  returned"; `DB.exec()` "returns this object". https://sqlite.org/wasm/doc/trunk/api-oo1.md, checked 2026-10-08.
  - `installOpfsSAHPoolVfs()` returns a Promise once. After that, `PoolUtil.OpfsSAHPoolDb` is an `oo1.DB`
    subclass.
  - `pauseVfs()` / `unpauseVfs()` (since 3.50) release and reacquire the pool's handles.
  - Multiple connections to one database are unsupported "except: Within the same thread, one caveat being
    that a latent locking bug in versions prior to 3.54 … can lead to corruption".
  - `importDb` and `exportFile` exist.
  - https://sqlite.org/wasm/doc/trunk/persistence.md, checked 2026-10-08.
  - The current npm release is 3.53.4-build2 (Apache-2.0, 2026-10-02), npm registry, checked 2026-10-08.
  - **Inference:** open one connection per database file.
- Licences and versions:
  - wa-sqlite is "MIT License as of February 10, 2023" — https://github.com/rhashimoto/wa-sqlite, checked 2026-10-08.
  - The npm package `wa-sqlite` is at 1.0.0 (2024-01-05) — npm registry, checked 2026-10-08.
- Webview support of these VFSes: beyond PowerSync's Capacitor note (A.2), not found.

---

## Section B: can the phone app keep lasting access to a folder or file the user picks in OneDrive?

### Verdict B

**Picking a OneDrive folder through the system picker cannot be relied on today, on either platform.**

- **Android.**
  - No source shows OneDrive, Google Drive or Dropbox supporting folder (tree) selection.
  - The one general statement found is that "few cloud storage providers seem to support
    `ACTION_OPEN_DOCUMENT_TREE`".
  - Picking a single OneDrive file and writing it back works anecdotally. There is one report of a OneDrive
    file being written incompletely.
- **iOS.**
  - Apple's API gives persistent, writable folder access through bookmarks.
  - Through 2021, though, OneDrive, Dropbox, Google Drive and Box were greyed out when picking a folder.
  - Dropbox has since added folder access (iA Writer, 2024).
  - OneDrive is mid-move to Apple's Replicated File Provider API, with rollout due to finish in early
    November 2026. Folder picking after that is unknown.
  - Google Drive: not found.
- **Capacitor plugins.** Only Capawesome's paid File Manager and one small MIT plugin (0.1.0, 4 stars)
  give persistent folder read and write.
- **The cloud APIs work directly:**
  - OneDrive's app folder (`approot`) through Microsoft Graph;
  - Dropbox's App Folder;
  - Google's hidden `appDataFolder`.
  - Each needs OAuth from the app. Google on Android requires its native authorization API.

### Recommended approach B

1. **On the phone, talk to the cloud API directly.** Use OneDrive's Graph app folder first, with sign-in in the system browser using
   PKCE. Then add Dropbox (App Folder) and Google Drive (`appDataFolder` or `drive.file`).
2. **On the desktop, keep the plain sync folder.** The OneDrive client writes it, so no API is needed there. Both
   paths land in the same `Apps/<app>` folder. **Inference:** Graph's app folder is an ordinary folder
   in the user's OneDrive (its docs say so), so the desktop client syncs it like any other folder.
3. **Keep manual export/import as the universal fallback.**
4. **Treat SAF or bookmark folder access as an optional extra** for providers that a device test shows work.

### B.1 Android: the Storage Access Framework

**What Android documents**

- `ACTION_OPEN_DOCUMENT_TREE` "allows the user to grant access to an entire directory tree".
- Android 11+ refuses:
  - the storage root, SD-card roots and `Download`;
  - individual files under `Android/data/` and `Android/obb/`.
- A grant "lasts until the user's device restarts" unless the app calls `takePersistableUriPermission()`.
  Even then, access is lost "if the associated document is moved or deleted".
- `DocumentFile.canWrite()` can mislead; "query the value of `FLAG_SUPPORTS_WRITE` directly".
- `ACTION_CREATE_DOCUMENT` "cannot overwrite an existing file"; it appends a number instead.
- https://developer.android.com/training/data-storage/shared/documents-files, checked 2026-10-08.

**What a provider must do**

- To support creating files, the root needs `FLAG_SUPPORTS_CREATE`, and each directory needs
  `FLAG_DIR_SUPPORTS_CREATE` plus `createDocument()`.
- Network providers may download inside `openDocument()`.
- https://developer.android.com/guide/topics/providers/create-document-provider, checked 2026-10-08.

**Limits on persisted grants**

- 128 persisted grants before Android 11 and 512 from Android 11.
  https://commonsware.com/blog/2020/06/13/count-your-saf-uri-permission-grants.html, checked 2026-10-08.
- Capawesome adds that the system "silently releases the oldest persisted grants above" the cap.
  https://capawesome.io/blog/capacitor-persistent-folder-access/ (2026-10-06), checked 2026-10-08.

**Cloud providers**

- **General.** "few cloud storage providers seem to support `ACTION_OPEN_DOCUMENT_TREE`" — whether a tree
  maps to anything "is up to the implementers of the user-selected document provider".
  https://commonsware.com/blog/2019/11/09/scoped-storage-stories-trees.html (2019), checked 2026-10-08.
- Capawesome (2026): building a URI for a file that doesn't exist yet "only works for path-structured
  document providers … A cloud provider shown in the picker may not support it."
  https://capawesome.io/blog/capacitor-persistent-folder-access/, checked 2026-10-08.
- **OneDrive.**
  - Folder (tree) picking: **not found** in any official or definitive source.
  - Single files: a 2021 report (Android 10) says files picked from OneDrive through the system picker work
    read/write in KeePassDX. https://github.com/PhilippC/keepass2android/issues/1531, checked 2026-10-08.
  - Corruption: a 2021 developer report says OneDrive for Android 6.41 corrupted text files saved through the
    system picker. `A B C D E`, saved as `A B 1`, reopened as `A B 1 D E`. Local, Google Drive and Dropbox
    files were fine, and Microsoft gave no fix.
    https://learn.microsoft.com/en-us/answers/questions/606349/onedrive-for-android-can-corrupt-text-files, checked 2026-10-08.
  - Android's javadoc: `openOutputStream(uri)` is a synonym for mode `"w"`, and "the implementation of "w"
    is up to each Provider implementation and it may or may not truncate". The modes listed are "r", "w",
    "wt", "wa", "rw" and "rwt".
    https://learn.microsoft.com/en-us/dotnet/api/android.content.contentresolver.openoutputstream (mirrors the Android javadoc), checked 2026-10-08.
    CommonsWare's book uses `"rwt"` because "“wt” is not a documented option" (in the docs it was
    written against). https://commonsware.com/AndExplore/pages/chap-t29-005, checked 2026-10-08.
  - **Inference:** the corruption pattern matches a non-truncating `"w"` write. Always write with `"wt"`
    or `"rwt"`.
- **Google Drive.**
  - Tree picking: no official statement found.
  - A 2021 user report says the Android folder picker "doesn't list the Google Drive option".
    https://forum.obsidian.md/t/third-party-syncing-folders-not-visible-in-file-picker-android/20978, checked 2026-10-08.
- **Dropbox.** Tree picking: not found. The only SAF Dropbox provider found is an unofficial third-party app.
  https://github.com/jiro-aqua/document-provider-dropbox-android, checked 2026-10-08.

### B.2 iOS: the document picker, bookmarks and File Provider extensions

**What Apple documents** (https://developer.apple.com/tutorials/data/documentation/uikit/providing-access-to-directories.json, checked 2026-10-08)

- "In iOS 13, users can select a directory from any of the available file providers using a
  UIDocumentPickerViewController."
- The returned security-scoped URL lets the app "recursively access the directory and all of its contents,
  which includes accessing any new items you add". It can be used "to add, remove, or modify any files".
- "Your app can even save a bookmark for this URL, letting it access the directory the next time it
  launches". Save it with `.minimalBookmark`, resolve it with `URL(resolvingBookmarkData:bookmarkDataIsStale:)`.
- Access needs `startAccessingSecurityScopedResource()` and a file coordinator.
- Users can revoke access in Settings > Privacy > Files and Folders. "Calls to the
  startAccessingSecurityScopedResource() method can fail … especially true when … resolving bookmarks".

**What developers report**

- **2019–2021: third-party providers greyed out.**
  - "every 3rd party file provider is grayed out. Only "On this Device" and "iCloud Drive" are available"
    (iOS 13 through 15).
  - "I tried all the mainstream apps, such as Google Drive, Dropbox, Box, OneDrive … none of them worked";
    Secure ShellFish did.
  - The bug report (FB9703910) was unresolved per Apple DTS.
  - https://developer.apple.com/forums/thread/691738, checked 2026-10-08.
  - Same report in 2019: https://developer.apple.com/forums/thread/120257, checked 2026-10-08.
- **2023: a third-party claim of a fix.** A developer says "Since iOS 16 it has also been possible to implement
  NSFileProviderReplicatedExtension which makes folder picking possible".
  https://developer.apple.com/forums/thread/120257, checked 2026-10-08. Not an Apple statement.

**Dropbox**

- iA Writer (2024-05-24): Dropbox "finally has a native Files app integration"; you can "click the Add
  Location button … then select the Dropbox folder or subfolders".
- A known issue at the time: "Dropbox 380.3 is failing to automatically sync externally edited files on
  iPhones and iPads". https://ia.net/topics/i-want-you-back-the-dropbox-remix, checked 2026-10-08.
- Dropbox's own limits in Files:
  - no "Opening folders with more than 10,000 files or folders";
  - "If a passcode is set up for the Dropbox app, your Dropbox folder isn't available in the Files app";
  - simultaneous edits "create conflicted copies".
  - https://help.dropbox.com/integrations/ios-files-app, checked 2026-10-08.

**OneDrive**

- 2021: OneDrive iOS 12.18+ put the Files app into read-only mode, with "no ETA".
  https://learn.microsoft.com/en-us/answers/questions/5100252/onedrive-save-button-and-folders-grayed-out-on-iph, checked 2026-10-08.
  When writing returned: not found.
- 2026: Microsoft 365 roadmap 568761 (published 2026-08-05, "In development", GA "August CY2026"): "OneDrive is
  updating its integration with the iOS Files app to use Apple's Replicated File Provider API".
  Read-only Shared and Libraries locations leave the Files app. https://mc.merill.net/message/RM568761, checked 2026-10-08.
- Message Center MC1458481: "Rollout will begin in mid-August 2026 and is expected to complete by early
  November 2026" (updated 2026-08-28; third-party repost).
  https://mwpro.co.uk/blog/2026/08/28/mc1458481-onedrive-improves-apple-files-integration-and-removes-read-only-shared-locations/, checked 2026-10-08.
- Whether a third-party app can now pick a OneDrive **folder**: not stated → device test.

**Google Drive**: folder picking from a third-party app: not found.

**File-level access**: KeePassium lists "full support" for OneDrive, Dropbox and Google Drive through the
Files app (tested 2023-07). https://support.keepassium.com/kb/sync/, checked 2026-10-08.

**Survives restarts and allows new files?**

- Apple's docs say yes, for any provider the picker allows.
- For OneDrive and Google Drive folders, whether the picker allows them at all is unproven.

### B.3 Capacitor plugins for persistent folder access

Versions and dates are from the npm registry, checked 2026-10-08, unless noted. Each row was also checked
against its native source code on 2026-10-08.

| Plugin | Version · date · licence | Platforms | Persistent folder access | Read/write in the folder |
|---|---|---|---|---|
| `@capawesome/capacitor-file-picker` | 8.1.0 · 2026-09-05 · MIT | Android, iOS (`pickDirectory`) | **Android: no.** The source sets `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` on the intent but never calls `takePersistableUriPermission`, and returns `uri.toString()`. **iOS:** returns a base64 bookmark (`url.bookmarkData()`, default options) since 8.1.0, but has no method to resolve it. | None — no list/read/write inside the folder |
| `@capawesome-team/capacitor-file-manager` | Insiders (paid); announced 2026-09-21/25; needs Capacitor 8+; not on public npm | Android, iOS (+ web for other methods) | Yes: `persistDirectoryAccess`, `getPersistedDirectories`, `releaseDirectoryAccess` (Android persistable URI, iOS bookmark) | Yes: `readDirectory`, `writeFile` (recursive creates folders), `copyFile`, `getUri`, `clearDirectory`… — Promise API |
| `@daniele-rolli/capacitor-scoped-storage` | 0.1.0 · 2026-08-15 · MIT (4 GitHub stars, created 2025-08-20) | Android (SAF), iOS (bookmarks); iOS 14+, API 21+ | Yes. Android calls `takePersistableUriPermission(uri, READ \| WRITE)`; iOS resolves bookmarks with a staleness check | Yes: read/write/append/readdir/mkdir/rmdir/delete/stat/exists/move/copy. **Android writes use `openOutputStream(uri, "w")`**, the mode Android says may not truncate |
| `@capgo/capacitor-file-picker` | 8.2.3 · 2026-10-08 · MPL-2.0 | Android, iOS (`pickDirectory`) | No: no persistable call on Android, no bookmark on iOS | None documented |
| `@capacitor/filesystem` | 8.1.4 · 2026-10-02 · MIT | Android, iOS, web | No. Docs: it supports "reading `content://` files on Android" only. PR #2078 (content-URI `stat`/`readdir`) closed **unmerged** 2025-07-11 | No SAF tree support |
| `aio-capacitor-folder-picker` / `capacitor-folder-picker` | 1.0.5 · 2026-09-13 · MIT / 0.0.2 · 2024-03-15 · MIT | — | Not evaluated: the first one's GitHub repo returned 404; the second is 2024 and 0.0.x | — |

Sources:

- https://capawesome.io/docs/plugins/file-picker/ and its Android and iOS source in
  https://github.com/capawesome-team/capacitor-plugins (`packages/file-picker`), checked 2026-10-08.
- https://capawesome.io/blog/announcing-the-capacitor-file-manager-plugin/,
  https://capawesome.io/blog/capacitor-persistent-folder-access/, checked 2026-10-08.
- https://github.com/Daniele-rolli/capacitor-scoped-storage and its source, checked 2026-10-08.
- https://github.com/Cap-go/capacitor-file-picker and its source, checked 2026-10-08.
- https://capacitorjs.com/docs/apis/filesystem, https://api.github.com/repos/ionic-team/capacitor-plugins/pulls/2078, checked 2026-10-08.

### B.4 The alternative: calling the cloud APIs directly

**Microsoft Graph and OneDrive's app folder**

- **The app folder exists.**
  - `GET /me/drive/special/approot` creates and returns `Apps/{Entra app name}` on first call.
  - Scope `Files.ReadWrite.AppFolder`, delegated or application.
  - It supports normal item operations, including `delta` for change tracking.
  - "users can add, modify, and remove content from it".
  - It counts against the user's quota.
  - https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder (ms.date 2025-03-14),
    https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/special-folders-appfolder, checked 2026-10-08.
- **Microsoft's docs disagree on work and school accounts.**
  - The Graph concept page (2025) says "App folder works across OneDrive for work or school and OneDrive for home".
  - The older OneDrive permissions reference (ms.date 2017) marks the scope "(preview)" and says it "is only
    valid for personal accounts".
    https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/permissions_reference, checked 2026-10-08.
  - → Test with a work account.
- **Downloading from JS needs a workaround.** `/content` answers with a 302, which "is explicitly prohibited when a CORS preflight is
  required". JavaScript apps should select `@microsoft.graph.downloadUrl` (preauthenticated, "might
  expire within minutes"). https://learn.microsoft.com/en-us/graph/api/driveitem-get-content, checked 2026-10-08.
- **Sign-in.**
  - Apps that run natively register redirect URIs under "Mobile and desktop applications". The docs list
    React Native and Electron. HTTP is allowed only for localhost; other URIs must be `https`, "with
    exceptions for some localhost redirect URIs".
    https://learn.microsoft.com/en-us/entra/identity-platform/reply-url, checked 2026-10-08.
    The page shows no custom-scheme example. Whether a custom scheme is accepted under that platform:
    not stated there.
  - A Capgo guide (2026-10-01) says MSAL.js "is built for browsers that own their origin and can open
    popups", so it doesn't fit a Capacitor WebView. It recommends the system browser with PKCE
    (ASWebAuthenticationSession / Custom Tabs) through `@capgo/capacitor-social-login`, with a redirect such
    as `com.example.app://oauth/azure` registered under "Mobile and desktop applications". It says Entra
    public-client refresh tokens "last up to 90 days with a sliding window".
    https://capgo.app/blog/how-to-sign-in-with-azure-entra-id-using-capacitor/, checked 2026-10-08. Vendor source.
  - An official Microsoft MSAL plugin for Capacitor: not found.

**Dropbox**

- Access types: "App Folder" (the app's own folder under `/apps`) or "Full Dropbox".
- PKCE is meant for "Desktop and mobile apps without a server".
- Access tokens are short-lived; get a refresh token with `token_access_type=offline`.
- Redirect URIs must be registered exactly. Custom schemes are not addressed on the page.
- https://docs.dropboxapi.com/dropbox-api/docs/oauth, checked 2026-10-08.

**Google Drive**

- **`appDataFolder`** (scope `drive.appdata`, non-sensitive): "a special hidden folder … only accessible by
  your app". The user can't see it in the Drive UI. Its contents can't be shared or trashed. It is "deleted
  when a user uninstalls your app from their My Drive".
  https://developers.google.com/workspace/drive/api/guides/appdata, checked 2026-10-08.
- **Scope classes:**
  - `drive.file` is non-sensitive (files the user opens with or shares to the app);
  - full `drive` is restricted, needing verification, and a security assessment if data reaches servers.
  - https://developers.google.com/workspace/drive/api/guides/api-specific-auth, checked 2026-10-08.
- **Sign-in rules.**
  - "Custom URI schemes are no longer supported on Android and Chrome apps".
  - Loopback is "DEPRECATED for Android, Chrome app and iOS".
  - Embedded user-agents (e.g. WKWebView) are disallowed.
  - PKCE is supported.
  - https://developers.google.com/identity/protocols/oauth2/native-app, checked 2026-10-08.
- **On Android, authorization goes through `AuthorizationClient`.**
  - `Identity.getAuthorizationClient(activity).authorize(...)` with e.g. `DriveScopes.DRIVE_FILE`.
  - Access tokens last one hour.
  - Refresh tokens come only by exchanging a server auth code on a backend, and "it is strongly
    discouraged to store refresh tokens on the device".
  - https://developer.android.com/identity/authorization, checked 2026-10-08.
  - **Inference:** Google Drive on Android needs a native plugin, and fits our-own-server or online use better
    than a serverless phone.

### B.5 The desktop side: OneDrive Files On-Demand on Windows

**Reading a placeholder downloads it**

- Placeholders "automatically hydrate into full files under normal use conditions", whatever API the app
  uses.
- A placeholder is "only available if the sync service is available".
- A hydrated file "could be dehydrated by the system if space is needed".
- A background hydration that the user didn't ask for shows a toast. The user can block that app, and unblock
  it under Settings → Automatic file downloads.
- The default hydration policy is progressive.
- https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine, checked 2026-10-08.
- Online-only files can't be opened offline. Files created on the device are available offline by default.
  Storage Sense can turn files back online-only.
  https://support.microsoft.com/en-us/office/save-disk-space-with-onedrive-files-on-demand-for-windows-0e6860d3-d9f3-4971-b321-7092438fb38e, checked 2026-10-08.
- A 2023 user report: OneDrive files could not be opened, copied or moved, with "Error 0x8007016A: The
  cloud file provider is not running". A community answer (not Microsoft staff) says it "could mean that
  OneDrive syncing is turned off"; resetting OneDrive fixed it for one user.
  https://learn.microsoft.com/en-us/answers/questions/4166541/error-0x8007016a-the-cloud-file-provider-is-not-ru, checked 2026-10-08.

**Many files, temp files and names**

- "Temporary TMP files will not be synced to OneDrive."
- Names that aren't allowed include `.lock`, `desktop.ini` and anything starting `~$`, plus `" * : < > ? / \ |`.
- "we recommend syncing no more than a total of 300,000 items". Nothing specific about many *small* files.
- https://support.microsoft.com/en-us/office/restrictions-and-limitations-in-onedrive-and-sharepoint-64883a5d-228e-48f5-b3d2-eb39e07630fa, checked 2026-10-08.
- **Inference:** one change file per device is far below the 300,000 limit.

**Writing with tmp + rename**

- How Windows OneDrive treats a rename onto an existing file (an update of the same item, or delete plus
  create, and whether version history is kept): **not found** in Microsoft documentation.
- The only atomic-save report found is for a third-party Linux client, closed "Not a bug".
  https://github.com/abraunegg/onedrive/issues/3439, checked 2026-10-08.
- **Inference:** a temp name ending `.tmp` is not uploaded, so only the renamed final file syncs.

---

## What only a device test can settle

**The phone's database (Section A)**

1. **Secure context and OPFS in the Worker.**
   - Inside the Capacitor Worker on each platform, check `isSecureContext`, `navigator.storage.getDirectory()`
     and `createSyncAccessHandle`.
   - Then `installOpfsSAHPoolVfs()`: open, write, read.
   - Run this on Android WebView (current and the oldest supported) and on iOS 16.4/17, 18 and 26.
2. **Durability across the app's lifecycle.** Write, then force-stop and reopen, reboot the phone, install an
   app update over it, and back up and restore the device. Does the data survive each step?
3. **Background.** Background the app for minutes to hours, resume, write. Are the access handles still valid
   (PowerSync's Capacitor report)?
   - Does releasing them on pause with `pauseVfs()` and taking them back on resume with `unpauseVfs()` help?
4. **A killed worker.** Kill the Worker or app mid-transaction, then reopen and run `PRAGMA integrity_check`.
   Does WebKit "poison" OPFS until the next launch?
5. **Persistence and quota.** What `navigator.storage.persist()`, `persisted()` and `estimate()` return in each
   webview (Android is expected to deny, by its code).
6. **File size.** Does WKWebView limit an OPFS file to 10 MB (the single unofficial claim)? Grow a database past
   50 MB.
7. **Eviction.** Fill the Android device's storage and see whether WebView data is evicted. iOS eviction
   ("not used for some time", the 7-day question) can't be tested quickly; it can only be watched over weeks.

**Folder access on the phone (Section B)**

8. **Android: OneDrive, Google Drive and Dropbox apps.**
   - Does `ACTION_OPEN_DOCUMENT_TREE` offer each provider at all?
   - Can the app create a file in the folder (`createDocument`)?
   - Does a `"wt"` / `"rwt"` overwrite leave the exact bytes?
   - Does a persisted grant survive a reboot?
9. **iOS: `UIDocumentPickerViewController([.folder])`** on OneDrive (after the Replicated File Provider rollout),
   Dropbox and Google Drive.
   - Is each provider selectable?
   - Can the app write a new file?
   - Does the bookmark resolve after relaunch, after a reboot, and with the provider offline?

**Cloud APIs**

10. **Graph app folder.** `Files.ReadWrite.AppFolder` with a work or school account, where Microsoft's two pages
    disagree.
11. **Entra redirect.** Is a custom-scheme redirect accepted under "Mobile and desktop applications"
    (system browser with PKCE)?

**The desktop**

12. **Windows OneDrive with tmp + rename.** In a OneDrive folder, write `x.tmp` and rename it over `x`.
    - Is it uploaded as an update to the same item, with version history?
    - What happens when `x` is online-only, when OneDrive is paused or not running (0x8007016A), and when
      the phone's copy changed at the same time?

**A synchronous native path (only if one is wanted)**

13. **Synchronous XHR from a Worker** to a local SQLite HTTP server (e.g. Capgo Fast SQL's): does it work on
    Android and iOS, and how slow is it?
