/**
 * Pure rules for the built-in ChatGPT browser (`embedded-browser.ts`): which URLs a tab may
 * load, which pop-ups stay inside it, how Chrome's tab-query filters match, and how the
 * companion extension is rewritten for this host. Nothing here touches Electron, so every
 * rule is unit-tested on its own.
 */

/** ChatGPT pages the companion's content scripts run on; also where app-made tabs live. */
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

/**
 * Sign-in pages ChatGPT opens in a pop-up. They must share the tab's session or the login
 * never reaches ChatGPT; anything else a page tries to open goes to the user's own browser.
 */
const SIGN_IN_HOSTS = [
  'auth.openai.com',
  'auth0.openai.com',
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com'
];

function parsed(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

export function isWebUrl(value: string): boolean {
  const url = parsed(value);
  return Boolean(url && (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password);
}

export function isChatGptUrl(value: string): boolean {
  const url = parsed(value);
  return Boolean(url && url.protocol === 'https:' && CHATGPT_HOSTS.has(url.hostname));
}

export function isSignInUrl(value: string): boolean {
  const url = parsed(value);
  if (!url || url.protocol !== 'https:') return false;
  return SIGN_IN_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** What a page's window.open becomes: a sign-in pop-up, another ChatGPT tab, or the OS browser. */
export function popupDisposition(value: string): 'sign-in' | 'chatgpt-tab' | 'external' | 'deny' {
  if (isSignInUrl(value)) return 'sign-in';
  if (isChatGptUrl(value)) return 'chatgpt-tab';
  return isWebUrl(value) ? 'external' : 'deny';
}

/**
 * Chrome match patterns as `chrome.tabs.query({url})` uses them: `<scheme>://<host>/<path>`,
 * where `*` scheme means http or https, a `*.` host prefix also matches the bare domain, and
 * `*` in the path matches anything. The fragment is never matched.
 */
export function matchesUrlPattern(value: string, pattern: string): boolean {
  if (pattern === '<all_urls>') return isWebUrl(value);
  const match = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern);
  const url = parsed(value);
  if (!match || !url) return false;
  const [, scheme, host, path] = match as unknown as [string, string, string, string];
  const protocol = url.protocol.slice(0, -1);
  if (scheme === '*' ? protocol !== 'http' && protocol !== 'https' : protocol !== scheme) return false;
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const domain = host.slice(2);
      if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return false;
    } else if (url.hostname !== host) return false;
  }
  const escaped = path.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(`${url.pathname}${url.search}`);
}

export interface TabQueryFilter {
  url?: string | string[];
  active?: boolean;
  lastFocusedWindow?: boolean;
  currentWindow?: boolean;
  windowId?: number;
  status?: 'loading' | 'complete';
  pinned?: boolean;
}

export interface TabFacts {
  id: number;
  windowId: number;
  url: string;
  pendingUrl?: string;
  active: boolean;
  status: 'loading' | 'complete';
  pinned: boolean;
}

/** One-tab-per-window host: "current" and "last focused" both mean the last focused window. */
export function tabMatches(tab: TabFacts, filter: TabQueryFilter, lastFocusedWindowId: number | null): boolean {
  if (filter.url !== undefined) {
    const patterns = Array.isArray(filter.url) ? filter.url : [filter.url];
    if (!patterns.some(pattern => matchesUrlPattern(tab.url, pattern))) return false;
  }
  if (filter.active !== undefined && tab.active !== filter.active) return false;
  if ((filter.lastFocusedWindow || filter.currentWindow) && tab.windowId !== lastFocusedWindowId) return false;
  if (filter.windowId !== undefined && tab.windowId !== filter.windowId) return false;
  if (filter.status !== undefined && tab.status !== filter.status) return false;
  if (filter.pinned !== undefined && tab.pinned !== filter.pinned) return false;
  return true;
}

/**
 * The user agent ChatGPT and its sign-in providers see: Electron's own, without the
 * `Electron/x` and app-name tokens, which some sign-in pages reject as an embedded browser.
 */
export function chromeUserAgent(fallback: string, appName: string): string {
  const name = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fallback
    .replace(/\sElectron\/\S+/g, '')
    .replace(new RegExp(`\\s${name}\\/\\S+`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Service worker entry of the staged extension: host address, host shim, then the real worker. */
export const EMBEDDED_ENTRY = 'embedded-entry.js';
export const EMBEDDED_HOST_CONFIG = 'embedded-host-config.js';

/**
 * The manifest Electron loads. The worker starts from the entry module instead of
 * background.js, and `debugger` is dropped only because Electron rejects the unknown name:
 * the host shim provides that API.
 */
export function embeddedManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.filter(name => name !== 'debugger') : [];
  return { ...manifest, permissions, background: { service_worker: EMBEDDED_ENTRY, type: 'module' } };
}

/** Imports run in order, so the host address exists before the shim and the shim before the worker. */
export function embeddedEntrySource(backgroundWorker: string): string {
  return `import './${EMBEDDED_HOST_CONFIG}';\nimport './embedded-host.js';\nimport './${backgroundWorker}';\n`;
}

export function embeddedHostConfigSource(port: number, token: string): string {
  return `globalThis.__cosEmbeddedHost = Object.freeze(${JSON.stringify({ port, token })});\n`;
}

/** Account ids name a persistent partition directory, so they stay short and plain. */
export const CHAT_ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function accountPartition(accountId: string): string {
  if (!CHAT_ACCOUNT_ID.test(accountId)) throw new Error('Invalid ChatGPT account id');
  return `persist:cos-chatgpt-${accountId}`;
}
