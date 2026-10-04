/**
 * The built-in ChatGPT browser: ChatGPT runs in this app's own windows instead of Chrome.
 *
 * The companion extension is not rewritten for this host. Electron loads a staged copy of it
 * into a persistent session per ChatGPT account, and it talks to the bridge exactly as it does
 * in Chrome. Electron provides storage, scripting, alarms, runtime and tabs.sendMessage; it has
 * no windows, debugger or permissions API and only part of tabs, so `extension/embedded-host.js`
 * replaces those with calls to this module. This module is therefore the only authority on the
 * tabs of this browser: a tab is one window holding one page, its id is the page's webContents
 * id (the id Electron's native extension APIs use too), and its events come from here.
 *
 * Security boundaries:
 * - The host listener binds 127.0.0.1, takes a per-launch token that only the staged extension
 *   files contain, and refuses any Origin but the loaded extension's.
 * - Pages run sandboxed with context isolation and no Node, in a session separate from the app
 *   window's, so nothing in ChatGPT can reach the app's preload API.
 * - Only sign-in pop-ups stay inside; any other link opens in the user's own browser.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { app, BrowserWindow, session, shell, type Session, type WebContents } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import { getConfig } from './config.js';
import { extensionDir } from './extension-path.js';
import { logInfo, logWarn } from './logger.js';
import { browserWindowIconPath } from './window-icon.js';
import {
  accountPartition,
  chromeUserAgent,
  embeddedEntrySource,
  embeddedHostConfigSource,
  embeddedManifest,
  EMBEDDED_ENTRY,
  EMBEDDED_HOST_CONFIG,
  isWebUrl,
  popupDisposition,
  tabMatches,
  type TabQueryFilter
} from './embedded-browser-policy.js';

const MAX_RPC_BYTES = 1024 * 1024;
const PING_MS = 20_000;
const DEFAULT_BOUNDS = { width: 1100, height: 820 };

interface HostTab {
  id: number;
  window: BrowserWindow;
  contents: WebContents;
  pendingUrl: string | null;
  autoDiscardable: boolean;
  lastAccessed: number;
}

interface Listener {
  server: Server;
  sockets: WebSocketServer;
  port: number;
  token: string;
  ping: NodeJS.Timeout;
}

interface Profile {
  accountId: string;
  session: Session;
  extensionId: string;
  /** Chrome's runtime.onStartup goes to the first worker start of a load only. */
  startupDelivered: boolean;
}

let listener: Listener | null = null;
let stagedDir: string | null = null;
let profile: Profile | null = null;
/**
 * The worker starts inside loadExtension, before its id is known here, and calls the host at
 * once. Its first calls wait for the load instead of being refused as an unknown origin.
 */
let loading: Promise<void> | null = null;
/** Serializes start, stop and account switches; none of them may interleave. */
let lifecycle: Promise<unknown> = Promise.resolve();
const tabs = new Map<number, HostTab>();
const subscribers = new Set<WebSocket>();
const embeddedSessions = new WeakSet<Session>();
const preparedSessions = new WeakSet<Session>();
let lastFocusedWindowId: number | null = null;

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = lifecycle.catch(() => undefined).then(work);
  lifecycle = next;
  return next;
}

/** Contents of this browser keep their own navigation policy; app.ts must not deny it. */
export function isEmbeddedBrowserContents(contents: WebContents): boolean {
  try { return embeddedSessions.has(contents.session); } catch { return false; }
}

export function embeddedBrowserRunning(): boolean {
  return profile !== null;
}

export function embeddedBrowserAccount(): string | null {
  return profile?.accountId ?? null;
}

function activeAccountId(): string {
  return getConfig().chatAccounts?.active ?? 'default';
}

// ------------------------------------------------------------------ tab model

