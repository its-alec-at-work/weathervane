# Weathervane

**Tracks everything. Sends nothing.**

Weathervane is a ~6 KB, dependency-free JavaScript tracking layer. It watches user behavior — pageviews, content exposure, clicks, forms, sessions, web vitals — and **emits everything as structured browser `CustomEvent`s**. It makes zero network requests and sets zero cookies.

You write the last mile. Forward events to GA4, PostHog, Mixpanel, your warehouse, a webhook — or all of them at once — with a few lines:

```js
window.addEventListener('vane:event', (e) => {
  console.log(e.detail.event_name, e.detail);
  // → forward anywhere you like
});
```

## Why Weathervane?

Most analytics scripts bundle three jobs: *what to track*, *how to structure it*, and *where to send it*. That bundling is the lock-in. Weathervane does the first two — the hard, repetitive part — and hands you the third.

- **One tracking layer, N destinations.** Instrument your site once with `data-vane-*` attributes. Forward to GA4 today, add PostHog tomorrow, swap in your warehouse next year — without touching your markup.
- **Inspect before anything ships.** Every event is visible in the browser before *you* decide it leaves. Scrub, sample, or drop events in your forwarder. Perfect chokepoint for consent logic.
- **No cookies, no requests, no vendor.** Weathervane itself has nothing to consent to, nothing to block, and nothing to migrate away from. IDs live in `localStorage`.
- **Tracking quality you'd otherwise build by hand.** Cumulative, pause-aware content exposure timing; form abandonment with engagement time; SPA navigation; shadow DOM support. This is the boilerplate everyone rewrites per project, done once.

### "Why not just use Google Tag Manager?"

GTM is a tag *loader* — it injects vendor scripts and routes dataLayer pushes, but it doesn't *generate* rich behavioral events. Out of the box GTM can't tell you that a hero section was visible for 2.3 cumulative seconds, that a checkout form was abandoned after 14 seconds of engagement, or that a CTA inside a web component was clicked. Weathervane is the tracking *engine* that produces those events; GTM (or anything else) can be the router. They compose: `window.addEventListener('vane:event', e => dataLayer.push({ event: 'vane', ...e.detail }))`.

## ✨ Key Features

- 🔌 **Zero backend, zero network** — events are emitted in the browser, never sent anywhere
- 🍪 **Zero cookies** — client & session IDs in `localStorage` (in-memory fallback); nothing for a cookie banner to announce
- 🎯 **Automatic content tracking** — serve / view / click lifecycle via `data-vane-*` attributes
- 👁️ **Sophisticated viewport detection** — IntersectionObserver-based, cumulative & tab-switch-aware exposure timing, percentage-fill handling for content taller than the viewport
- 🌒 **Shadow DOM support** — tracks content, clicks, and forms inside open shadow roots (web components)
- 🔗 **Link & form tracking** — automatic `link_click`, `form_submit`, and `form_abandon` events
- 📊 **Web vitals** — FCP, LCP, CLS, and FID included on every payload
- 📱 **SPA support** — automatic `pageview_dynamic` for pushState / replaceState / popstate / hashchange
- 🆔 **Enterprise-grade IDs** — ULID event IDs (time-sortable), UUID v4 client / session / page-view IDs
- 🛡️ **Lightweight & dependency-free** — one file, no build step, ~6 KB gzipped minified

## 🚀 Quick Start

### 1. Install

**Script tag (simplest):**

```html
<script src="/path/to/weathervane.min.js"></script>
```

That's it. Weathervane auto-initializes with sensible defaults and immediately starts emitting events (initial `pageview`, `session_start` on new sessions, link clicks, etc.).

**With configuration:**

```html
<script>
  // Define config before the script loads…
  window.vaneConfig = { debug: true, sessionTimeout: 30 };
</script>
<script src="/path/to/weathervane.min.js"></script>
```

**Manual initialization:**

```html
<script src="/path/to/weathervane.min.js" data-vane-auto="false"></script>
<script>
  window.vane.init({ debug: true });
</script>
```

