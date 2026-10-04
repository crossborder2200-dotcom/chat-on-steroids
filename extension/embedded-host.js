/**
 * Runs only when Chat On Steroids hosts ChatGPT in its own window instead of Chrome.
 *
 * Chrome never loads this file: the manifest does not name it. The app stages a copy of this
 * extension whose service worker imports, in order, the per-launch host address, this module
 * and the unchanged background.js. Electron implements storage, scripting, alarms, runtime and
 * tabs.sendMessage itself, so those stay native. It has no windows, debugger or permissions API
 * and only part of tabs, so those come from the app, which owns every tab in this browser:
 * tab ids are the app's webContents ids, the same ids Electron's native APIs use.
 *
 * The app is the only authority on tab state here. Calls are answered from its live windows,
 * and tab/debugger events arrive over one socket that the app pings, which also keeps this
 * worker running the way the wake socket does in Chrome.
 */

const host = globalThis.__cosEmbeddedHost;
if (!host || !Number.isInteger(host.port) || typeof host.token !== 'string') {
  throw new Error('Chat On Steroids embedded host configuration is missing');
}
const base = `http://127.0.0.1:${host.port}`;

async function call(name, ...args) {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cos-host-token': host.token },
    body: JSON.stringify({ name, args })
  });
  const reply = await response.json().catch(() => null);
  if (!response.ok || !reply || reply.ok !== true) throw new Error(reply?.error || `Embedded host refused ${name}`);
  return reply.value;
}

/** A chrome.events.Event lookalike: background.js only adds and removes listeners. */
function event() {
  const listeners = new Set();
  return {
    addListener: listener => { listeners.add(listener); },
    removeListener: listener => { listeners.delete(listener); },
    hasListener: listener => listeners.has(listener),
    dispatch: args => {
      for (const listener of [...listeners]) {
        try { listener(...args); } catch (error) { console.error(error); }
      }
    }
  };
}

const events = {
  'runtime.onStartup': event(),
  'tabs.onUpdated': event(),
  'tabs.onRemoved': event(),
  'tabs.onActivated': event(),
  'debugger.onEvent': event(),
  'debugger.onDetach': event()
};

const native = chrome.tabs;
const tabs = {
  get: id => call('tabs.get', id),
  query: (filter = {}) => call('tabs.query', filter),
  create: properties => call('tabs.create', properties ?? {}),
  update: (id, properties) => typeof id === 'object' && id !== null ? call('tabs.update', null, id) : call('tabs.update', id, properties ?? {}),
  remove: ids => call('tabs.remove', ids).then(() => undefined),
  reload: id => call('tabs.reload', id).then(() => undefined),
  move: (id, properties) => call('tabs.move', id, properties ?? {}),
  sendMessage: (...args) => native.sendMessage(...args),
  onUpdated: events['tabs.onUpdated'],
  onRemoved: events['tabs.onRemoved'],
  onActivated: events['tabs.onActivated']
};
const windows = {
  WINDOW_ID_NONE: -1,
  get: (id, options) => call('windows.get', id, options ?? {}),
  create: properties => call('windows.create', properties ?? {}),
  update: (id, properties) => call('windows.update', id, properties ?? {}),
  remove: id => call('windows.remove', id).then(() => undefined)
};
const debuggerApi = {
  attach: (target, version) => call('debugger.attach', target, version).then(() => undefined),
  detach: target => call('debugger.detach', target).then(() => undefined),
  sendCommand: (target, method, params) => call('debugger.sendCommand', target, method, params ?? {}),
  getTargets: () => call('debugger.getTargets'),
  onEvent: events['debugger.onEvent'],
  onDetach: events['debugger.onDetach']
};
const manifestPermissions = new Set(chrome.runtime.getManifest().permissions ?? []);
const permissions = {
  // The staged manifest drops `debugger` only because Electron does not know the name;
  // this host provides it, so the declared set is what the extension may rely on.
  contains: async request => (request?.permissions ?? []).every(name => name === 'debugger' || manifestPermissions.has(name))
};

for (const [name, value] of Object.entries({ tabs, windows, debugger: debuggerApi, permissions })) {
  Object.defineProperty(chrome, name, { value, configurable: true, enumerable: true, writable: true });
}

// Chrome tells a worker the browser just started; a paired worker reconnects to the app on
// that event alone. Electron never sends it, so the host names the first worker start of each
// load, and a worker restarted later by idle shutdown does not see it again, as in Chrome.
Object.defineProperty(chrome.runtime, 'onStartup', { value: events['runtime.onStartup'], configurable: true, enumerable: true });
setTimeout(() => {
  call('host.startup').then(first => { if (first === true) events['runtime.onStartup'].dispatch([]); }).catch(() => undefined);
}, 0);

let socket = null;
let retry = 250;
function connect() {
  if (socket) return;
  const current = new WebSocket(`ws://127.0.0.1:${host.port}/events`);
  socket = current;
  current.onopen = () => { retry = 250; current.send(host.token); };
  current.onmessage = message => {
    let data = null;
    try { data = JSON.parse(String(message.data)); } catch { return; }
    if (data?.type === 'ping') { current.send('pong'); return; }
    if (data?.type === 'event' && events[data.name] && Array.isArray(data.args)) events[data.name].dispatch(data.args);
  };
  current.onclose = () => {
    if (socket === current) socket = null;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10_000);
  };
  current.onerror = () => { try { current.close(); } catch { /* onclose reconnects. */ } };
}
connect();
