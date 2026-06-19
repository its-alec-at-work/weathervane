/*!
 * Weathervane v0.8.0
 * A lightweight, zero-backend analytics utility.
 *
 * Weathervane does NOT send data anywhere. It observes user behavior
 * (pageviews, content exposure, clicks, forms, sessions, web vitals)
 * and emits structured browser CustomEvents that you can forward to
 * any destination (GA4, PostHog, Segment, your own API, ...).
 *
 *   window.addEventListener('vane:event', function (e) {
 *     console.log(e.detail.event_name, e.detail);
 *   });
 *
 * License: MIT
 */
(function (window, document) {
  'use strict';

  if (!window || !document) return;
  if (window.vane && window.vane.__loaded) return;

  var VERSION = '0.8.0';
  var existing = window.vane; // may hold a _queue from an async loader snippet

  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------

  var DEFAULTS = {
    // Emission
    eventPrefix: 'vane',          // events fire as `${prefix}:event` and `${prefix}:${event_name}`
    historySize: 100,                // recent events kept for on(..., { replay: true })

    // Feature toggles
    enableAutoPageview: true,        // emit `pageview` on DOM ready
    enableDynamicPageview: true,     // emit `pageview_dynamic` on SPA navigation
    enableContentTracking: true,     // data-vane-content lifecycle tracking
    enableLinkTracking: true,        // emit `link_click` for every <a href> click
    enableFormTracking: true,        // emit `form_submit` / `form_abandon`
    enableWebVitals: true,           // collect FCP / LCP / CLS / FID
    enableErrorTracking: true,       // emit `error` for uncaught errors and promise rejections
    enableRageClickTracking: true,   // emit `rage_click` for rapid repeated clicks
    trackShadowDom: true,            // scan open shadow roots, retarget composed events

    // Session management
    sessionTimeout: 30,              // minutes of inactivity before a new session

    // Content tracking
    contentExposureLimit: 1000,      // default ms in viewport before `content_view`
    largeContentViewportFill: 0.65,  // taller-than-viewport content counts as visible
                                     // when it fills this fraction of the viewport

    // Form tracking
    formAbandonThreshold: 3000,      // min ms of engagement before `form_abandon` fires

    // Rage click detection
    rageClickThreshold: 3,           // number of clicks in rageClickWindow to trigger
    rageClickWindow: 1000,           // ms window for counting rapid clicks

    // Privacy
    privacy: {
      collectDevice: true,           // include device info in payloads
      collectTimezone: true,         // include timezone in device info
      persistClientId: true          // persist client ID in localStorage (false = session-only)
    },

    // Consent (for GDPR/CCPA; can also use setConsent() at runtime)
    consent: 'all',                  // 'all' | 'essential' | 'none'

    // Sampling
    sampleRate: 1,                   // fraction of sessions to sample (0-1); use isSampled() to check

    // Payload size
    payloadMode: 'full',             // 'full' | 'compact' | 'minimal'

    // Development
    debug: false
  };

  var config = assign({}, DEFAULTS);
  var ready = false;

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var key in src) {
        if (Object.prototype.hasOwnProperty.call(src, key)) target[key] = src[key];
      }
    }
    return target;
  }

  function now() { return Date.now(); }

  function randomBytes(length) {
    var bytes = new Uint8Array(length);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  }

  // RFC 4122 v4 UUID — used for client / session / page-view / instance ids
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      try { return window.crypto.randomUUID(); } catch (e) { /* insecure context */ }
    }
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var hex = '';
    for (var i = 0; i < 16; i++) hex += (b[i] + 0x100).toString(16).slice(1);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
      '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  // Sortable ID — lexicographically sortable event ids for time-series friendliness
  // (ULID-like: 10-char timestamp prefix + 16 random chars in Crockford base32)
  var SORTABLE_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function sortableId() {
    var ts = now();
    var out = '';
    for (var i = 0; i < 10; i++) {
      out = SORTABLE_CHARS[ts % 32] + out;
      ts = Math.floor(ts / 32);
    }
    var rand = randomBytes(16);
    for (var j = 0; j < 16; j++) out += SORTABLE_CHARS[rand[j] % 32];
    return out;
  }

  function truncate(str, max) {
    str = (str || '').replace(/\s+/g, ' ').trim();
    return str.length > max ? str.slice(0, max) : str;
  }

  function log() {
    if (!config.debug || !window.console) return;
    var args = ['%c vane ', 'background:#5b5bd6;color:#fff;border-radius:3px'];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  // Listener bookkeeping so destroy() can tear everything down
  var cleanups = [];
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(function () { target.removeEventListener(type, handler, options); });
  }

  function whenDomReady(fn) {
    if (document.readyState === 'loading') {
      listen(document, 'DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  // ---------------------------------------------------------------------
  // Storage (localStorage with in-memory fallback — no cookies, ever)
  // ---------------------------------------------------------------------

  var memoryStore = {};

  function storageGet(key) {
    try {
      var value = window.localStorage.getItem(key);
      if (value !== null) return value;
    } catch (e) { /* unavailable or blocked */ }
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  }

  function storageSet(key, value) {
    memoryStore[key] = value;
    try { window.localStorage.setItem(key, value); } catch (e) { /* memory fallback only */ }
  }

  function storageRemove(key) {
    delete memoryStore[key];
    try { window.localStorage.removeItem(key); } catch (e) { /* unavailable */ }
  }

  // ---------------------------------------------------------------------
  // Identity & session
  // ---------------------------------------------------------------------

  var CID_KEY = 'vane_cid';
  var SID_KEY = 'vane_sid';
  var SAMPLE_KEY = 'vane_sampled';

  var clientId = null;
  var session = { id: null, lastActive: 0, lastPersist: 0 };
  var userId = null;
  var pageViewId = null;
  var pageStartTime = now();
  var context = {};
  var sampled = true;  // whether this session should emit events
  var consentLevel = 'all'; // 'all' | 'essential' | 'none'

  // Consent levels control what DATA is collected (PII stripping), not which events fire:
  // 'all'       - full data collection (device info, persistent ID, full URLs, UTM)
  // 'essential' - events still fire, but stripped of PII-adjacent fields:
  //               no device info, session-only client ID, sanitized URLs (no search/hash), no UTM
  // 'none'      - no events fire at all

  function loadClientId() {
    // Consent 'essential' forces session-only client ID (no persistence)
    var shouldPersist = config.privacy.persistClientId && consentLevel !== 'essential';
    if (shouldPersist) {
      clientId = storageGet(CID_KEY);
      if (!clientId) clientId = uuid();
      storageSet(CID_KEY, clientId);
    } else {
      // Session-only client ID (not persisted)
      clientId = uuid();
    }
  }

  function checkSampling() {
    if (config.sampleRate >= 1) {
      sampled = true;
      return;
    }
    if (config.sampleRate <= 0) {
      sampled = false;
      return;
    }
    // Check if we already decided for this session
    var stored = storageGet(SAMPLE_KEY);
    if (stored === '1') { sampled = true; return; }
    if (stored === '0') { sampled = false; return; }
    // Decide based on sampleRate
    sampled = Math.random() < config.sampleRate;
    storageSet(SAMPLE_KEY, sampled ? '1' : '0');
  }

  function persistSession() {
    storageSet(SID_KEY, session.id + '.' + session.lastActive);
    session.lastPersist = now();
  }

  function loadSession() {
    var raw = storageGet(SID_KEY);
    var sid = null;
    var lastActive = 0;
    if (raw) {
      var parts = raw.split('.');
      sid = parts[0] || null;
      lastActive = parseInt(parts[1], 10) || 0;
    }
    var expired = !sid || (now() - lastActive) > config.sessionTimeout * 60000;
    if (expired) {
      startNewSession(sid ? 'timeout' : 'new', sid);
    } else {
      session.id = sid;
      session.lastActive = now();
      persistSession();
    }
  }

  function startNewSession(reason, previousId) {
    var prev = previousId !== undefined ? previousId : session.id;
    session.id = uuid();
    session.lastActive = now();
    persistSession();
    emit('session_start', { reason: reason, previous_session_id: prev || null });
  }

  function touchSession() {
    var t = now();
    if (t - session.lastActive > config.sessionTimeout * 60000) {
      startNewSession('timeout');
      return;
    }
    session.lastActive = t;
    if (t - session.lastPersist > 10000) persistSession();
  }

  // ---------------------------------------------------------------------
  // Context collection (page, device, UTM, performance)
  // ---------------------------------------------------------------------

  function pageContext() {
    var loc = window.location;
    return {
      url: loc.href,
      path: loc.pathname,
      title: document.title || null,
      referrer: document.referrer || null,
      search: loc.search || null,
      hash: loc.hash || null
    };
  }

  function parseBrowser(ua) {
    var match;
    if ((match = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) return { name: 'Edge', version: match[1] };
    if ((match = ua.match(/OPR\/([\d.]+)/))) return { name: 'Opera', version: match[1] };
    if ((match = ua.match(/SamsungBrowser\/([\d.]+)/))) return { name: 'Samsung Internet', version: match[1] };
    if ((match = ua.match(/(?:Firefox|FxiOS)\/([\d.]+)/))) return { name: 'Firefox', version: match[1] };
    if ((match = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/))) return { name: 'Chrome', version: match[1] };
    if (/Safari\//.test(ua) && (match = ua.match(/Version\/([\d.]+)/))) return { name: 'Safari', version: match[1] };
    return { name: 'unknown', version: null };
  }

  function detectDeviceType(ua) {
    if (/iPad|Tablet|PlayBook/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  var staticDevice = null;
  function deviceContext() {
    if (!config.privacy.collectDevice) {
      return null;
    }
    if (!staticDevice) {
      var ua = navigator.userAgent || '';
      var browser = parseBrowser(ua);
      var timezone = null;
      if (config.privacy.collectTimezone) {
        try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* no Intl */ }
      }
      staticDevice = {
        user_agent: ua,
        browser_name: browser.name,
        browser_version: browser.version,
        language: navigator.language || null,
        timezone: timezone,
        screen_width: window.screen ? window.screen.width : null,
        screen_height: window.screen ? window.screen.height : null,
        device_type: detectDeviceType(ua),
        device_memory: navigator.deviceMemory || null,
        hardware_concurrency: navigator.hardwareConcurrency || null,
        cookie_enabled: !!navigator.cookieEnabled
      };
    }
    return assign({}, staticDevice, {
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      online: navigator.onLine !== false
    });
  }

  var currentUtm = null;
  function parseUtm() {
    var out = {};
    var found = false;
    try {
      var params = new URLSearchParams(window.location.search);
      var keys = ['source', 'medium', 'campaign', 'term', 'content'];
      for (var i = 0; i < keys.length; i++) {
        var value = params.get('utm_' + keys[i]);
        if (value) { out['utm_' + keys[i]] = value; found = true; }
      }
    } catch (e) { /* URLSearchParams unavailable */ }
    return found ? out : null;
  }

  function navTiming() {
    try {
      if (typeof performance === 'undefined' || !performance.getEntriesByType) return {};
      var nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return {};
      return {
        page_load_time: nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : null,
        dom_content_loaded_time: nav.domContentLoadedEventEnd > 0 ? Math.round(nav.domContentLoadedEventEnd) : null,
        navigation_type: nav.type || null
      };
    } catch (e) { return {}; }
  }

  function connectionInfo() {
    var conn = navigator.connection;
    if (!conn) return {};
    return {
      connection_type: conn.effectiveType || null,
      connection_speed: typeof conn.downlink === 'number' ? conn.downlink : null
    };
  }

  // ---------------------------------------------------------------------
  // Web vitals (FCP, LCP, CLS, FID)
  // ---------------------------------------------------------------------

  var vitals = {
    first_contentful_paint: null,
    largest_contentful_paint: null,
    cumulative_layout_shift: null,
    first_input_delay: null
  };
  var vitalsObservers = [];
  var vitalsFlushed = false;

  function observeVitals() {
    if (!config.enableWebVitals || typeof PerformanceObserver === 'undefined') return;

    function observe(type, handler) {
      try {
        var observer = new PerformanceObserver(function (list) {
          handler(list.getEntries());
        });
        observer.observe({ type: type, buffered: true });
        vitalsObservers.push(observer);
      } catch (e) { /* entry type unsupported */ }
    }

    observe('paint', function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === 'first-contentful-paint') {
          vitals.first_contentful_paint = Math.round(entries[i].startTime);
        }
      }
    });
    observe('largest-contentful-paint', function (entries) {
      var last = entries[entries.length - 1];
      if (last) vitals.largest_contentful_paint = Math.round(last.startTime);
    });
    observe('layout-shift', function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].hadRecentInput) {
          vitals.cumulative_layout_shift =
            Math.round(((vitals.cumulative_layout_shift || 0) + entries[i].value) * 10000) / 10000;
        }
      }
    });
    observe('first-input', function (entries) {
      var first = entries[0];
      if (first && vitals.first_input_delay === null) {
        vitals.first_input_delay = Math.round(first.processingStart - first.startTime);
      }
    });
  }

  function flushVitals() {
    if (!config.enableWebVitals || vitalsFlushed) return;
    // Check if we have any vitals to report
    var hasVitals = vitals.first_contentful_paint !== null ||
                    vitals.largest_contentful_paint !== null ||
                    vitals.cumulative_layout_shift !== null ||
                    vitals.first_input_delay !== null;
    if (!hasVitals) return;
    vitalsFlushed = true;
    emit('web_vitals', assign({}, vitals));
  }

  // ---------------------------------------------------------------------
  // Error tracking
  // ---------------------------------------------------------------------

  function setupErrorTracking() {
    if (!config.enableErrorTracking) return;

    // Global error handler
    listen(window, 'error', function (e) {
      emit('error', {
        error_type: 'uncaught',
        message: e.message || 'Unknown error',
        filename: e.filename || null,
        lineno: e.lineno || null,
        colno: e.colno || null,
        stack: e.error && e.error.stack ? truncate(e.error.stack, 1000) : null
      });
    });

    // Unhandled promise rejection handler
    listen(window, 'unhandledrejection', function (e) {
      var reason = e.reason;
      var message = 'Unhandled promise rejection';
      var stack = null;
      if (reason) {
        if (typeof reason === 'string') {
          message = reason;
        } else if (reason.message) {
          message = reason.message;
          stack = reason.stack ? truncate(reason.stack, 1000) : null;
        }
      }
      emit('error', {
        error_type: 'unhandled_rejection',
        message: message,
        stack: stack
      });
    });
  }

  // ---------------------------------------------------------------------
  // Scroll depth
  // ---------------------------------------------------------------------

  var scrollDepth = 0;
  var scrollTickPending = false;

  function updateScrollDepth() {
    scrollTickPending = false;
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    var pct = scrollable > 0
      ? Math.min(100, Math.round((window.scrollY / scrollable) * 100))
      : 100;
    if (pct > scrollDepth) scrollDepth = pct;
    // Also update per-content scroll depths
    if (config.enableContentTracking) updateContentScrollDepths();
  }

  function observeScroll() {
    listen(window, 'scroll', function () {
      if (scrollTickPending) return;
      scrollTickPending = true;
      window.requestAnimationFrame(updateScrollDepth);
    }, { passive: true });
  }

  // ---------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------

  var eventHistory = [];
  var pendingEvents = []; // track() calls made before init()

  function buildPayload(eventName, properties) {
    var mode = config.payloadMode;
    var isEssential = consentLevel === 'essential';

    // When consent is 'essential', strip PII-adjacent fields:
    // - No device info
    // - No UTM params
    // - Sanitized page (path + title only, no search/hash/referrer/full URL)
    // - No user_id
    var essentialPage = isEssential ? {
      path: window.location.pathname,
      title: document.title || null
    } : null;

    // Minimal: just essentials for high-volume scenarios
    if (mode === 'minimal') {
      return {
        event_id: sortableId(),
        event_name: eventName,
        timestamp: new Date().toISOString(),
        client_id: clientId,
        session_id: session.id,
        page_view_id: pageViewId,
        properties: properties || {},
        page: { path: window.location.pathname }
      };
    }

    // Compact: trimmed versions of each section
    if (mode === 'compact') {
      var device = isEssential ? null : deviceContext();
      return {
        event_id: sortableId(),
        event_name: eventName,
        timestamp: new Date().toISOString(),
        client_id: clientId,
        session_id: session.id,
        page_view_id: pageViewId,
        user_id: isEssential ? null : userId,
        properties: properties || {},
        page: essentialPage || {
          url: window.location.href,
          path: window.location.pathname,
          title: document.title || null
        },
        device: device ? {
          browser_name: device.browser_name,
          device_type: device.device_type,
          viewport_width: device.viewport_width,
          viewport_height: device.viewport_height
        } : null,
        utm: isEssential ? null : currentUtm,
        engagement: {
          scroll_depth: scrollDepth,
          time_on_page: now() - pageStartTime
        },
        context: assign({}, context),
        sdk: { version: VERSION }
      };
    }

    // Full: everything (default)
    return {
      event_id: sortableId(),
      event_name: eventName,
      timestamp: new Date().toISOString(),
      client_id: clientId,
      session_id: session.id,
      page_view_id: pageViewId,
      user_id: isEssential ? null : userId,
      properties: properties || {},
      page: essentialPage || pageContext(),
      device: isEssential ? null : deviceContext(),
      utm: isEssential ? null : currentUtm,
      engagement: {
        scroll_depth: scrollDepth,
        time_on_page: now() - pageStartTime
      },
      context: assign({}, context),
      sdk: { name: 'weathervane', version: VERSION }
    };
  }

  function dispatch(type, payload) {
    var event;
    try {
      event = new CustomEvent(type, { detail: payload });
    } catch (e) {
      event = document.createEvent('CustomEvent');
      event.initCustomEvent(type, false, false, payload);
    }
    try {
      window.dispatchEvent(event);
    } catch (e) {
      // A throwing listener should not break internal tracking
      if (config.debug) console.error('vane: listener threw', e);
    }
  }

  function emit(eventName, properties, eventContext) {
    // Consent 'none' blocks all events
    if (consentLevel === 'none') {
      return null;
    }
    if (!ready) {
      pendingEvents.push([eventName, properties, eventContext]);
      return null;
    }
    var payload = buildPayload(eventName, properties);
    // Merge event-specific context (e.g., from data-vane-context-* attributes)
    if (eventContext) {
      payload.context = assign(payload.context || {}, eventContext);
    }
    eventHistory.push(payload);
    if (eventHistory.length > config.historySize) {
      eventHistory.splice(0, eventHistory.length - config.historySize);
    }
    dispatch(config.eventPrefix + ':event', payload);
    dispatch(config.eventPrefix + ':' + eventName, payload);
    log(eventName, payload);
    return payload;
  }

  // ---------------------------------------------------------------------
  // Pageviews & SPA navigation
  // ---------------------------------------------------------------------

  var lastUrl = window.location.href;
  var historyPatched = false;

  function startPageView(eventName, extraProps) {
    pageViewId = uuid();
    pageStartTime = now();
    scrollDepth = 0;
    currentUtm = parseUtm();
    emit(eventName, assign({}, extraProps));
  }

  function onNavigate(trigger) {
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    touchSession();
    flushFormAbandons();
    // Flush vitals for previous page before starting new page view
    flushVitals();
    if (!config.enableDynamicPageview) return;
    // Reset vitals and flag for the new page
    vitals = {
      first_contentful_paint: null,
      largest_contentful_paint: null,
      cumulative_layout_shift: null,
      first_input_delay: null
    };
    vitalsFlushed = false;
    var props = { navigation_trigger: trigger };
    if (trigger === 'hashchange') props.new_hash = window.location.hash || null;
    startPageView('pageview_dynamic', props);
  }

  function patchHistory() {
    if (historyPatched || !window.history || !window.history.pushState) return;
    historyPatched = true;
    ['pushState', 'replaceState'].forEach(function (method) {
      var original = window.history[method];
      window.history[method] = function () {
        var result = original.apply(this, arguments);
        onNavigate(method);
        return result;
      };
      cleanups.push(function () { window.history[method] = original; });
    });
    listen(window, 'popstate', function () { onNavigate('popstate'); });
    listen(window, 'hashchange', function () { onNavigate('hashchange'); });
  }

  // ---------------------------------------------------------------------
  // Content tracking (data-vane-content)
  // ---------------------------------------------------------------------

  var contentStates = new Map();
  var visibleContent = new Set(); // Tracks currently visible content for efficient scroll updates
  var intersectionObserver = null;
  var mutationObserver = null;

  function contentDepth(el) {
    var total = document.documentElement.scrollHeight;
    if (!total) return 0;
    var top = el.getBoundingClientRect().top + window.scrollY;
    return Math.max(0, Math.min(100, Math.round((top / total) * 100)));
  }

  // Parse data-vane-context-* attributes into a context object
  // e.g. data-vane-context-author="john" becomes { author: "john" }
  function parseContentContext(el) {
    var ctx = null;
    var attrs = el.attributes;
    var prefix = 'data-vane-context-';
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      if (attr.name.indexOf(prefix) === 0) {
        var key = attr.name.slice(prefix.length);
        if (key) {
          if (!ctx) ctx = {};
          ctx[key] = attr.value;
        }
      }
    }
    return ctx;
  }

  function contentProps(el, state) {
    return {
      content_name: state.name,
      content_type: state.type,
      segment: state.segment,
      content_instance: state.instanceId,
      content_depth: contentDepth(el),
      exposure_limit: state.exposureLimit,
      content_scroll_depth: state.scrollDepth
    };
  }

  // Calculate how far user has scrolled through a content element (0-100)
  function calcContentScrollDepth(el) {
    var rect = el.getBoundingClientRect();
    var viewportHeight = window.innerHeight;
    // Content hasn't reached top of viewport yet
    if (rect.top >= viewportHeight) return 0;
    // Content has scrolled completely past
    if (rect.bottom <= 0) return 100;
    // Calculate progress: how much of content is above viewport top
    var scrolledPast = Math.max(0, -rect.top);
    var contentHeight = rect.height;
    if (contentHeight <= 0) return 0;
    return Math.min(100, Math.round((scrolledPast / contentHeight) * 100));
  }

  function updateContentScrollDepths() {
    // Only update scroll depths for currently visible content (O(visible) vs O(all))
    visibleContent.forEach(function (el) {
      var state = contentStates.get(el);
      if (!state) return;
      var depth = calcContentScrollDepth(el);
      if (depth > state.scrollDepth) state.scrollDepth = depth;
    });
  }

  // The composed event path lets delegated handlers see through open shadow
  // roots, where e.target is retargeted to the host element.
  function eventPath(e) {
    if (e.composedPath) {
      try { return e.composedPath(); } catch (err) { /* fall through */ }
    }
    var path = [];
    var node = e.target;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    return path;
  }

  function findInPath(path, fromIndex, predicate) {
    for (var i = fromIndex; i < path.length; i++) {
      var node = path[i];
      if (node && node.nodeType === 1 && predicate(node)) return { el: node, index: i };
    }
    return null;
  }

  function registerContent(el) {
    if (!config.enableContentTracking || contentStates.has(el)) return;
    var name = el.getAttribute('data-vane-content');
    if (!name) return;
    var state = {
      name: name,
      type: el.getAttribute('data-vane-content-type') || null,
      segment: el.getAttribute('data-vane-content-segment') || null,
      exposureLimit: parseInt(el.getAttribute('data-vane-content-exposure'), 10) || config.contentExposureLimit,
      instanceId: uuid(),
      served: true,
      viewed: false,
      clicked: false,
      accumulated: 0,
      visibleSince: null,
      resumeOnShow: false,
      timer: null,
      scrollDepth: 0 // max scroll depth within this content (0-100)
    };
    contentStates.set(el, state);
    emit('content_serve', contentProps(el, state), parseContentContext(el));
    if (intersectionObserver) intersectionObserver.observe(el);
  }

  // scanContent: scans a subtree for content elements and shadow roots.
  // skipShadowScan=true can be used when shadow roots are known to be
  // caught by other mechanisms (rarely needed).
  function scanContent(root, skipShadowScan) {
    if (!root) root = document;
    if (root.nodeType === 1) {
      if (config.enableContentTracking && root.hasAttribute('data-vane-content')) {
        registerContent(root);
      }
      if (config.trackShadowDom && root.shadowRoot) attachRoot(root.shadowRoot);
    }
    if (!root.querySelectorAll) return;
    if (config.enableContentTracking) {
      var els = root.querySelectorAll('[data-vane-content]');
      for (var i = 0; i < els.length; i++) registerContent(els[i]);
    }
    // Full shadow root scan only on initial load; mutations are caught by
    // attachShadow patch and declarative template removal watcher
    if (config.trackShadowDom && !skipShadowScan) {
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) attachRoot(all[j].shadowRoot);
      }
    }
  }

  // Each open shadow root needs its own MutationObserver target and its own
  // `submit` listener (submit events are composed: false and never cross the
  // shadow boundary). Clicks and focusin are composed and stay delegated.
  var observedRoots = [];

  function attachRoot(root) {
    if (observedRoots.indexOf(root) !== -1) return;
    observedRoots.push(root);
    if (mutationObserver) {
      var target = root === document ? (document.body || document.documentElement) : root;
      mutationObserver.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-vane-content']
      });
    }
    if (root !== document && config.enableFormTracking) {
      listen(root, 'submit', onSubmit, true);
    }
    scanContent(root);
  }

  function patchAttachShadow() {
    if (!window.Element || !Element.prototype.attachShadow) return;
    var original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      var root = original.call(this, init);
      // Closed roots stay private: their events are retargeted beyond
      // recovery anyway, so only open roots are tracked.
      if (init && init.mode === 'open') attachRoot(root);
      return root;
    };
    cleanups.push(function () { Element.prototype.attachShadow = original; });
  }

  function isContentVisible(entry, viewportHeight) {
    if (!entry.isIntersecting) return false;
    var rect = entry.boundingClientRect;
    // Standard elements must be (essentially) fully visible. Elements taller
    // than or equal to the viewport count as visible once they fill enough of it.
    if (rect.height < viewportHeight) return entry.intersectionRatio >= 0.98;
    return entry.intersectionRect.height >= viewportHeight * config.largeContentViewportFill;
  }

  function scheduleViewTimer(el, state) {
    var remaining = Math.max(0, state.exposureLimit - state.accumulated);
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      if (state.viewed || state.visibleSince === null) return;
      state.viewed = true;
      visibleContent.delete(el); // No longer need scroll tracking
      var exposure = state.accumulated + (now() - state.visibleSince);
      emit('content_view', assign(contentProps(el, state), {
        exposure_time: Math.round(exposure)
      }), parseContentContext(el));
      if (intersectionObserver) intersectionObserver.unobserve(el);
    }, remaining);
  }

  function pauseContent(state) {
    if (state.visibleSince !== null) {
      state.accumulated += now() - state.visibleSince;
      state.visibleSince = null;
    }
    clearTimeout(state.timer);
  }

  function onIntersect(entries) {
    var viewportHeight = window.innerHeight;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var el = entry.target;
      var state = contentStates.get(el);
      if (!state || state.viewed) continue;
      var visible = isContentVisible(entry, viewportHeight);
      if (visible && state.visibleSince === null) {
        state.visibleSince = now();
        visibleContent.add(el);
        scheduleViewTimer(el, state);
      } else if (!visible && state.visibleSince !== null) {
        visibleContent.delete(el);
        pauseContent(state);
      }
    }
  }

  function setupDomTracking() {
    if (!config.enableContentTracking && !config.trackShadowDom) return;

    if (config.enableContentTracking && typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver(onIntersect, {
        threshold: [0, 0.25, 0.5, 0.65, 0.75, 0.9, 0.98, 1]
      });
      cleanups.push(function () { intersectionObserver.disconnect(); intersectionObserver = null; });
    }

    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mutation = mutations[i];
          if (mutation.type === 'attributes') {
            registerContent(mutation.target);
            continue;
          }
          for (var j = 0; j < mutation.addedNodes.length; j++) {
            var node = mutation.addedNodes[j];
            // Full shadow scan needed: setHTMLUnsafe with declarative shadow DOM
            // creates roots instantly without attachShadow or template removal
            if (node.nodeType === 1) scanContent(node, false);
          }
          // Clean up removed content to prevent memory leaks in SPAs
          for (var k = 0; k < mutation.removedNodes.length; k++) {
            var removed = mutation.removedNodes[k];
            if (removed.nodeType !== 1) continue;
            // Clean up tracked content state
            if (contentStates.has(removed)) {
              var state = contentStates.get(removed);
              clearTimeout(state.timer);
              if (intersectionObserver) intersectionObserver.unobserve(removed);
              contentStates.delete(removed);
              visibleContent.delete(removed);
            }
            // Also clean up any tracked descendants
            if (removed.querySelectorAll) {
              var descendants = removed.querySelectorAll('[data-vane-content]');
              for (var d = 0; d < descendants.length; d++) {
                if (contentStates.has(descendants[d])) {
                  var dState = contentStates.get(descendants[d]);
                  clearTimeout(dState.timer);
                  if (intersectionObserver) intersectionObserver.unobserve(descendants[d]);
                  contentStates.delete(descendants[d]);
                  visibleContent.delete(descendants[d]);
                }
              }
            }
            // Declarative shadow DOM: when the parser finishes a <template shadowrootmode>,
            // it attaches the root and removes the template
            if (config.trackShadowDom && removed.tagName === 'TEMPLATE' &&
                (removed.hasAttribute('shadowrootmode') || removed.hasAttribute('shadowroot')) &&
                mutation.target && mutation.target.nodeType === 1 && mutation.target.shadowRoot) {
              attachRoot(mutation.target.shadowRoot);
            }
          }
        }
      });
      cleanups.push(function () { mutationObserver.disconnect(); mutationObserver = null; });
    }

    if (config.trackShadowDom) patchAttachShadow();
    attachRoot(document);

    // Tab switches don't change intersection state, so pause/resume manually
    listen(document, 'visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        contentStates.forEach(function (state) {
          if (state.visibleSince !== null) {
            pauseContent(state);
            state.resumeOnShow = true;
          }
        });
      } else {
        contentStates.forEach(function (state, el) {
          if (state.resumeOnShow && !state.viewed) {
            state.resumeOnShow = false;
            state.visibleSince = now();
            scheduleViewTimer(el, state);
          }
        });
      }
    });
  }

  // ---------------------------------------------------------------------
  // Click tracking (content clicks + links + rage clicks)
  // ---------------------------------------------------------------------

  // Rage click detection state
  var rageClickState = {
    element: null,
    clicks: [],
    emitted: false
  };

  function checkRageClick(e, target) {
    if (!config.enableRageClickTracking) return;

    var t = now();
    var isSameElement = rageClickState.element === target;

    if (!isSameElement) {
      // New element, reset state
      rageClickState.element = target;
      rageClickState.clicks = [t];
      rageClickState.emitted = false;
      return;
    }

    // Same element, add click and filter old clicks
    rageClickState.clicks.push(t);
    rageClickState.clicks = rageClickState.clicks.filter(function (ts) {
      return t - ts < config.rageClickWindow;
    });

    // Check if threshold met
    if (!rageClickState.emitted && rageClickState.clicks.length >= config.rageClickThreshold) {
      rageClickState.emitted = true;
      var tag = target.tagName ? target.tagName.toLowerCase() : 'unknown';
      emit('rage_click', {
        element_tag: tag,
        element_id: target.id || null,
        element_class: target.className || null,
        element_text: truncate(target.innerText || target.textContent, 100) || null,
        click_count: rageClickState.clicks.length,
        window_ms: config.rageClickWindow
      });
    }
  }

  function linkType(href) {
    if (/^mailto:/i.test(href)) return 'email';
    if (/^tel:/i.test(href)) return 'phone';
    return 'web';
  }

  function onClick(e) {
    var path = eventPath(e);
    if (!path.length) return;
    touchSession();

    // Rage click detection
    var target = path[0];
    checkRageClick(e, target);

    if (config.enableContentTracking) {
      var clickHit = findInPath(path, 0, function (el) {
        return el.hasAttribute('data-vane-content-click');
      });
      if (clickHit) {
        var clickEl = clickHit.el;
        var containerHit = findInPath(path, clickHit.index, function (el) {
          return el.hasAttribute('data-vane-content');
        });
        var container = containerHit ? containerHit.el : null;
        var state = container ? contentStates.get(container) : null;
        if (state) state.clicked = true;
        var props = {
          click_id: clickEl.getAttribute('data-vane-content-click'),
          element_tag: clickEl.tagName.toLowerCase(),
          element_text: truncate(clickEl.innerText || clickEl.textContent, 100) || null
        };
        if (container && state) assign(props, contentProps(container, state));
        emit('content_click', props, container ? parseContentContext(container) : null);
      }
    }

    if (config.enableLinkTracking) {
      var anchorHit = findInPath(path, 0, function (el) {
        return el.tagName === 'A' && el.getAttribute('href');
      });
      if (anchorHit) {
        var anchor = anchorHit.el;
        var rawHref = anchor.getAttribute('href') || '';
        emit('link_click', {
          url: anchor.href,
          text: truncate(anchor.innerText || anchor.getAttribute('aria-label'), 100) || null,
          target: anchor.getAttribute('target') || null,
          href: truncate(rawHref.split(/[?#]/)[0], 200),
          link_type: linkType(rawHref),
          is_external: !!anchor.host && anchor.host !== window.location.host
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Form tracking (submit + abandonment)
  // ---------------------------------------------------------------------

  var formEngagement = new Map();

  function formProps(form) {
    var fields = form.querySelectorAll('input, select, textarea');
    var typeSet = new Set();
    var required = 0;
    for (var i = 0; i < fields.length; i++) {
      typeSet.add(fields[i].type || fields[i].tagName.toLowerCase());
      if (fields[i].required) required++;
    }
    var fieldTypes = Array.from(typeSet);
    return {
      form_name: form.getAttribute('data-vane-form') || form.getAttribute('name') || form.id || 'unnamed',
      form_action: form.getAttribute('action') || window.location.pathname,
      form_method: (form.getAttribute('method') || 'GET').toUpperCase(),
      field_count: fields.length,
      field_types: fieldTypes,
      required_fields: required,
      optional_fields: fields.length - required,
      form_type: form.getAttribute('data-vane-form-type') || null,
      form_category: form.getAttribute('data-vane-form-category') || null,
      form_step: form.getAttribute('data-vane-form-step') || null,
      form_funnel: form.getAttribute('data-vane-form-funnel') || null,
      form_value: form.getAttribute('data-vane-form-value') || null,
      form_goal: form.getAttribute('data-vane-form-goal') || null,
      form_segment: form.getAttribute('data-vane-form-segment') || null
    };
  }

  function onFocusIn(e) {
    var field = e.target;
    if (!field || field.nodeType !== 1 || !field.form) return;
    var form = field.form;
    var engagement = formEngagement.get(form);
    if (engagement) {
      // Clear any pending abandon timer when focus returns
      if (engagement.abandonTimer) {
        clearTimeout(engagement.abandonTimer);
        engagement.abandonTimer = null;
      }
    } else {
      formEngagement.set(form, { start: now(), abandonTimer: null });
      emit('form_engage', formProps(form));
    }
  }

  function onFocusOut(e) {
    var field = e.target;
    if (!field || field.nodeType !== 1 || !field.form) return;
    var form = field.form;
    var engagement = formEngagement.get(form);
    if (!engagement) return;
    // Use setTimeout to check if focus moved to another field in same form
    setTimeout(function () {
      // If focus is still inside the form, don't start abandon timer
      var active = document.activeElement;
      if (active && active.form === form) return;
      // Start abandon timer
      if (!engagement.abandonTimer) {
        engagement.abandonTimer = setTimeout(function () {
          // Re-check engagement still exists (might have been submitted or refocused)
          if (!formEngagement.has(form)) return;
          var engagementTime = now() - engagement.start;
          if (engagementTime >= config.formAbandonThreshold) {
            emit('form_abandon', assign(formProps(form), { engagement_time: engagementTime }));
          }
          formEngagement.delete(form);
        }, config.formAbandonThreshold);
      }
    }, 50);
  }

  function onSubmit(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var props = formProps(form);
    var engagement = formEngagement.get(form);
    if (engagement) {
      if (engagement.abandonTimer) clearTimeout(engagement.abandonTimer);
      props.completion_time = now() - engagement.start;
      formEngagement.delete(form);
    }
    emit('form_submit', props);
  }

  function flushFormAbandons() {
    if (!config.enableFormTracking) return;
    formEngagement.forEach(function (engagement, form) {
      if (engagement.abandonTimer) clearTimeout(engagement.abandonTimer);
      var engagementTime = now() - engagement.start;
      if (engagementTime >= config.formAbandonThreshold) {
        emit('form_abandon', assign(formProps(form), { engagement_time: engagementTime }));
      }
    });
    formEngagement.clear();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  function init(options) {
    if (ready) {
      log('init() called twice — ignoring');
      return api;
    }
    options = options || {};
    // Deep merge privacy object
    if (options.privacy) {
      options.privacy = assign({}, DEFAULTS.privacy, options.privacy);
    }
    assign(config, options);
    ready = true;

    checkSampling();
    if (!sampled) {
      log('session not sampled (sampleRate:', config.sampleRate + ') — events still emit, use isSampled() to filter');
    }

    // Initialize consent level from config
    consentLevel = config.consent || 'all';

    loadClientId();
    currentUtm = parseUtm();
    observeVitals();
    observeScroll();
    setupErrorTracking();
    loadSession(); // may emit session_start

    if (config.enableDynamicPageview) patchHistory();
    listen(document, 'click', onClick, true);
    if (config.enableFormTracking) {
      listen(document, 'focusin', onFocusIn, true);
      listen(document, 'focusout', onFocusOut, true);
      listen(document, 'submit', onSubmit, true);
      listen(window, 'pagehide', flushFormAbandons);
      listen(document, 'visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushFormAbandons();
      });
    }
    listen(document, 'keydown', touchSession, { passive: true });
    listen(window, 'scroll', touchSession, { passive: true });
    listen(window, 'pagehide', persistSession);

    // Emit web vitals after page stabilizes (load + 1s delay for LCP to finalize)
    // Also flush on page end as fallback for late CLS values
    if (config.enableWebVitals) {
      var emitInitialVitals = function () {
        setTimeout(flushVitals, 1000);
      };
      if (document.readyState === 'complete') {
        emitInitialVitals();
      } else {
        listen(window, 'load', emitInitialVitals);
      }
    }
    listen(window, 'pagehide', flushVitals);
    listen(document, 'visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushVitals();
    });

    whenDomReady(function () {
      if (config.enableAutoPageview) {
        startPageView('pageview', assign({ navigation_trigger: 'initial' }, navTiming(), connectionInfo()));
      } else {
        pageViewId = uuid();
      }
      setupDomTracking();
    });

    // Replay anything tracked before init
    var queued = pendingEvents.splice(0);
    for (var i = 0; i < queued.length; i++) emit(queued[i][0], queued[i][1], queued[i][2]);

    log('initialized', config);
    return api;
  }

  function track(eventName, properties) {
    if (!eventName || typeof eventName !== 'string') {
      log('track() requires an event name string');
      return null;
    }
    return emit(eventName, properties);
  }

  function trackPageView() {
    startPageView('pageview', { navigation_trigger: 'manual' });
  }

  function on(eventName, callback, options) {
    options = options || {};
    var type = config.eventPrefix + ':' + (eventName === '*' ? 'event' : eventName);
    var handler = function (e) { callback(e.detail, e); };
    window.addEventListener(type, handler);
    if (options.replay) {
      for (var i = 0; i < eventHistory.length; i++) {
        if (eventName === '*' || eventHistory[i].event_name === eventName) {
          callback(eventHistory[i], null);
        }
      }
    }
    return function off() { window.removeEventListener(type, handler); };
  }

  function setUserId(id) {
    var previous = userId;
    userId = id || null;
    if (userId && userId !== previous) {
      emit('user_identify', { user_id: userId, previous_user_id: previous });
    }
  }

  function setContext(key, value) {
    if (value === undefined || value === null) {
      delete context[key];
    } else {
      context[key] = value;
    }
  }

  function resetState() {
    eventHistory = [];
    pendingEvents = [];
    scrollDepth = 0;
    scrollTickPending = false;
    vitals = {
      first_contentful_paint: null,
      largest_contentful_paint: null,
      cumulative_layout_shift: null,
      first_input_delay: null
    };
    vitalsFlushed = false;
    pageViewId = null;
    pageStartTime = now();
    userId = null;
    context = {};
    currentUtm = null;
    staticDevice = null;
    rageClickState = { element: null, clicks: [], emitted: false };
    consentLevel = 'all';
  }

  function flush(url, options) {
    options = options || {};
    // Respect sampling unless force: true
    if (!sampled && !options.force) {
      log('flush: skipped (session not sampled, use force: true to override)');
      return false;
    }
    var events = eventHistory.slice();
    if (!events.length) {
      log('flush: no events to send');
      return false;
    }
    var payload = JSON.stringify({
      client_id: clientId,
      session_id: session.id,
      flushed_at: new Date().toISOString(),
      event_count: events.length,
      events: events
    });
    var sent = false;
    if (navigator.sendBeacon) {
      try {
        sent = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      } catch (e) {
        log('flush: sendBeacon failed', e);
      }
    }
    // Fallback to fetch if sendBeacon unavailable or failed
    if (!sent && typeof fetch !== 'undefined') {
      try {
        fetch(url, {
          method: 'POST',
          body: payload,
          headers: { 'Content-Type': 'application/json' },
          keepalive: true
        }).catch(function () { /* ignore network errors */ });
        sent = true;
      } catch (e) {
        log('flush: fetch failed', e);
      }
    }
    if (sent && options.clear !== false) {
      eventHistory = [];
    }
    log('flush:', sent ? 'sent' : 'failed', events.length, 'events to', url);
    return sent;
  }

  function destroy() {
    flushFormAbandons();
    contentStates.forEach(function (state) { clearTimeout(state.timer); });
    contentStates.clear();
    visibleContent.clear();
    formEngagement.clear();
    vitalsObservers.forEach(function (observer) {
      try { observer.disconnect(); } catch (e) { /* already disconnected */ }
    });
    vitalsObservers = [];
    cleanups.forEach(function (fn) {
      try { fn(); } catch (e) { /* best effort */ }
    });
    cleanups = [];
    observedRoots = [];
    historyPatched = false;
    resetState();
    ready = false;
    log('destroyed');
  }

  function setConsent(level) {
    var validLevels = ['all', 'essential', 'none'];
    if (validLevels.indexOf(level) === -1) {
      log('setConsent: invalid level "' + level + '", use "all", "essential", or "none"');
      return;
    }
    var previous = consentLevel;
    consentLevel = level;
    if (previous !== level) {
      // Handle client ID persistence changes
      if (level === 'essential' && previous !== 'essential') {
        // Downgrade: clear stored client ID, generate new session-only ID
        storageRemove(CID_KEY);
        clientId = uuid();
      } else if (level === 'all' && previous === 'essential' && config.privacy.persistClientId) {
        // Upgrade: persist current client ID
        storageSet(CID_KEY, clientId);
      }
      emit('consent_change', {
        previous_level: previous,
        new_level: level
      });
      log('consent changed:', previous, '→', level);
    }
  }

  var api = {
    __loaded: true,
    version: VERSION,
    init: init,
    track: track,
    trackPageView: trackPageView,
    on: on,
    setUserId: setUserId,
    getUserId: function () { return userId; },
    setContext: setContext,
    getContext: function () { return assign({}, context); },
    clearContext: function () { context = {}; },
    newSession: function () { startNewSession('manual'); },
    getClientId: function () { return clientId; },
    getSessionId: function () { return session.id; },
    getPageViewId: function () { return pageViewId; },
    getHistory: function () { return eventHistory.slice(); },
    flush: flush,
    getContentState: function () {
      var out = [];
      contentStates.forEach(function (state) {
        out.push({
          content_name: state.name,
          content_type: state.type,
          segment: state.segment,
          served: state.served,
          viewed: state.viewed,
          clicked: state.clicked,
          exposure_limit: state.exposureLimit,
          scroll_depth: state.scrollDepth
        });
      });
      return out;
    },
    isReady: function () { return ready; },
    isSampled: function () { return sampled; },
    setConsent: setConsent,
    getConsent: function () { return consentLevel; },
    destroy: destroy
  };

  // Replace any loader stub and replay its queued calls
  var queuedCalls = existing && existing._queue;
  window.vane = api;
  if (queuedCalls && queuedCalls.length) {
    for (var q = 0; q < queuedCalls.length; q++) {
      var call = queuedCalls[q];
      if (typeof api[call[0]] === 'function') api[call[0]].apply(api, call[1]);
    }
  }

  // Auto-init unless explicitly disabled via
  //   <script src="weathervane.js" data-vane-auto="false">
  // or `window.vaneConfig = { autoInit: false }` before this script loads.
  var currentScript = document.currentScript;
  var autoDisabled =
    (currentScript && currentScript.getAttribute('data-vane-auto') === 'false') ||
    (window.vaneConfig && window.vaneConfig.autoInit === false);
  if (!autoDisabled && !ready) {
    init(window.vaneConfig || {});
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : null,
  typeof document !== 'undefined' ? document : null);