**npm / bundler:**

```js
import 'weathervane'; // side-effect import; attaches window.vane and auto-inits
```

### 2. Listen for events

Every event is dispatched on `window` **twice**:

| Event type | Fires for | Use when |
|---|---|---|
| `vane:event` | every event | one listener forwards everything |
| `vane:<event_name>` | that event only (e.g. `vane:form_submit`) | you only care about specific events |

```js
// Catch everything
window.addEventListener('vane:event', (e) => myDestination.send(e.detail));

// Or just one event type
window.addEventListener('vane:content_view', (e) => {
  console.log('Viewed:', e.detail.properties.content_name);
});
```

Or use the built-in helper, which can also **replay** events that fired before your listener attached (e.g. the initial `pageview`):

```js
const unsubscribe = vane.on('*', (payload) => { /* ... */ }, { replay: true });
vane.on('link_click', (payload) => { /* ... */ });
unsubscribe(); // stop listening
```

### 3. (Optional) Annotate your markup

```html
<div data-vane-content="hero-banner"
     data-vane-type="marketing"
     data-vane-exposure="2000">
  <h1>Welcome!</h1>
  <button data-vane-content-click="cta-primary">Get Started</button>
</div>
```

## 🔀 Forwarding Recipes (the last mile)

All recipes use the catch-all listener; trim to specific `vane:<name>` events as needed.

**Google Analytics 4 (gtag):**

```js
window.addEventListener('vane:event', (e) => {
  const { event_name, properties, page } = e.detail;
  gtag('event', event_name, { ...properties, page_path: page.path });
});
```

**Google Tag Manager (dataLayer):**

```js
window.addEventListener('vane:event', (e) => {
  dataLayer.push({ event: 'vane.' + e.detail.event_name, vane: e.detail });
});
```

**PostHog:**

```js
window.addEventListener('vane:event', (e) => {
  const d = e.detail;
  posthog.capture(d.event_name, {
    ...d.properties,
    $current_url: d.page.url,
    vane_session_id: d.session_id,
  });
});
```

**Mixpanel:**

```js
window.addEventListener('vane:event', (e) => {
  const d = e.detail;
  mixpanel.track(d.event_name, { ...d.properties, page: d.page.path });
});
// keep identities in sync
window.addEventListener('vane:user_identify', (e) => mixpanel.identify(e.detail.user_id));
```

**Amplitude:**

```js
window.addEventListener('vane:event', (e) => {
  amplitude.track(e.detail.event_name, { ...e.detail.properties, page: e.detail.page.path });
});
```

**Segment (and Segment-compatible: RudderStack, Jitsu):**

```js
window.addEventListener('vane:event', (e) => {
  const d = e.detail;
  if (d.event_name === 'pageview' || d.event_name === 'pageview_dynamic') {
    analytics.page(d.page.title, { path: d.page.path, url: d.page.url });
  } else {
    analytics.track(d.event_name, d.properties);
  }
});
```

**Plausible (custom events — props must be flat scalars):**

```js
window.addEventListener('vane:event', (e) => {
  const d = e.detail;
  const props = {};
  for (const [k, v] of Object.entries(d.properties)) {
    if (v !== null && typeof v !== 'object') props[k] = v;
  }
  plausible(d.event_name, { props });
});
```

**Umami:**

```js
window.addEventListener('vane:event', (e) => {
  umami.track(e.detail.event_name, e.detail.properties);
});
```

**Your own API (batched, survives page close):**

```js
const queue = [];
window.addEventListener('vane:event', (e) => queue.push(e.detail));
function flush() {
  if (queue.length) navigator.sendBeacon('/api/events', JSON.stringify(queue.splice(0)));
}
setInterval(flush, 5000);
addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
```

**Slack webhook (e.g. ping yourself on conversions):**

```js
window.addEventListener('vane:form_submit', (e) => {
  if (e.detail.properties.form_goal !== 'conversion') return;
  fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    body: JSON.stringify({ text: `🎉 ${e.detail.properties.form_name} submitted` }),
  });
});
```

