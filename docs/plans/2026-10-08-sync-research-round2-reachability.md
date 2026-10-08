<!-- SPDX-License-Identifier: MIT -->
# Sync round 2: how a phone reaches the laptop's server

Web research only. Written 2026-10-08. No repo file was changed.

**Scope.** The phone app (Quasar on Capacitor, Android and iOS, system webview) has to reach the
Node 24 server (Fastify + SQLite) inside the Electron desktop app. That server can also run
headless on a laptop or a rented server. Covered here: the same Wi-Fi, the internet with no router
setup, what other self-hosted apps do, and a ladder of options.

**The rule applied (the user's ruling, relayed by the coordinator mid-task):** only open-source
solutions, or one we build. Nothing paid or proprietary, and that includes "free but closed" hosted
services. Licences we may ship inside the app: MIT, Apache-2.0, BSD, ISC, FSL. A separate program the
user installs is a softer constraint, and each option says which case it is.

**A grey zone for the user to decide (not decided here):** some options depend on *open-source
software that a third party runs as a free public service*:
- Syncthing's relay pool and discovery servers;
- n0's public iroh relays;
- the Hyperswarm DHT bootstrap nodes;
- public Nostr relays (used by Trystero and by Obsidian LiveSync);
- Tailscale's DERP relays.

Each of them can be replaced by a copy you run yourself. Whether the free public instances count as
"free but closed hosted services" is the user's call.

**How facts were checked:** official docs and pricing pages; `gh api repos/<repo>` for licence,
archive state, last push and latest release; `https://registry.npmjs.org/<pkg>` for npm versions and
licences. Every source below was checked 2026-10-08.

---

## 1 · Same Wi-Fi, no setup

### 1.1 Discovery (mDNS / Bonjour / DNS-SD)

**Laptop side (Node, ships inside our app):**
- `bonjour-service` 1.4.4: MIT. "Publish services on the local network or discover existing
  services using multicast DNS." Last release 2026-07-28.
  Sources: https://registry.npmjs.org/bonjour-service, https://github.com/onlxltd/bonjour-service
  (checked 2026-10-08).
- `@homebridge/ciao` 1.3.12: MIT. An RFC 6763 dns-sd library that advertises over mDNS. Used by
  HAP-NodeJS. Last release 2026-08-15.
  Sources: https://registry.npmjs.org/@homebridge/ciao, https://github.com/homebridge/ciao
  (checked 2026-10-08).
- `multicast-dns` 7.2.5: MIT. Last release 2022-05-16.
  Source: https://registry.npmjs.org/multicast-dns (checked 2026-10-08).
- **Not checked:** how mDNS behaves on Windows for the Electron or Node process (the firewall prompt,
  sharing port 5353).

**Phone side (Capacitor plugins; these ship inside our app):**

| Plugin | Version, date | Licence | Platforms | Notes |
|---|---|---|---|---|
| `capacitor-zeroconf` (trik) | 4.0.0, 2025-05-09; peer `@capacitor/core >=7` | npm says MIT; the repo has no LICENSE file | Android, iOS, Electron ("browse and publish") | Ported from cordova-plugin-zeroconf. "This is not a background service." 10 stars. |
| `@mhaberler/capacitor-zeroconf-nsd` | 5.0.5, 2026-07-01; peer `>=8` | MIT (npm) | not stated | Its repository field points to trik's repo; no repo of its own was found (404). |
| `@devioarts/capacitor-mdns` | 0.1.0, 2026-07-07; peer `>=8` | npm says MIT; the repo has no LICENSE file | iOS, Android, Electron, web fallback | Last commit 2026-07-07. 8 stars. Pre-1.0. |
| `@byrds/capacitor-mdns` | 7.0.0, 2026-08-03; peer `>=7` | MIT (npm) | not checked | 0 stars. |

Sources: https://registry.npmjs.org/capacitor-zeroconf,
https://registry.npmjs.org/@mhaberler/capacitor-zeroconf-nsd,
https://registry.npmjs.org/@devioarts/capacitor-mdns, https://registry.npmjs.org/@byrds/capacitor-mdns,
https://github.com/trik/capacitor-zeroconf, https://github.com/devioarts/capacitor-mdns (all checked
2026-10-08). No official `@capacitor/*` or `@capacitor-community/*` mDNS plugin was found in an npm
search for "capacitor zeroconf" and "capacitor mdns" (checked 2026-10-08).

**iOS local-network privacy (Apple TN3179):**
https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
(checked 2026-10-08)
- The first local-network operation shows a system alert, which the user can allow or deny. The
  feature arrived on iOS with WWDC 2020.
- Add `NSLocalNetworkUsageDescription` to Info.plist.
- Bonjour browsing or registering needs the service types listed in `NSBonjourServices`.
- "All Bonjour operations require local network access."
- The multicast entitlement is needed only for "arbitrary Bonjour service types" or "browsing for all
  advertised service types". Browsing one declared type does not need it.
- **"Traffic originating from WKWebView, SFSafariViewController, and Safari doesn't require local
  network access."** So the webview's own `fetch` to a LAN address needs no permission.
- A native plugin does need the permission: the check covers the "URL Loading System", so it covers
  the mDNS plugin and CapacitorHttp.
- VPN interfaces are not "local network". So a 100.x tailnet address, for example, does not trigger
  the alert.
- When an app is in the background with the permission undetermined, the operation is denied
  without an alert.
- The simulator does not support local network privacy, so test on a device.

**Android local-network permission:**
https://developer.android.com/privacy-and-security/local-network-permission (checked 2026-10-08)
- "Starting in Android 17, local network protections are mandatory and enforced for apps targeting
  Android 17 or higher" (target SDK 37).
- The permission is `ACCESS_LOCAL_NETWORK`. It is a runtime permission in the `NEARBY_DEVICES`
  group.