function tabInfo(tab: HostTab): Record<string, unknown> {
  const window = tab.window;
  const active = !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  const url = tab.contents.isDestroyed() ? '' : tab.contents.getURL();
  return {
    id: tab.id,
    windowId: window.id,
    index: 0,
    url: url || tab.pendingUrl || '',
    ...(tab.pendingUrl ? { pendingUrl: tab.pendingUrl } : {}),
    title: tab.contents.isDestroyed() ? '' : tab.contents.getTitle(),
    status: !tab.contents.isDestroyed() && tab.contents.isLoading() ? 'loading' : 'complete',
    active,
    highlighted: active,
    selected: active,
    pinned: false,
    discarded: false,
    frozen: false,
    autoDiscardable: tab.autoDiscardable,
    audible: !tab.contents.isDestroyed() && tab.contents.isCurrentlyAudible(),
    incognito: false,
    lastAccessed: tab.lastAccessed,
    groupId: -1
  };
}

function windowInfo(window: BrowserWindow, populate = false): Record<string, unknown> {
  const state = !window.isVisible() || window.isMinimized() ? 'minimized'
    : window.isFullScreen() ? 'fullscreen' : window.isMaximized() ? 'maximized' : 'normal';
  const bounds = window.getBounds();
  const owned = [...tabs.values()].filter(tab => tab.window === window);
  return {
    id: window.id,
    focused: window.isFocused(),
    state,
    type: 'normal',
    incognito: false,
    alwaysOnTop: false,
    left: bounds.x,
    top: bounds.y,
    width: bounds.width,
    height: bounds.height,
    ...(populate ? { tabs: owned.map(tabInfo) } : {})
  };
}

function tabById(id: unknown): HostTab {
  const tab = typeof id === 'number' ? tabs.get(id) : undefined;
  if (!tab || tab.window.isDestroyed() || tab.contents.isDestroyed()) throw new Error(`No tab with id: ${String(id)}.`);
  return tab;
}

function windowById(id: unknown): BrowserWindow {
  const tab = [...tabs.values()].find(candidate => candidate.window.id === id);
  if (!tab || tab.window.isDestroyed()) throw new Error(`No window with id: ${String(id)}.`);
  return tab.window;
}

function emit(name: string, args: unknown[]): void {
  const message = JSON.stringify({ type: 'event', name, args });
  for (const socket of subscribers) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}

function updated(tab: HostTab, change: Record<string, unknown>): void {
  if (tab.contents.isDestroyed()) return;
  emit('tabs.onUpdated', [tab.id, change, tabInfo(tab)]);
}

function reveal(tab: HostTab): void {
  const window = tab.window;
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  tab.lastAccessed = Date.now();
}

function sessionFor(accountId: string): Session {
  const ses = session.fromPartition(accountPartition(accountId));
  embeddedSessions.add(ses);
  return ses;
}

function createTab(url: string, active: boolean): HostTab {
  if (!profile) throw new Error('The built-in ChatGPT browser is not running');
  if (!isWebUrl(url)) throw new Error('Only web pages can open in the built-in browser');
  const window = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    show: false,
    title: 'ChatGPT',
    autoHideMenuBar: true,
    icon: browserWindowIconPath(process.platform, app.isPackaged, process.resourcesPath),
    webPreferences: {
      session: profile.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // App-made chats keep working while hidden, as Chrome does with throttling switched off.
      backgroundThrottling: false,
      spellcheck: true
    }
  });
  const contents = window.webContents;
  const tab: HostTab = { id: contents.id, window, contents, pendingUrl: url, autoDiscardable: true, lastAccessed: Date.now() };
  tabs.set(tab.id, tab);
  watchTab(tab);
  if (active) window.once('ready-to-show', () => reveal(tab));
  void contents.loadURL(url).catch(() => { /* did-fail-load and the extension's own checks report it. */ });
  return tab;
}