**Multiple destinations?** Just add multiple listeners — that's the whole point.

## 📦 Event Payload

Every event's `detail` has the same structure:

```jsonc
{
  "event_id": "01JXC4N9Z3T5W8...",        // ULID — time-sortable
  "event_name": "content_view",
  "timestamp": "2026-06-10T18:24:31.512Z",
  "client_id": "f47ac10b-...",             // persistent (localStorage)
  "session_id": "6ba7b810-...",            // rolling 30-min session
  "page_view_id": "9c2f1ab4-...",          // regenerated per page / SPA route
  "user_id": null,                          // set via vane.setUserId()

  "properties": {                           // event-specific data
    "content_name": "hero-banner",
    "content_type": "marketing",
    "segment": "homepage",
    "content_instance": "uuid...",
    "content_depth": 12,
    "exposure_limit": 2000,
    "exposure_time": 2014
  },

  "page":   { "url", "path", "title", "referrer", "search", "hash" },
  "device": { "browser_name", "browser_version", "device_type", "language",
              "timezone", "screen_width", "screen_height",
              "viewport_width", "viewport_height", "device_memory",
              "hardware_concurrency", "cookie_enabled", "online", "user_agent" },
  "utm":    { "utm_source", "utm_medium", "..." },  // null when absent
  "performance": { "first_contentful_paint", "largest_contentful_paint",
                   "cumulative_layout_shift", "first_input_delay" },
  "engagement":  { "scroll_depth": 45, "time_on_page": 12840 },
  "context": { },                           // your vane.setContext() data
  "sdk": { "name": "vane", "version": "1.1.0" }
}
```

## 📊 Event Types

**Page events**
- `pageview` — initial page view (fires on DOM ready); `properties` include `page_load_time`, `dom_content_loaded_time`, `navigation_type`, `connection_type`
- `pageview_dynamic` — SPA navigation; `properties.navigation_trigger` is `pushState` / `replaceState` / `popstate` / `hashchange`
- `session_start` — new session; `properties.reason` is `new` / `timeout` / `manual`

**Content events**
- `content_serve` — tracked content appeared in the DOM
- `content_view` — content was visible long enough (cumulative, pause-aware); includes `exposure_time`
- `content_click` — a `data-vane-content-click` element was clicked

**Interaction events**
- `link_click` — any `<a href>` click; includes `url`, `text`, `target`, `link_type` (web/email/phone), `is_external`
- `form_submit` — any form submission; includes form metadata and `completion_time`
- `form_abandon` — user engaged with a form for 3+ seconds and left without submitting (fires on `pagehide` or SPA navigation); includes `engagement_time`

**User events**
- `user_identify` — fired by `setUserId()`

**Custom events**
- anything you pass to `vane.track(name, properties)`

## 🏷️ Data Attributes Reference

### Content tracking

| Attribute | Required | Description |
|---|---|---|
| `data-vane-content="name"` | ✅ | Marks an element for serve/view/click tracking |
| `data-vane-type="type"` | — | Content category (`marketing`, `product`, `blog`, …) |
| `data-vane-segment="segment"` | — | Grouping for segmented analysis |
| `data-vane-exposure="ms"` | — | Visible time required for `content_view` (default 1000) |
| `data-vane-content-click="id"` | — | Tracks clicks on elements inside (or outside) content blocks |

```html
<section data-vane-content="product-showcase"
         data-vane-type="product"
         data-vane-segment="homepage"
         data-vane-exposure="1500">
  <h2>Featured Products</h2>
  <button data-vane-content-click="product-1-buy">Buy Now</button>
  <a href="/products" data-vane-content-click="view-all">View All</a>
</section>
```

**Lifecycle:** *serve* (in DOM) → *view* (visible for the exposure time, cumulative across scroll-aways and tab switches) → *click*.