- It covers outgoing and incoming TCP, UDP, mDNS, `NsdManager` and `.local` resolution.
- **"Traffic originating from Android Webviews that require local network access will inherit
  permission state from the host app."**
- Apps targeting SDK 36 or lower get it implicitly through `INTERNET`.
- Google Play requires API 36 for new apps and updates from 2026-08-31. No API 37 requirement is
  announced. Source: https://support.google.com/googleplay/android-developer/answer/11926878
  (checked 2026-10-08).
- Chrome's own "Local Network Access" site prompt does not apply to Android WebView. There, "the
  Local Network Access permission is currently unconditionally granted".
  Source: https://groups.google.com/a/chromium.org/g/blink-dev/c/cwu_RUmBpzY/m/hk8YuZDWHgAJ
  (checked 2026-10-08).

### 1.2 Pairing (a QR code with the address and a token)

**Precedent: Obsidian LiveSync** (MIT) shares connection settings as a passphrase-encrypted "Setup
URI" or as a QR code. "QR codes retain their existing unencrypted format and 'FOR YOUR EYES ONLY'
display." Source: https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/p2p.md (checked
2026-10-08).

**Scanning a QR code on the phone:**
- `@capacitor/barcode-scanner` 3.1.3: MIT, official, last release 2026-10-07.
  - Its Android build links **both** `com.google.mlkit:barcode-scanning:17.3.0` and
    `com.google.zxing:core:3.5.3`. A `scanningLibrary` option picks `ZXING` or `MLKIT`.
  - Google ML Kit is Google's SDK. Its licence was not checked. **If it is closed, shipping it may
    conflict with the open-source rule — the user's call.**
  - Sources: https://registry.npmjs.org/@capacitor/barcode-scanner,
    https://github.com/ionic-team/capacitor-barcode-scanner/blob/main/plugin/android/build.gradle
    (checked 2026-10-08).
- `@capacitor-mlkit/barcode-scanning` 8.2.1: Apache-2.0, a wrapper around ML Kit. Last release
  2026-09-10. Source: https://registry.npmjs.org/@capacitor-mlkit/barcode-scanning (checked
  2026-10-08).
- **Pure JavaScript in the webview** (no native SDK): `zxing-wasm` 3.1.5 (MIT, 2026-10-06) and the
  `barcode-detector` 3.2.2 polyfill (MIT, 2026-08-16). `jsqr` 1.4.0 (Apache-2.0) was last released
  2021-04-24. These need `getUserMedia` in the webview.
  - WKWebView gained `getUserMedia` in iOS 14.3. That is reported only by forums and a vendor
    article; no Apple primary source was found:
    https://support.kioskgroup.com/article/920-webrtc-getusermedia-not-supported,
    https://forum.ionicframework.com/t/webrtc-in-ios-14-3-iframe-wkwebview-external-resource/202088
    (checked 2026-10-08).
  - Sources for the packages: https://registry.npmjs.org/zxing-wasm,
    https://registry.npmjs.org/barcode-detector, https://registry.npmjs.org/jsqr (checked
    2026-10-08).
- **Making the code on the desktop:** `qrcode` 1.5.4, MIT, 2024-08-05.
  Source: https://registry.npmjs.org/qrcode (checked 2026-10-08).

### 1.3 HTTP vs HTTPS on the LAN

**Android:**
- "Starting with Android 9 (API level 28), cleartext support is disabled by default." An app opts
  in through a Network Security Config: `<domain-config cleartextTrafficPermitted="true">` per domain,
  or on `base-config` for everything. Source:
  https://developer.android.com/privacy-and-security/security-config (checked 2026-10-08).
- From Android 17, only *loopback* (localhost, 127.0.0.1, ::1) is implicitly allowed cleartext.
- The page does not say whether a numeric LAN IP or a CIDR range can go in `<domain>`: **not found.**
- "WebView honors this attribute [usesCleartextTraffic] for applications targeting API level 26 and
  higher." The attribute "will be ignored for apps targeting API levels 38 and above"; use a Network
  Security Config instead. Source:
  https://developer.android.com/guide/topics/manifest/application-element (checked 2026-10-08).
- Capacitor config: `server.androidScheme` defaults to `https`, so the app page is
  `https://localhost`. `server.cleartext` defaults to `false`. `android.allowMixedContent` defaults
  to `false`: "This is not intended for use in production." Source:
  https://capacitorjs.com/docs/config (checked 2026-10-08).
- "In Capacitor 6, `https` is the default setting for `androidScheme`." Changing the scheme "is the
  equivalent to shipping your application on a different domain" (data loss). Source:
  https://capacitorjs.com/docs/updating/6-0 (checked 2026-10-08).
- **So a plain-HTTP fetch from the Android webview to `http://192.168.x.x` is blocked twice:** by
  cleartext rules and by mixed content (an https page loading http). Forum reports agree, but they
  are not official docs:
  https://forum.ionicframework.com/t/mixed-content-error-in-http-calls/249325 (checked 2026-10-08).

**iOS:**
- **ATS:** `NSAllowsLocalNetworking` lets ATS connect to "unqualified domains, `.local` domains, and
  IP addresses". "In iOS 17, iPadOS 17, and macOS 14, ATS no longer allows connections to IP
  addresses by default." Source:
  https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking
  (checked 2026-10-08).
- ATS also covers web views: `NSAllowsArbitraryLoadsInWebContent` exists to "disable ATS restrictions
  on calls made from within web views, like instances of WKWebView". Source:
  https://developer.apple.com/documentation/security/preventing-insecure-network-connections
  (checked 2026-10-08).
- Capacitor's `server.iosScheme` defaults to `capacitor`, so the page is `capacitor://localhost`.
  Source: https://capacitorjs.com/docs/config (checked 2026-10-08).