function watchTab(tab: HostTab): void {
  const { contents, window } = tab;
  applyPagePolicy(contents);
  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    tab.pendingUrl = details.url;
  });
  contents.on('did-start-loading', () => updated(tab, { status: 'loading' }));
  contents.on('did-navigate', (_event, url) => { tab.pendingUrl = null; updated(tab, { url }); });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) updated(tab, { url }); });
  contents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) tab.pendingUrl = null; });
  contents.on('did-stop-loading', () => { tab.pendingUrl = null; updated(tab, { status: 'complete' }); });
  contents.on('page-title-updated', (_event, title) => {
    updated(tab, { title });
    if (!window.isDestroyed()) window.setTitle(title ? `${title} — ChatGPT` : 'ChatGPT');
  });
  contents.debugger.on('message', (_event, method, params, sessionId) => {
    emit('debugger.onEvent', [{ tabId: tab.id, ...(sessionId ? { sessionId } : {}) }, method, params]);
  });
  contents.debugger.on('detach', (_event, reason) => emit('debugger.onDetach', [{ tabId: tab.id }, reason]));
  window.on('focus', () => {
    lastFocusedWindowId = window.id;
    tab.lastAccessed = Date.now();
    emit('tabs.onActivated', [{ tabId: tab.id, windowId: window.id }]);
  });
  window.on('show', () => updated(tab, { status: contents.isLoading() ? 'loading' : 'complete' }));
  window.on('closed', () => {
    if (tabs.get(tab.id) !== tab) return;
    tabs.delete(tab.id);
    if (lastFocusedWindowId === window.id) lastFocusedWindowId = null;
    emit('tabs.onRemoved', [tab.id, { windowId: window.id, isWindowClosing: true }]);
  });
}

/** Pages browse freely, but only sign-in pop-ups stay inside and only web schemes load. */
function applyPagePolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const disposition = popupDisposition(url);
    if (disposition === 'sign-in') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
        }
      };
    }
    if (disposition === 'chatgpt-tab') {
      try { createTab(url, true); } catch (error) { logWarn(`built-in browser could not open a ChatGPT tab: ${(error as Error).message}`); }
    } else if (disposition === 'external') {
      void shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => applyPagePolicy(child.webContents));
  contents.on('will-navigate', (event, url) => { if (!isWebUrl(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isWebUrl(url)) event.preventDefault(); });
}

/** Session-wide settings, applied once per account session. */
function prepareSession(ses: Session): void {
  if (preparedSessions.has(ses)) return;
  preparedSessions.add(ses);
  ses.setUserAgent(chromeUserAgent(app.userAgentFallback, app.getName()));
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

// ------------------------------------------------------------------ host calls

type Rpc = (...args: unknown[]) => unknown;

function closeTab(tab: HostTab): void {
  if (!tab.window.isDestroyed()) tab.window.destroy();
}

const calls: Record<string, Rpc> = {
  'host.startup': () => {
    if (!profile || profile.startupDelivered) return false;
    profile.startupDelivered = true;
    return true;
  },
  'tabs.get': (id) => tabInfo(tabById(id)),
  'tabs.query': (filter) => [...tabs.values()]
    .filter(tab => !tab.window.isDestroyed() && !tab.contents.isDestroyed())
    .map(tabInfo)
    .filter(info => tabMatches(info as never, (filter ?? {}) as TabQueryFilter, lastFocusedWindowId)),
  'tabs.create': (properties) => {
    const { url, active } = (properties ?? {}) as { url?: string; active?: boolean };
    return tabInfo(createTab(url || 'https://chatgpt.com/', active !== false));
  },
  'tabs.update': (id, properties) => {
    const tab = id === null
      ? [...tabs.values()].find(candidate => candidate.window.id === lastFocusedWindowId) ?? tabById(undefined)
      : tabById(id);
    const { url, active, autoDiscardable } = (properties ?? {}) as { url?: string; active?: boolean; autoDiscardable?: boolean };
    if (typeof autoDiscardable === 'boolean') tab.autoDiscardable = autoDiscardable;
    if (typeof url === 'string') {
      if (!isWebUrl(url)) throw new Error('Only web pages can open in the built-in browser');
      tab.pendingUrl = url;
      void tab.contents.loadURL(url).catch(() => undefined);
    }
    if (active === true) reveal(tab);
    return tabInfo(tab);
  },
  'tabs.remove': (ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) closeTab(tabById(id));
  },
  'tabs.reload': (id) => { tabById(id).contents.reload(); },
  // One page per window: a move never changes which window shows the page.
  'tabs.move': (id) => tabInfo(tabById(id)),
  'windows.get': (id, options) => windowInfo(windowById(id), Boolean((options as { populate?: boolean } | undefined)?.populate)),
  'windows.create': (properties) => {
    const { url, focused, state } = (properties ?? {}) as { url?: string | string[]; focused?: boolean; state?: string };
    const first = Array.isArray(url) ? url[0] : url;
    const tab = createTab(first || 'https://chatgpt.com/', focused !== false && state !== 'minimized');
    return windowInfo(tab.window, true);
  },
  'windows.update': (id, properties) => {
    const window = windowById(id);
    const { state, focused } = (properties ?? {}) as { state?: string; focused?: boolean };
    // A hidden app-made window already reads as minimized; minimizing must not reveal it.
    if (state === 'minimized') { if (window.isVisible()) window.minimize(); }
    else if (state === 'maximized') { window.show(); window.maximize(); }
    else if (state === 'normal' || focused === true) {
      const tab = [...tabs.values()].find(candidate => candidate.window === window);
      if (tab) reveal(tab);
    }
    return windowInfo(window);
  },
  'windows.remove': (id) => { windowById(id).destroy(); },
  'debugger.attach': (target, version) => {
    tabById((target as { tabId?: number } | undefined)?.tabId).contents.debugger.attach(typeof version === 'string' ? version : '1.3');
  },
  'debugger.detach': (target) => {
    const contents = tabById((target as { tabId?: number } | undefined)?.tabId).contents;
    if (!contents.debugger.isAttached()) throw new Error('Debugger is not attached to the tab');
    contents.debugger.detach();
  },
  'debugger.sendCommand': (target, method, params) => {
    const { tabId, sessionId } = (target ?? {}) as { tabId?: number; sessionId?: string };
    if (typeof method !== 'string') throw new Error('Missing debugger method');
    return tabById(tabId).contents.debugger.sendCommand(method, (params ?? {}) as object, sessionId);
  },
  'debugger.getTargets': () => [...tabs.values()]
    .filter(tab => !tab.contents.isDestroyed())
    .map(tab => ({ id: String(tab.id), tabId: tab.id, type: 'page', title: tab.contents.getTitle(), url: tab.contents.getURL(), attached: tab.contents.debugger.isAttached() }))
};

