/**
 * Weathervane v0.8.0
 * TypeScript definitions for the zero-backend analytics SDK
 */

export interface WeathervaneConfig {
  // Emission
  eventPrefix?: string;
  historySize?: number;

  // Feature toggles
  enableAutoPageview?: boolean;
  enableDynamicPageview?: boolean;
  enableContentTracking?: boolean;
  enableLinkTracking?: boolean;
  enableFormTracking?: boolean;
  enableWebVitals?: boolean;
  enableErrorTracking?: boolean;
  enableRageClickTracking?: boolean;
  trackShadowDom?: boolean;

  // Session management
  sessionTimeout?: number;

  // Content tracking
  contentExposureLimit?: number;
  largeContentViewportFill?: number;

  // Form tracking
  formAbandonThreshold?: number;

  // Rage click detection
  rageClickThreshold?: number;
  rageClickWindow?: number;

  // Privacy
  privacy?: {
    collectDevice?: boolean;
    collectTimezone?: boolean;
    persistClientId?: boolean;
  };

  // Consent
  consent?: 'all' | 'essential' | 'none';

  // Sampling
  sampleRate?: number;

  // Payload size
  payloadMode?: 'full' | 'compact' | 'minimal';

  // Development
  debug?: boolean;
}

export interface PageContext {
  url: string;
  path: string;
  title: string | null;
  referrer: string | null;
  search: string | null;
  hash: string | null;
}

export interface DeviceContext {
  user_agent: string;
  browser_name: string;
  browser_version: string | null;
  language: string | null;
  timezone: string | null;
  screen_width: number | null;
  screen_height: number | null;
  viewport_width: number;
  viewport_height: number;
  device_type: 'desktop' | 'mobile' | 'tablet';
  device_memory: number | null;
  hardware_concurrency: number | null;
  cookie_enabled: boolean;
  online: boolean;
}

export interface UtmContext {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
}

export interface EngagementContext {
  scroll_depth: number;
  time_on_page: number;
}

export interface SdkContext {
  name?: string;
  version: string;
}

export interface WeathervanePayload<T = Record<string, unknown>> {
  event_id: string;
  event_name: string;
  timestamp: string;
  client_id: string;
  session_id: string;
  page_view_id: string;
  user_id: string | null;
  properties: T;
  page: PageContext | { path: string };
  device?: DeviceContext | {
    browser_name: string;
    device_type: string;
    viewport_width: number;
    viewport_height: number;
  } | null;
  utm?: UtmContext | null;
  engagement?: EngagementContext;
  context?: Record<string, unknown>;
  sdk?: SdkContext;
}

export interface ContentState {
  content_name: string;
  content_type: string | null;
  segment: string | null;
  served: boolean;
  viewed: boolean;
  clicked: boolean;
  exposure_limit: number;
  scroll_depth: number;
}

export interface FlushOptions {
  force?: boolean;
  clear?: boolean;
}

export interface OnOptions {
  replay?: boolean;
}

export type ConsentLevel = 'all' | 'essential' | 'none';

export type EventCallback<T = Record<string, unknown>> = (
  payload: WeathervanePayload<T>,
  event: CustomEvent<WeathervanePayload<T>> | null
) => void;

export interface WeathervaneAPI {
  /** SDK version */
  readonly version: string;

  /** Initialize the SDK with configuration options */
  init(options?: WeathervaneConfig): WeathervaneAPI;

  /** Emit a custom event */
  track<T extends Record<string, unknown>>(
    eventName: string,
    properties?: T
  ): WeathervanePayload<T> | null;

  /** Manually emit a pageview event */
  trackPageView(): void;

  /** Subscribe to events. Returns an unsubscribe function. */
  on<T = Record<string, unknown>>(
    eventName: string | '*',
    callback: EventCallback<T>,
    options?: OnOptions
  ): () => void;

  /** Set the user ID (emits user_identify event) */
  setUserId(id: string | null): void;

  /** Get the current user ID */
  getUserId(): string | null;

  /** Set a context key-value pair */
  setContext(key: string, value: unknown): void;

  /** Get all context data */
  getContext(): Record<string, unknown>;

  /** Clear all context data */
  clearContext(): void;

  /** Force a new session (emits session_start event) */
  newSession(): void;

  /** Get the persistent client ID */
  getClientId(): string;

  /** Get the current session ID */
  getSessionId(): string;

  /** Get the current page view ID */
  getPageViewId(): string;

  /** Get recent event history */
  getHistory(): WeathervanePayload[];

  /** Send event history to a URL via sendBeacon */
  flush(url: string, options?: FlushOptions): boolean;

  /** Get the state of all tracked content */
  getContentState(): ContentState[];

  /** Check if the SDK is initialized */
  isReady(): boolean;

  /** Check if this session is in the sample */
  isSampled(): boolean;

  /** Set consent level (emits consent_change event) */
  setConsent(level: ConsentLevel): void;

  /** Get current consent level */
  getConsent(): ConsentLevel;

  /** Destroy the SDK and clean up all listeners */
  destroy(): void;
}

declare global {
  interface Window {
    vane: WeathervaneAPI;
    vaneConfig?: WeathervaneConfig;
  }

  interface WindowEventMap {
    'vane:event': CustomEvent<WeathervanePayload>;
    'vane:pageview': CustomEvent<WeathervanePayload>;
    'vane:pageview_dynamic': CustomEvent<WeathervanePayload>;
    'vane:session_start': CustomEvent<WeathervanePayload>;
    'vane:content_serve': CustomEvent<WeathervanePayload>;
    'vane:content_view': CustomEvent<WeathervanePayload>;
    'vane:content_click': CustomEvent<WeathervanePayload>;
    'vane:link_click': CustomEvent<WeathervanePayload>;
    'vane:form_engage': CustomEvent<WeathervanePayload>;
    'vane:form_submit': CustomEvent<WeathervanePayload>;
    'vane:form_abandon': CustomEvent<WeathervanePayload>;
    'vane:user_identify': CustomEvent<WeathervanePayload>;
    'vane:web_vitals': CustomEvent<WeathervanePayload>;
    'vane:error': CustomEvent<WeathervanePayload>;
    'vane:rage_click': CustomEvent<WeathervanePayload>;
    'vane:consent_change': CustomEvent<WeathervanePayload>;
  }
}

declare const vane: WeathervaneAPI;
export default vane;