- Whether WKWebView blocks an `http://` fetch from a `capacitor://` page as mixed content: **an
  authoritative statement was not found.**
  - Forum reports say custom schemes count as secure in WKWebView, and that CORS (allowing the
    `capacitor://localhost` origin) is the usual blocker. Sources:
    https://forum.ionicframework.com/t/local-network-url-can-t-be-acessed-when-building-app/239607,
    https://developer.apple.com/forums/thread/725916 (checked 2026-10-08).
  - **Needs a device test.**

**CapacitorHttp (a way around the webview):** it can patch `fetch` and `XMLHttpRequest` "to use
native libraries". It is off by default and turned on with `CapacitorHttp.enabled: true`.
- On Android and iOS a native request body "can only be a string or a JSON".
- For large transfers the page points to `@capacitor/file-transfer`.
- It says nothing about streaming, SSE or CORS. Source: https://capacitorjs.com/docs/apis/http
  (checked 2026-10-08).
- On iOS this native traffic *does* need local-network permission (TN3179, above).

**How others get HTTPS on a LAN:**
- **Self-signed certificate.** Jellyfin: "Self-signed certificates pose security and compatibility
  issues and are strongly discouraged." https://jellyfin.org/docs/general/post-install/networking/
  (checked 2026-10-08). Actual Budget: "the easiest way … but it will cause your browser to display a
  warning". https://actualbudget.org/docs/config/https (checked 2026-10-08).
- **Plex** gets Let's Encrypt certificates and uses "DNS magic" (`plex.direct` hostnames) so that a
  LAN address has a valid certificate. Router "DNS rebinding protection" can block this; the fixes
  are `rebind-domain-ok=/plex.direct/` or another DNS provider. Source:
  https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/ (checked
  2026-10-08).
  - To copy this we would have to run a DNS zone plus an ACME service ourselves ("one we build").
- **Encrypted peer channel instead of HTTPS.** WebRTC data is encrypted between the devices, even
  through TURN. Source: https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/p2p.md (checked
  2026-10-08).
  - libp2p's WebRTC Direct carries a certificate hash in its address "to allow opening a connection to
    the remote, which would otherwise be denied due to use of a self-signed certificate". Source:
    https://github.com/libp2p/js-libp2p/blob/main/packages/transport-webrtc/README.md (checked
    2026-10-08).
  - My inference, not verified on a device: a data channel is not a `fetch`, so the HTTP cleartext
    and mixed-content rules would not apply to it.

---

## 2 · Over the internet, no router setup

### 2.0 The constraint every option shares

When the phone is on cellular and the laptop is behind a home router, some **publicly reachable
machine** is needed: to find the peer (rendezvous or signalling), and to relay traffic when a direct
path fails. Evidence:
- WebRTC: when direct connections fail, "a server is required for relaying the traffic between
  peers". https://webrtc.org/getting-started/turn-server (checked 2026-10-08).
- Signalling "is not part of" WebRTC. https://webrtc.org/getting-started/peer-connections (checked
  2026-10-08).
- Headscale: "A server with a public IP address". https://headscale.net/stable/setup/requirements/
  (checked 2026-10-08).
- iroh-relay: "a server with a public IP and DNS name". https://docs.iroh.computer/add-a-relay
  (checked 2026-10-08).
- NetBird: a Linux VM "reachable from the internet" with a public domain.
  https://docs.netbird.io/selfhosted/selfhosted-quickstart (checked 2026-10-08).
- Syncthing relays: used "when devices can't reach each other directly".
  https://docs.syncthing.net/users/relaying.html (checked 2026-10-08).
- ISPs using CG-NAT can block inbound access entirely.
  https://www.home-assistant.io/docs/configuration/remote/ (checked 2026-10-08).

**So the real choice is who runs that public machine:** a vendor (excluded by the rule), us (we build
and operate it), a third party's free open-source instance (the grey zone), or the user (a rented
server, which is the "run the whole thing as a server" mode).

### 2.1 Excluded by the rule (one line each)

- **ngrok:** excluded. The SDK `@ngrok/ngrok` 1.7.0 is MIT OR Apache-2.0, but it needs an ngrok
  authtoken ("sign up for free at ngrok.com") and forwards through ngrok's hosted gateway.
  https://github.com/ngrok/ngrok-javascript (checked 2026-10-08).
- **Cloudflare Tunnel and Quick Tunnels:** excluded. `cloudflared` is Apache-2.0 (2026.10.0,
  2026-10-05), but it "creates outbound-only connections to Cloudflare's global network", which is
  Cloudflare's service.
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/,
  https://github.com/cloudflare/cloudflared (checked 2026-10-08).
- **Tailscale's hosted service:** excluded. "A closed source coordination server."
  https://tailscale.com/opensource (checked 2026-10-08). Only its open-source parts with Headscale
  remain (§2.2).
- **ZeroTier:** excluded. https://github.com/zerotier/ZeroTierOne (checked 2026-10-08)
  - The agent is MPL-2.0, but the controller (`nonfree/`) is a "Source-Available License for
    Non-Commercial Use", which forbids commercial use without a paid licence.
  - The embedding library `libzt` is BSL 1.1. It forbids linking into "a commercial or for-profit
    application … not distributed under an [OSI] compliant license"; last commit 2024-11-07.
    https://github.com/zerotier/libzt (checked 2026-10-08).
  - No source repo for the iOS or Android apps exists under github.com/zerotier (gh org listing,
    checked 2026-10-08).
- **Möbius Sync** (the iOS Syncthing app): excluded. "The Möbius Sync iOS app is not open source at
  this time"; it is free up to 20 MB, then a one-time purchase. https://mobiussync.com/faq/ (checked
  2026-10-08).

### 2.2 Tailscale's open-source parts + Headscale