**Viewport rules:** elements that fit in the viewport must be ~fully visible; elements **taller than the viewport** count as visible while they fill ≥65% of it (configurable via `largeContentViewportFill`). Dynamically injected content is discovered automatically via MutationObserver.

### Form tracking

All optional; they enrich `form_submit` / `form_abandon` events:

| Attribute | Example values |
|---|---|
| `data-vane-form-type` | `signup`, `contact`, `checkout`, `newsletter` |
| `data-vane-form-category` | `marketing`, `support`, `sales` |
| `data-vane-form-step` | `1`, `billing` |
| `data-vane-form-funnel` | `registration`, `checkout` |
| `data-vane-form-value` | `199.99`, `lead` |
| `data-vane-form-goal` | `lead-generation`, `conversion` |
| `data-vane-form-segment` | `free-users`, `enterprise` |

```html
<form data-vane-form-type="checkout"
      data-vane-form-funnel="purchase"
      data-vane-form-step="billing"
      data-vane-form-value="199.99"
      data-vane-form-goal="conversion">
  ...
</form>
```

Weathervane never reads or emits **field values** — only metadata (field count, types, required/optional counts).

## 🌒 Shadow DOM & Web Components

Weathervane tracks inside **open shadow roots** automatically (`trackShadowDom: true` by default):

- Existing shadow roots are discovered on the initial scan; roots created later are caught by instrumenting `Element.prototype.attachShadow`.
- **Declarative shadow DOM** works too, including post-load: subtrees with parser-created roots (`<template shadowrootmode="open">` via `setHTMLUnsafe`, `parseHTMLUnsafe`, or streamed HTML) are discovered when they enter the DOM.
- `data-vane-content` elements inside shadow roots get full serve/view/click tracking.
- Clicks are resolved via `event.composedPath()`, so `data-vane-content-click` works across shadow boundaries (a tracked button inside a component can attribute to a content container outside it).
- `submit` events don't cross shadow boundaries, so Weathervane attaches a submit listener inside each tracked root — forms in web components emit `form_submit` like any other.

**Closed** shadow roots are intentionally private and are not tracked. Set `trackShadowDom: false` to disable all of this (including the `attachShadow` instrumentation).

## ⚙️ Configuration

All options with their defaults:

```js
vane.init({
  // Emission
  eventPrefix: 'vane',          // events fire as `${prefix}:event` / `${prefix}:<name>`
  historySize: 100,                // events kept for on(..., { replay: true }) / getHistory()

  // Feature toggles
  enableAutoPageview: true,        // initial `pageview` on DOM ready
  enableDynamicPageview: true,     // SPA `pageview_dynamic` events
  enableContentTracking: true,     // data-vane-content lifecycle
  enableLinkTracking: true,        // automatic link_click
  enableFormTracking: true,        // form_submit / form_abandon
  enableWebVitals: true,           // FCP / LCP / CLS / FID collection
  trackShadowDom: true,            // open shadow root tracking

  // Session management
  sessionTimeout: 30,              // minutes of inactivity before a new session

  // Content tracking
  contentExposureLimit: 1000,      // default ms required for content_view
  largeContentViewportFill: 0.65,  // viewport-fill fraction for tall content

  // Form tracking
  formAbandonThreshold: 3000,      // min engagement ms before form_abandon

  // Development
  debug: false                     // console logging of every emitted event
});
```

## 🛠️ API Reference

| Method | Description |
|---|---|
| `vane.init(options?)` | Initialize (called automatically unless disabled) |
| `vane.track(name, properties?)` | Emit a custom event; returns the payload |
| `vane.trackPageView()` | Manually emit a `pageview` (new `page_view_id`, resets scroll depth & timers) |
| `vane.on(name, cb, { replay? })` | Subscribe (`'*'` for all); returns an unsubscribe function |
| `vane.setUserId(id)` / `getUserId()` | Set/get user ID; setting emits `user_identify` |
| `vane.setContext(key, value)` / `getContext()` / `clearContext()` | Global context attached to every payload |
| `vane.newSession()` | Force a new session (emits `session_start`) |
| `vane.getClientId()` / `getSessionId()` / `getPageViewId()` | Current identifiers |
| `vane.getHistory()` | Last N emitted payloads (see `historySize`) |
| `vane.getContentState()` | Serve/view/click state of all tracked content |
| `vane.isReady()` | Whether the SDK is initialized |
| `vane.destroy()` | Remove all listeners/observers/instrumentation and stop tracking |