function sameToken(given: string | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originAllowed(origin: string | undefined): boolean {
  return profile !== null && origin === `chrome-extension://${profile.extensionId}`;
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function settledOrigin(origin: string | undefined): Promise<boolean> {
  if (!profile && loading) await loading.catch(() => undefined);
  return originAllowed(origin);
}

function serveRpc(request: IncomingMessage, response: ServerResponse, token: string): void {
  if (request.method !== 'POST' || request.url !== '/rpc') return reply(response, 404, { ok: false, error: 'not_found' });
  if (!sameToken(request.headers['x-cos-host-token'] as string | undefined, token)) {
    return reply(response, 403, { ok: false, error: 'forbidden' });
  }
  const admitted = settledOrigin(request.headers.origin);
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_RPC_BYTES) { reply(response, 413, { ok: false, error: 'too_large' }); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (response.headersSent) return;
    void (async () => {
      if (!await admitted) return reply(response, 403, { ok: false, error: 'forbidden' });
      try {
        const { name, args } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: unknown; args?: unknown };
        const handler = typeof name === 'string' && Object.hasOwn(calls, name) ? calls[name] : undefined;
        if (!handler) return reply(response, 400, { ok: false, error: `unsupported: ${String(name)}` });
        const value = await handler(...(Array.isArray(args) ? args : []));
        reply(response, 200, { ok: true, value: value ?? null });
      } catch (error) {
        reply(response, 200, { ok: false, error: (error as Error).message || 'failed' });
      }
    })();
  });
}

async function startListener(): Promise<Listener> {
  if (listener) return listener;
  const token = randomBytes(32).toString('base64url');
  const server = createServer((request, response) => serveRpc(request, response, token));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    void settledOrigin(request.headers.origin).then(allowed => {
      if (request.url !== '/events' || !allowed) { socket.destroy(); return; }
      upgrade(request, socket, head);
    });
  });
  const upgrade = (request: IncomingMessage, socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer): void => {
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const timer = setTimeout(() => ws.close(), 5_000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        if (!sameToken(String(data), token)) { ws.close(); return; }
        subscribers.add(ws);
        ws.on('close', () => subscribers.delete(ws));
      });
    });
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Built-in browser host has no port');
  const ping = setInterval(() => {
    const message = JSON.stringify({ type: 'ping' });
    for (const socket of subscribers) if (socket.readyState === socket.OPEN) socket.send(message);
  }, PING_MS);
  ping.unref();
  listener = { server, sockets, port: address.port, token, ping };
  return listener;
}