**What Tailscale's coordination servers are.** The control server is "an exchange point of
Wireguard public keys for the nodes", and it "assigns the IP addresses of the clients". Tailscale's
own is closed source: "Everything in Tailscale is Open Source, except the GUI clients for proprietary
OS (Windows and macOS/iOS), and the control server." It therefore cannot be self-hosted; Headscale is
the open re-implementation. Sources: https://github.com/juanfont/headscale (README),
https://tailscale.com/opensource (checked 2026-10-08).

- **What the user must set up:**
  - A server with a public IP running Headscale, with tcp/443 (HTTPS) open, plus udp/3478 if its
    embedded DERP relay is on. https://headscale.net/stable/setup/requirements/ (checked 2026-10-08).
  - Headscale's scope is "a _single_ Tailscale network (tailnet), suitable for a personal use, or a
    small open-source organisation". https://github.com/juanfont/headscale (checked 2026-10-08).
  - On the laptop: the Tailscale client (the daemon is open source; the Windows and macOS GUIs are
    closed, and "you can build the Windows and macOS clients without the GUI").
    https://tailscale.com/opensource (checked 2026-10-08).
- **Relays:** by default Headscale uses Tailscale's free DERP servers, and adds its own embedded DERP
  only if enabled. Setting `derp.urls: []` drops Tailscale's DERP map.
  https://headscale.net/stable/ref/derp/ (checked 2026-10-08).
- **Free:** Headscale is free software. The cost is the server.
- **Self-hostable:** yes; that is the point.
- **Licences:** headscale BSD-3-Clause (v0.29.4, 2026-09-23); tailscale BSD-3-Clause (v1.104.1,
  2026-10-07); tailscale-android BSD-3-Clause; libtailscale BSD-3-Clause (no releases; last push
  2026-08-31). All via gh api, checked 2026-10-08.
- **Phone, the official app:**
  - Android works. The open-source app points at Headscale with "Use an alternate server"; installed
    from Google Play or F-Droid. https://headscale.net/stable/usage/connect/android/ (checked
    2026-10-08).
  - iOS works technically ("Use custom coordination server"), but **the iOS app is closed source**,
    so it fails the rule. https://headscale.net/stable/usage/connect/apple/ (checked 2026-10-08).
  - Both are separate programs the user installs. Once the system VPN is up, the webview reaches the
    laptop's tailnet address with a plain `fetch`. That address is an IP, so iOS needs
    `NSAllowsLocalNetworking` (§1.3).
- **Embedding instead of the phone app:**
  - `libtailscale` "embeds Tailscale into a process … entirely from userspace" and has
    `tailscale_set_control_url`, so it can use Headscale.
  - Its `swift/` folder builds **TailscaleKit** for iOS, with "an extension to URLSession which allows
    you to make URL requests to nodes on you Tailnet".
  - **No Android or Kotlin binding** exists in the repo (folders: python, ruby, swift).
  - Sources: https://github.com/tailscale/libtailscale, its `swift/README.md`, `tailscale.h`
    (checked 2026-10-08).
  - So iOS would need a Capacitor plugin we write, and the webview's own `fetch` would not go through
    it.
  - `tsnet` (Go) has `ControlURL`, "the coordination server URL". https://pkg.go.dev/tailscale.com/tsnet
    (checked 2026-10-08). On the laptop that means a Go sidecar beside Node, since no Node binding was
    found.
- **Headscale and HTTPS certificates:** Headscale's features page does not mention
  `tailscale cert` or HTTPS certificates; Funnel and Serve are listed only with links to GitHub
  issues. https://headscale.net/stable/about/features/ (checked 2026-10-08).
- **Maintenance:** all active; pushes on 2026-10-08.

### 2.3 NetBird (self-hosted)

- **What the user must set up:** "A Linux VM with at least 1CPU and 2GB of memory", "A public domain
  name", TCP 80 and 443 plus UDP 3478. An external identity provider is optional (it embeds Dex). The
  quickstart is billed as about 5 minutes. https://docs.netbird.io/selfhosted/selfhosted-quickstart
  (checked 2026-10-08).
- **Licence:**
  - The client and most of the repo are BSD-3-Clause. **`management/`, `signal/`, `relay/` and
    `combined/` are AGPL-3.0.** https://github.com/netbirdio/netbird LICENSE (checked 2026-10-08).
  - The mobile apps are **GPL-3.0**: https://github.com/netbirdio/android-client,
    https://github.com/netbirdio/ios-client (checked 2026-10-08).
  - All of it is open source, but the GPL and AGPL parts can only be separate programs (the user's
    server and the user's phone app). None of it can ship inside our MIT app.
- **Free:** the self-hosted software is. NetBird's hosted cloud is excluded by the rule.
- **Phone:** the official Android and iOS apps (system VPN); the webview then uses the overlay IP.
- **Maintenance:** v0.80.0, 2026-10-01; active.

### 2.4 WebRTC data channels: phone webview ↔ Node server, our own signalling, an open TURN server

**The webview side.** MDN's compat data maps "WebView on iOS" to Safari (RTCPeerConnection and
RTCDataChannel from Safari 11) and Android WebView to Chrome (RTCDataChannel from Chrome 24).
https://github.com/mdn/browser-compat-data/blob/main/api/RTCPeerConnection.json,
https://github.com/mdn/browser-compat-data/blob/main/api/RTCDataChannel.json (checked 2026-10-08).
Running it inside a Capacitor webview: **no device test found.**

**The Node side (ships inside our app):**

| Library | Version, date | Licence | Notes |
|---|---|---|---|
| `werift` | 0.25.0, 2026-10-07 | **MIT** | Written in TypeScript, published as JavaScript. Resolves `.local` mDNS ICE candidates with `multicast-dns` (`packages/ice/src/dns/lookup.ts`). Active (pushed 2026-10-08). |
| `node-datachannel` | 0.33.4, 2026-09-12 | **MPL-2.0** | Bindings to libdatachannel. MPL is file-level copyleft and not on the approved list — the user's call. `@libp2p/webrtc` depends on it in Node. |
| `@roamhq/wrtc` | 0.10.0, 2026-03-10 | BSD-2-Clause | Prebuilt native WebRTC. |