`track()` calls made before `init()` are queued and emitted once initialized, so the classic async-loader stub pattern (`window.vane = { _queue: [...] }`) also works.

## 🆔 ID & Session Management (cookie-free)

Weathervane sets **no cookies**. All identifiers live in `localStorage`, with a graceful in-memory fallback when storage is unavailable (private mode restrictions, blocked storage):

- **Client ID** — UUID v4, persists across sessions. Stored under `vane_cid`.
- **Session ID** — UUID v4, rolling window (default 30 min), renewed on clicks/keys/scroll. Stored under `vane_sid`. A new session emits `session_start`.
- **Page View ID** — UUID v4, regenerated on every page load and SPA navigation.
- **Event ID** — ULID, lexicographically sortable by time for friendly time-series storage.

> **Safari note:** WebKit's ITP caps *all* script-writable storage (localStorage included) at 7 days without user interaction with your site. Expect client IDs to rotate more often on Safari than elsewhere — a limitation of every client-only analytics approach.

> **Privacy note:** no cookies means nothing for cookie-scanner tools to flag, but a persistent client ID is still pseudonymous personal data under GDPR. The clean part: *you* control whether IDs ever leave the browser, and your forwarder is a single chokepoint for consent gating.

## 📱 SPA Support

`pushState`, `replaceState`, `popstate`, and `hashchange` are detected automatically and emit `pageview_dynamic` with a `navigation_trigger`. Each navigation regenerates the `page_view_id`, resets scroll depth and time-on-page, re-parses UTM parameters, and flushes any pending `form_abandon`.

To handle routing yourself:

```js
vane.init({ enableDynamicPageview: false });
myRouter.on('change', () => vane.trackPageView());
```

## 🚀 Demo

Open [demo/index.html](demo/index.html) via any static server for a live, real-time event
console next to a full test matrix:

- **Part 1 — Light DOM:** content exposure (including the tall-content 65% rule), forms with
  submit/abandon, automatic link tracking, and post-load dynamic injection.
- **Part 2 — Shadow DOM:** a component whose root is created *before* Weathervane initializes,
  static declarative shadow DOM, nested roots two levels deep, cross-boundary click attribution,
  post-load injection via both `attachShadow()` and `setHTMLUnsafe()` — plus a **closed root**
  with identical attributes proving what's intentionally *not* tracked.
- **Part 3 — Page-level:** SPA navigation and the manual `track()` / identity API.

Each block lists the events it should emit, so you can verify behavior against expectations:

```bash
npm run demo        # serves the repo at http://localhost:4173 → open /demo/
```

## 🌐 Browser Support

Chrome 60+, Firefox 63+, Safari 12.1+, Edge 79+, iOS Safari 12.2+. Uses `IntersectionObserver`, `MutationObserver`, `PerformanceObserver` (web vitals degrade gracefully), `CustomEvent`, `composedPath`, and the History API. localStorage has a graceful in-memory fallback.

## 🐛 Debugging

```js
vane.init({ debug: true });
```

Logs every emitted event to the console. Common gotchas:

- **Listener attached too late?** The initial `pageview` fires on DOM ready — use `vane.on('*', cb, { replay: true })` or `vane.getHistory()` to catch up.
- **Content not viewing?** Check the element is actually visible and meets the exposure time; tall elements need to fill 65% of the viewport.
- **No `form_abandon`?** It requires 3+ seconds of engagement and fires on `pagehide`/SPA navigation, not on blur.
- **Web component not tracked?** Only *open* shadow roots are trackable; closed roots are invisible by design.

## License

MIT