/** One staged copy per launch: the host address in it is only valid for this process. */
function stageExtension(host: Listener): string {
  if (stagedDir) return stagedDir;
  const source = extensionDir();
  if (!source) throw new Error('The extension folder is missing from this installation. Reinstall the app.');
  const target = path.join(app.getPath('userData'), 'embedded-extension');
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  const manifestPath = path.join(target, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const worker = (manifest.background as { service_worker?: string } | undefined)?.service_worker ?? 'background.js';
  writeFileSync(path.join(target, EMBEDDED_HOST_CONFIG), embeddedHostConfigSource(host.port, host.token), 'utf8');
  writeFileSync(path.join(target, EMBEDDED_ENTRY), embeddedEntrySource(worker), 'utf8');
  writeFileSync(manifestPath, `${JSON.stringify(embeddedManifest(manifest), null, 2)}\n`, 'utf8');
  stagedDir = target;
  return target;
}

async function startProfile(accountId: string): Promise<void> {
  if (profile?.accountId === accountId) return;
  if (profile) await stopProfile();
  const host = await startListener();
  const dir = stageExtension(host);
  const ses = sessionFor(accountId);
  prepareSession(ses);
  // Electron keeps an extension worker's registered scripts across launches, so without this
  // the worker kept running the previous launch's files, host address included. Dropping the
  // session's worker registrations makes the load register the staged files afresh. The
  // extension's storage is separate and stays; ChatGPT's own worker only re-installs.
  await ses.clearStorageData({ storages: ['serviceworkers'] });
  const load = ses.extensions.loadExtension(dir, { allowFileAccess: false });
  loading = load.then(() => undefined);
  try {
    const extension = await load;
    profile = { accountId, session: ses, extensionId: extension.id, startupDelivered: false };
  } finally {
    loading = null;
  }
  logInfo(`built-in ChatGPT browser started for account ${accountId}`);
}

async function stopProfile(): Promise<void> {
  const current = profile;
  if (!current) return;
  for (const tab of [...tabs.values()]) closeTab(tab);
  for (const socket of subscribers) socket.close();
  subscribers.clear();
  try { current.session.extensions.removeExtension(current.extensionId); } catch { /* Already gone. */ }
  profile = null;
  logInfo(`built-in ChatGPT browser stopped for account ${current.accountId}`);
}

// ------------------------------------------------------------------ public lifecycle

/** Starts the browser for the active account; a running one for another account is replaced. */
export function startEmbeddedBrowser(): Promise<void> {
  return serialized(() => startProfile(activeAccountId()));
}

export function stopEmbeddedBrowser(): Promise<void> {
  return serialized(() => stopProfile());
}

/** Follows the saved browser and account choice after a settings change. */
export function syncEmbeddedBrowser(): Promise<void> {
  return getConfig().ui.chatBrowser === 'embedded' ? startEmbeddedBrowser() : stopEmbeddedBrowser();
}

/** The app's launcher for this browser: the same role as starting Chrome with a URL. */
export async function openInEmbeddedBrowser(url: string, options: { background?: boolean } = {}): Promise<void> {
  await startEmbeddedBrowser();
  createTab(url, options.background !== true);
}

/** Shows ChatGPT to the user, for signing in or reading along: an open tab first, else a new one. */
export async function showEmbeddedBrowser(): Promise<void> {
  await startEmbeddedBrowser();
  const open = [...tabs.values()].sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
  if (open) reveal(open);
  else createTab('https://chatgpt.com/', true);
}

/** Signs an account out by clearing its stored site data; its windows close first. */
export function clearEmbeddedAccountData(accountId: string): Promise<void> {
  return serialized(async () => {
    if (profile?.accountId === accountId) await stopProfile();
    await sessionFor(accountId).clearStorageData();
  });
}

export async function shutdownEmbeddedBrowser(): Promise<void> {
  await serialized(() => stopProfile()).catch(() => undefined);
  const current = listener;
  listener = null;
  if (!current) return;
  clearInterval(current.ping);
  current.sockets.close();
  await new Promise<void>(resolve => current.server.close(() => resolve()));
}