Sources: https://registry.npmjs.org/werift, https://registry.npmjs.org/node-datachannel,
https://registry.npmjs.org/@roamhq/wrtc, https://github.com/shinyoshiaki/werift-webrtc,
https://github.com/murat-dogan/node-datachannel (checked 2026-10-08).

- Browsers can hide host IPs behind random `.local` names in ICE candidates. Sources: the IETF draft
  https://datatracker.ietf.org/doc/draft-ietf-mmusic-mdns-ice-candidates/ and
  https://bloggeek.me/psa-mdns-and-local-ice-candidates-are-coming/ (checked 2026-10-08). The
  werift code above handles that on a LAN.

**Signalling (some reachable rendezvous is required):**
- **Trystero** 0.26.0 (MIT, 2026-10-04): "Peers can connect via BitTorrent, Nostr, MQTT, Supabase,
  Firebase, IPFS, or a self-hosted WebSocket relay".
  - The default package runs on the public Nostr network.
  - "Can run peers server-side on Node", using werift as the `rtcPolyfill`.
  - `@trystero-p2p/ws-relay` 0.26.0 (MIT) is "a tiny relay that you control".
  - Its TURN section names coturn, Pion TURN, Violet and eturnal.
  - It has "default STUN servers", which you can override with `rtcConfig.iceServers`. Which servers
    they are was not checked.
  - Sources: https://github.com/dmotz/trystero, https://registry.npmjs.org/trystero,
    https://registry.npmjs.org/@trystero-p2p/ws-relay (checked 2026-10-08).
- **PeerJS** server `peer` 1.0.2 (MIT): last release 2023-12-05; repo pushed 2026-02-27.
  https://registry.npmjs.org/peer, https://github.com/peers/peerjs-server (checked 2026-10-08).
- Or our own: a few routes on any server that both ends can reach.

**TURN (the relay fallback):**
- **coturn**: "a free open source implementation of TURN and STUN Server". BSD-3-style licence text;
  4.18.0 released 2026-09-08. The Docker example opens 3478 and 5349 (TCP and UDP) and UDP
  49152–65535. https://github.com/coturn/coturn (checked 2026-10-08).
- **eturnal**: Apache-2.0, pushed 2026-10-02. https://github.com/processone/eturnal (checked
  2026-10-08).
- Both are separate programs on a public server.

**Working precedent: Obsidian LiveSync P2P.** https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/p2p.md
(checked 2026-10-08)
- It syncs over WebRTC.
- Signalling goes through "Nostr-compatible WebSocket relays".
- "The project author operates a public signalling relay as a best-effort convenience", with no
  availability guarantee.
- TURN is an optional fallback. "The project does not operate an official TURN service."

**Summary for this option:**
- Free: yes.
- Self-hostable: yes (signalling and TURN).
- Licence: MIT end to end with werift, Trystero and our own signalling.
- Capacitor: browser API in both webviews, with device verification still needed.
- What the user must do: nothing, *if* we (or a grey-zone public network) provide signalling and
  TURN.

### 2.5 libp2p (js-libp2p)

- **Licence:** `libp2p` 3.3.11, `@libp2p/webrtc` 6.0.33 and `@libp2p/circuit-relay-v2` 4.2.13 are
  all "Apache-2.0 OR MIT". The repo is active (pushed 2026-10-08).
  https://registry.npmjs.org/libp2p, https://registry.npmjs.org/@libp2p/webrtc, https://github.com/libp2p/js-libp2p
  (checked 2026-10-08).
- **How it connects:** https://github.com/libp2p/js-libp2p/blob/main/packages/transport-webrtc/README.md
  (checked 2026-10-08)
  - "The WebRTC transport uses libp2p Circuit Relays to forward SDP messages. Once a direct
    connection is formed the relay plays no further part."
  - "WebRTC requires use of a relay to connect two nodes", and the relay must listen "on a transport
    dialable by the listener and the dialer".
  - "Browsers cannot listen on WebRTC Direct addresses"; "Node.js/go and rust-libp2p can listen on
    and dial WebRTC Direct addresses."
  - A Noise handshake follows, giving encryption and authentication.
- **Node dependency:** `@libp2p/webrtc` depends on `node-datachannel` (MPL-2.0) and
  `react-native-webrtc`. https://registry.npmjs.org/@libp2p/webrtc/latest (checked 2026-10-08)
- **Free and self-hostable:** yes. The relay is a libp2p node with `circuitRelayServer()`, on a
  public machine.
- **Capacitor:** browser build in the webview; not verified inside Capacitor (**not found**).

### 2.6 Holepunch: Hyperswarm and Bare

- **Licences:** `hyperswarm` 4.17.2 (MIT, 2026-09-22) and `hyperdht` 6.34.1 (MIT, 2026-10-05).
  https://registry.npmjs.org/hyperswarm, https://registry.npmjs.org/hyperdht (checked 2026-10-08).
- **How it connects:** https://github.com/holepunchto/hyperdht (checked 2026-10-08)
  - "The Hyperswarm DHT uses a series of holepunching techniques"; "You can run servers on normal
    home computers, as the DHT will UDP holepunch connections for you."
  - The default bootstrap nodes "are publicly served on behalf of the commons". You can run an
    isolated DHT with your own bootstrap nodes.
  - A `relayThrough` connect option exists in `lib/connect.js` but is not in the README. `blind-relay`
    1.6.1 (Apache-2.0) is a TURN-like relay.
    https://github.com/holepunchto/hyperdht/blob/main/lib/connect.js,
    https://github.com/holepunchto/blind-relay (checked 2026-10-08).
- **Webview:** it needs UDP, so not directly.
  - `@hyperswarm/dht-relay` 0.4.3 (ISC) relays the DHT "over framed streams" for browsers. Last
    release 2023-10-30. https://registry.npmjs.org/@hyperswarm/dht-relay (checked 2026-10-08).
- **Bare inside a Capacitor app:**
  - `bare-kit` (Apache-2.0, v2.5.5, 2026-09-18) runs "isolated Bare threads, called worklets" from
    native iOS (Objective-C) and Android (Java), with IPC.
    https://github.com/holepunchto/bare-kit (checked 2026-10-08).
  - Ready-made bindings exist only for React Native and Expo (`react-native-bare-kit`,
    `expo-bare-kit`).
  - **No Capacitor plugin was found** (npm search, checked 2026-10-08). We would write one.

### 2.7 iroh (n0)

- **Licence and status:** MIT OR Apache-2.0; v1.3.0, 2026-09-28; active.
  https://github.com/n0-computer/iroh (checked 2026-10-08).
- **Bindings:** https://docs.iroh.computer/deployment/other-languages (checked 2026-10-08)
  - Official Swift (iOS and macOS), Kotlin (JVM and Android), Python, and "JavaScript … Node.js via
    N-API".
  - The npm package is `@number0/iroh` 1.1.0 (MIT OR Apache-2.0, 2026-07-16, built from
    `iroh-ffi`). https://registry.npmjs.org/@number0/iroh, https://github.com/n0-computer/iroh-ffi
    (checked 2026-10-08).
- **Browser / WASM:** https://docs.iroh.computer/deployment/wasm-browser-support (checked 2026-10-08)
  - "All connections from browsers to somewhere else need to flow via a relay server", because
    browsers "don't support sending UDP packets to IP addresses".
  - "Currently we don't bundle iroh's Wasm build as an NPM package."
- **Relays:** https://docs.iroh.computer/concepts/relays, https://docs.iroh.computer/add-a-relay
  (checked 2026-10-08)
  - "Iroh hardcodes a set of public relays provided by n0.computer, free to use"; they "Rate-limit
    traffic" and "Carry no uptime or performance guarantees". Public relays are "suitable for
    development and testing".
  - Self-hosted `iroh-relay` runs "on a server with a public IP and DNS name"; "Automatic TLS via ACME
    is built in".
- **Capacitor:** a native plugin we write (Swift and Kotlin bindings) gets hole punching. The webview
  WASM build is relay-only and has no npm package.

### 2.8 Syncthing (a folder transport, not a server connection)

- **Licence and status:** MPL-2.0; v2.1.6, 2026-10-06; active. https://github.com/syncthing/syncthing
  (checked 2026-10-08). It is a separate program.
- **Relays and discovery:**
  - Relaying is on by default, used only when there is no direct path, and stays end-to-end
    encrypted. You can set up private relays, which "excludes the public pool".
    https://docs.syncthing.net/users/relaying.html (checked 2026-10-08).
  - The public relays are "community-contributed". A private relay runs with `-pools=""`.
    https://docs.syncthing.net/users/strelaysrv.html (checked 2026-10-08).
  - The Syncthing project runs the global discovery cluster; "Anyone can run a discovery server".
    https://docs.syncthing.net/users/stdiscosrv.html (checked 2026-10-08).
- **Phones:** https://docs.syncthing.net/users/contrib.html (checked 2026-10-08)
  - The official Android app is "Archived on 2024-12-03".
  - **Syncthing-Fork** (researchxxl): MPL-2.0, v2.1.6.0, 2026-10-06.
    https://github.com/researchxxl/syncthing-android (checked 2026-10-08).
  - **BasicSync**: GPL-3.0. https://github.com/chenxiaolong/BasicSync (checked 2026-10-08).
  - **iOS: Synctrain**, "an open source, native app for iOS". Repo `pixelspark/sushitrain`, MPL-2.0,
    v2.7.83, 2026-08-17. https://github.com/pixelspark/sushitrain (checked 2026-10-08).
- **iOS background:** "Apple iOS restricts apps from running continuously in the background", so a
  sync may take long to start. Stated by Möbius Sync's FAQ, https://mobiussync.com/faq/ (checked
  2026-10-08).
- **Fit:**
  - It moves files, not API calls. The kit register already records "A live SQLite file in a sync
    folder is a corruption risk" (`../just-llm-runner/docs/dev/RESEARCH.md`, Sync).
  - It would carry export bundles only.
  - How our Capacitor app would read another app's synced folder on iOS: **not researched.**

### 2.9 UPnP / NAT-PMP port mapping from Node

- **Packages (ship inside our app):**
  - `@achingbrain/nat-port-mapper` 4.0.5: "Apache-2.0 OR MIT", 2025-10-14, 28,190 downloads a week,
    "Port mapping with UPnP and NAT-PMP".
  - `nat-api` 0.3.1: MIT, last release 2021-08-16.
  - `@runonflux/nat-upnp` 1.0.2: MIT, 2022-02-28.
  - Sources: https://registry.npmjs.org/@achingbrain/nat-port-mapper,
    https://github.com/achingbrain/nat-port-mapper, https://api.npmjs.org/downloads/point/last-week/@achingbrain/nat-port-mapper
    (checked 2026-10-08).
- **Limits:**
  - It needs a router with UPnP or NAT-PMP turned on. Plex: "The server will attempt to
    automatically configure a connection through your router using UPnP or NAT-PMP first", and it
    lists "Double-NAT" as a cause of failure.
    https://support.plex.tv/articles/200289506-remote-access/ (checked 2026-10-08).
  - CG-NAT blocks inbound access. https://www.home-assistant.io/docs/configuration/remote/ (checked
    2026-10-08).
  - Even when the mapping works, the phone reaches a bare public IP with no trusted certificate, so
    the §1.3 cleartext and ATS problem returns.
- **Free and self-hostable:** yes. No third party is involved.

### 2.10 Also seen (not asked)

- Self-hosted reverse tunnels to a server the user rents: `frp` (Apache-2.0, pushed 2026-10-08) and
  `rathole` (Apache-2.0, pushed 2026-08-23). https://github.com/fatedier/frp,
  https://github.com/rathole-org/rathole (checked 2026-10-08).
- They need a server the user rents, and in that case the user could run our server there directly.

---

## 3 · How self-hosted, local-first apps solve "my phone reaches my home server"

| App | What it tells users | Source (checked 2026-10-08) |
|---|---|---|
| **Actual Budget** | HTTPS is needed "to safely use all of Actual's features", except over `localhost`. Options: a reverse proxy for internet access; Tailscale or Caddy for a valid certificate without exposing the server; a self-signed certificate (browser warning); or a hosted provider. | https://actualbudget.org/docs/config/https |
| **Immich** | Three options, none made the default. VPN (WireGuard/OpenVPN): "Simple to set up and very secure", but needs an open port. Tailscale: "a good option" if you can't open a port; downside "it's a paid service" with a free tier. Reverse proxy: "Complex configuration". "Never forward port 2283 directly to the internet without additional configuration." | https://docs.immich.app/guides/remote-access |
| **Jellyfin** | Reverse proxy, VPN, or "a VPS to Reverse Proxy to your home network". Forwarding ports directly is "not recommended!". "Self-signed certificates … are strongly discouraged." | https://jellyfin.org/docs/general/post-install/networking/ |
| **Plex** | UPnP/NAT-PMP first, then manual port forwarding, then Plex's **Relay**. The Relay is "limited to 2 Mbps maximum for streams" and stays encrypted end to end when secure connections are on. LAN HTTPS via Let's Encrypt and `plex.direct` "DNS magic". | https://support.plex.tv/articles/200289506-remote-access/, https://support.plex.tv/articles/216766168-accessing-a-server-through-relay/, https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/ |
| **Home Assistant** | "The easiest and safest option for most people is Home Assistant Cloud" (Nabu Casa, paid). DIY: a VPN ("Tailscale or ZeroTier One"), a reverse proxy, or port forwarding with DuckDNS and Let's Encrypt. "Just putting a port up is not secure." CG-NAT can block inbound access. | https://www.home-assistant.io/docs/configuration/remote/ |
| **Nextcloud (AIO)** | Needs a domain plus 443/TCP; an IP address instead of a domain: "No and it will not be added". Free `*.dedyn.io` domain from deSEC. Cloudflare Tunnel "works like a reverse proxy", but Cloudflare terminates TLS. A Tailscale guide. A local-only instance still needs working HTTPS. | https://github.com/nextcloud/all-in-one |
| **Obsidian LiveSync** (MIT) | CouchDB ("3-minute setup - CouchDB on fly.io"; "Fly.io is no longer free"), S3-compatible object storage, or **P2P over WebRTC** with Nostr-relay signalling (the author's public relay as "a best-effort convenience") and optional TURN. Setup URI or QR to pair. | https://github.com/vrtmrz/obsidian-livesync, https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/p2p.md |
| **Syncthing** | Nothing to set up: global discovery (run by the project) plus community relays, both replaceable with your own. | https://docs.syncthing.net/users/relaying.html, https://docs.syncthing.net/users/stdiscosrv.html |

**The pattern:**
- The server apps (Actual, Immich, Jellyfin, Nextcloud, Home Assistant) push the user toward a
  reverse proxy with a domain, or toward a VPN, usually Tailscale.
- Only the apps that own their whole stack give zero-setup remote access: Plex and Home Assistant
  through their own paid or hosted relay, Syncthing and LiveSync through public open-source relays.
- LiveSync's P2P mode is the closest match to our shape, and it is MIT.

---

## 4 · Recommendation ladder (least to most setup for an author)

These are my readings for the user to decide; nothing is decided.

**Level 0 — same Wi-Fi, built in.**
- The desktop advertises over mDNS (`bonjour-service` or `ciao`, MIT) and shows a QR code with its
  address, a pairing token and a certificate fingerprint.
- The phone scans the code (`zxing-wasm` or `barcode-detector`, MIT, in the webview, or the official
  scanner if ML Kit is acceptable), or the user types the address.
- Plain HTTP needs an Android cleartext exception plus mixed content (androidScheme https), and iOS
  needs `NSAllowsLocalNetworking`. Android's `allowMixedContent` is "not intended for use in
  production".
- Cleaner alternatives: use the Level 1 channel (WebRTC) on the LAN as well, or CapacitorHttp native
  requests (which then need the iOS local-network prompt).
- Android apps targeting SDK 37 also need `ACCESS_LOCAL_NETWORK`.

**Level 1 — the manual path, built in.** Export and import a file (the "manual we talked about").
No network at all.

**Level 2 — over the internet, zero user setup, built in ("one we build").**
- A WebRTC data channel from the phone's webview to the desktop's Node server: werift (MIT) in Node,
  the browser API on the phone, Trystero (MIT) or our own few-route signalling, and coturn or eturnal
  as the TURN fallback.
- Same model as LiveSync P2P. Everything we ship is MIT.
- **The open decision:** who runs the public rendezvous and TURN.
  - (a) We do. We build and operate it, which has a running cost.
  - (b) Public Nostr relays plus no TURN. The grey zone, and pairs behind hard NATs then fail.
  - (c) The user's own server (Level 5).
- The alternative here is iroh: a native Capacitor plugin (Swift/Kotlin) plus `@number0/iroh` in Node,
  MIT/Apache. It gets hole punching natively, but needs relays (n0's public ones are "suitable for
  development and testing", or a self-hosted `iroh-relay` on a public IP with a DNS name), and it
  means writing a native plugin.

**Level 3 — router assist, built in, opportunistic.**
- Node asks the router for a port mapping (`@achingbrain/nat-port-mapper`, Apache-2.0 OR MIT) as an
  upgrade to a direct path.
- It fails under CG-NAT or double NAT, and a bare public IP has no trusted certificate, so it can't
  stand alone.

**Level 4 — documented "install X" (separate open-source programs):**
- **Syncthing** (Syncthing-Fork on Android, Synctrain on iOS, MPL-2.0) for moving export bundles
  through a folder. Never a live SQLite file.
- **Headscale plus the Tailscale clients:** a rented server with a public IP. The iOS Tailscale app is
  closed, so it fails the rule on iOS unless we embed TailscaleKit (BSD-3) through our own plugin.
- **NetBird self-hosted:** a VM with a domain. The clients are GPL-3.0 open-source apps; the server
  parts are AGPL-3.0.

**Level 5 — run the whole thing as a server (the user's third mode).**
- Our headless server on a rented machine with a domain and HTTPS. The desktop and phone sync to it,
  or the phone uses it directly with no local copy.
- Most setup, most reliable. The same machine can also host Level 2's rendezvous and TURN.

**The central finding:** under the open-source-only rule, every no-setup internet path needs a public
machine run by *somebody*. "Built in, zero setup" therefore means we build **and operate** a small
signalling-plus-TURN service, or accept third-party open-source public relays (the grey zone). The
user has to pick one.

---

## Summary table

Case: **in** = ships inside our app; **sep** = a separate program the user installs; **svc** = a
hosted service.

| Option | Case | User installs / signs up | Free | Self-hostable | Licence | Capacitor Android | Capacitor iOS | Maintenance | Under the rule |
|---|---|---|---|---|---|---|---|---|---|
| mDNS + QR (LAN) | in | nothing | yes | n/a | MIT (`bonjour-service`, `ciao`, `zxing-wasm`) | plugin (`capacitor-zeroconf`, npm-only MIT) | plugin + `NSBonjourServices` | Node libs active; plugins thin (10 / 8 stars) | **OK** |
| ngrok | svc | account and authtoken | free tier | no | SDK MIT/Apache, service closed | — | — | active | **excluded** |
| Cloudflare Tunnel / Quick | svc | a Cloudflare account (Quick: not checked) | not checked (excluded first) | no | cloudflared Apache-2.0, network is Cloudflare's | — | — | active | **excluded** |
| Tailscale hosted | svc | account | free tier (per Immich's docs) | no | coordination server closed | — | — | active | **excluded** |
| Headscale + Tailscale clients | sep | a server with a public IP, the clients | yes (pays for the server) | yes | BSD-3 | official app open, alternate server | official app **closed**; embedding TailscaleKit (BSD-3) needs our plugin | active | Android OK; iOS only by embedding |
| ZeroTier | sep / svc | app, account | not checked | controller non-commercial only | MPL-2.0 agent, source-available controller, BSL libzt | app; no source repo found | app; no source repo found | active | **excluded** |
| NetBird self-hosted | sep | VM with a domain, the clients | yes | yes | BSD-3 client, AGPL-3 server, GPL-3 apps | official app (GPL) | official app (GPL) | active (v0.80.0) | OK as separate programs |
| WebRTC + our signalling + coturn | in (+ public server) | nothing, if we run the rendezvous and TURN | yes | yes | MIT (werift, Trystero), BSD (coturn) | browser API | browser API (needs a device test) | active | **OK; the strongest built-in** |
| libp2p | in (+ public relay) | nothing, if we run a relay | yes | yes | Apache-2.0 OR MIT (Node pulls MPL `node-datachannel`) | browser build, untested | browser build, untested | active | OK (MPL to decide) |
| Hyperswarm / Bare | in (+ bootstrap) | nothing | yes | yes | MIT / Apache-2.0 | no Capacitor plugin (we write one on bare-kit) | same | active | OK, but a large native build |
| iroh | in (+ relay) | nothing | yes | yes (`iroh-relay`) | MIT OR Apache-2.0 | native plugin we write (Kotlin binding) | native plugin we write (Swift binding); WASM relay-only | active (v1.3.0) | OK, but a native plugin |
| Syncthing | sep | Syncthing on each device | yes | yes | MPL-2.0 (Fork MPL, Synctrain MPL) | Syncthing-Fork | Synctrain | active | OK as a folder transport only |
| UPnP / NAT-PMP | in | nothing (router must allow) | yes | n/a | Apache-2.0 OR MIT | n/a (phone only dials) | n/a | `nat-port-mapper` 2025-10 | OK, opportunistic only |
| Own server (VPS) mode | sep | rent a server and a domain | software free | yes | ours | HTTPS fetch | HTTPS fetch | — | OK |

---

## Not found / unverified (needs a device or a decision)

- Whether WKWebView treats `http://` fetches from a `capacitor://` page as mixed content: no
  authoritative source.
- WebRTC and libp2p inside a Capacitor webview: no device report found. MDN compat data only.
- Whether a numeric LAN IP or CIDR is accepted in an Android Network Security Config `<domain>`: not
  in the docs.
- Google ML Kit's licence (linked by the official barcode scanner): not checked.
- Trystero's default STUN servers: which ones they are was not checked.
- Hyperswarm's `relayThrough`: seen in the code, not documented.
- How mDNS behaves for the Node process on Windows: not checked.
- Reading another app's Syncthing folder from our Capacitor app on iOS: not researched.
- **Decision for the user:** is a free public instance of open-source relay software (Syncthing
  relays, n0 relays, Hyperswarm bootstrap, Nostr relays, Tailscale DERP) allowed, or must every relay
  be run by us or the user?
- **Decision for the user:** MPL-2.0 (`node-datachannel`, Syncthing) is not on the licence list.
