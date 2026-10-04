import { describe, expect, it, vi } from 'vitest';
import {
  accountPartition,
  chromeUserAgent,
  embeddedEntrySource,
  embeddedHostConfigSource,
  embeddedManifest,
  EMBEDDED_ENTRY,
  EMBEDDED_HOST_CONFIG,
  isChatGptUrl,
  matchesUrlPattern,
  popupDisposition,
  tabMatches
} from '../src/main/embedded-browser-policy.js';
import { localBriefText } from '../src/main/session/local-brief.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'Chat On Steroids' },
  safeStorage: { isEncryptionAvailable: () => false },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig } = await import('../src/main/config.js');
const { addChatAccount, chatAccounts, linkChatAccountSetup, removeChatAccount, renameChatAccount, selectChatAccount } =
  await import('../src/main/chat-accounts.js');
const { addSetupProfile } = await import('../src/main/setup-profiles.js');

describe('built-in browser page policy', () => {
  it('keeps sign-in pop-ups inside, opens ChatGPT as a tab and sends the rest to the OS browser', () => {
    expect(popupDisposition('https://auth.openai.com/authorize?x=1')).toBe('sign-in');
    expect(popupDisposition('https://accounts.google.com/o/oauth2/v2/auth')).toBe('sign-in');
    expect(popupDisposition('https://appleid.apple.com/auth/authorize')).toBe('sign-in');
    expect(popupDisposition('https://chatgpt.com/c/abc')).toBe('chatgpt-tab');
    expect(popupDisposition('https://example.com/docs')).toBe('external');
    expect(popupDisposition('file:///etc/passwd')).toBe('deny');
    expect(popupDisposition('javascript:alert(1)')).toBe('deny');
    // A look-alike host is not a sign-in page.
    expect(popupDisposition('https://accounts.google.com.evil.example/')).toBe('external');
    expect(isChatGptUrl('http://chatgpt.com/')).toBe(false);
  });

  it('matches Chrome tab-query URL patterns, without the fragment', () => {
    expect(matchesUrlPattern('https://chatgpt.com/c/1?x=2#frag', 'https://chatgpt.com/*')).toBe(true);
    expect(matchesUrlPattern('https://chat.openai.com/', 'https://chatgpt.com/*')).toBe(false);
    expect(matchesUrlPattern('http://a.example.com/x', '*://*.example.com/*')).toBe(true);
    expect(matchesUrlPattern('https://example.com/x', '*://*.example.com/*')).toBe(true);
    expect(matchesUrlPattern('ftp://example.com/x', '*://example.com/*')).toBe(false);
    expect(matchesUrlPattern('https://chatgpt.com/g/p/c/1', 'https://chatgpt.com/g/*')).toBe(true);
    expect(matchesUrlPattern('https://chatgpt.com/c/1', 'https://chatgpt.com/g/*')).toBe(false);
    expect(matchesUrlPattern('https://chatgpt.com/', '<all_urls>')).toBe(true);
  });

  it('answers active and last-focused queries from the one-tab-per-window model', () => {
    const tab = { id: 4, windowId: 9, url: 'https://chatgpt.com/c/1', active: true, status: 'complete' as const, pinned: false };
    expect(tabMatches(tab, { url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] }, null)).toBe(true);
    expect(tabMatches(tab, { active: true, lastFocusedWindow: true }, 9)).toBe(true);
    expect(tabMatches(tab, { active: true, lastFocusedWindow: true }, 3)).toBe(false);
    expect(tabMatches({ ...tab, active: false }, { active: true }, 9)).toBe(false);
    expect(tabMatches(tab, { status: 'loading' }, 9)).toBe(false);
  });

  it('presents a plain Chrome user agent to ChatGPT and its sign-in pages', () => {
    const electron = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) chat-on-steroids/2.1.26 Chrome/140.0.7339.0 Electron/44.3.0 Safari/537.36';
    expect(chromeUserAgent(electron, 'chat-on-steroids'))
      .toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Safari/537.36');
  });

  it('stages the extension worker behind the host shim, without the name Electron rejects', () => {
    const manifest = { manifest_version: 3, permissions: ['storage', 'debugger', 'tabs'], background: { service_worker: 'background.js', type: 'module' } };
    expect(embeddedManifest(manifest)).toMatchObject({ permissions: ['storage', 'tabs'], background: { service_worker: EMBEDDED_ENTRY, type: 'module' } });
    expect(embeddedEntrySource('background.js').split('\n').filter(Boolean))
      .toEqual([`import './${EMBEDDED_HOST_CONFIG}';`, "import './embedded-host.js';", "import './background.js';"]);
    expect(embeddedHostConfigSource(41234, 'abc')).toBe('globalThis.__cosEmbeddedHost = Object.freeze({"port":41234,"token":"abc"});\n');
  });

  it('names one persistent partition per account and refuses unsafe ids', () => {
    expect(accountPartition('default')).toBe('persist:cos-chatgpt-default');
    expect(() => accountPartition('../x')).toThrow();
    expect(() => accountPartition('')).toThrow();
  });
});

describe('ChatGPT accounts', () => {
  it('starts with one Default account and selects a new account when it is added', () => {
    const base = defaultConfig('linux');
    expect(chatAccounts(base)).toEqual({ active: 'default', list: [{ id: 'default', name: 'Default' }] });
    const added = addChatAccount(base, '  Work  ');
    const accounts = chatAccounts(added);
    expect(accounts.list.map(row => row.name)).toEqual(['Default', 'Work']);
    expect(accounts.active).toBe(accounts.list[1]!.id);
    expect(chatAccounts(selectChatAccount(added, 'default')).active).toBe('default');
    expect(chatAccounts(renameChatAccount(added, 'default', 'Personal')).list[0]!.name).toBe('Personal');
    expect(() => addChatAccount(base, '   ')).toThrow();
    expect(() => selectChatAccount(base, 'missing')).toThrow();
  });

  it('switches the linked setup profile together with the account', () => {
    let config = addSetupProfile(defaultConfig('linux'), 'Work tunnel');
    const workProfile = config.tunnel.profileId!;
    config = { ...config, tunnel: { ...config.tunnel } };
    config = addChatAccount(config, 'Work');
    const work = chatAccounts(config).active;
    config = linkChatAccountSetup(config, work, workProfile);
    config = linkChatAccountSetup(config, 'default', 'default');
    const atDefault = selectChatAccount(config, 'default');
    expect(atDefault.tunnel.profileId).toBe('default');
    const atWork = selectChatAccount(atDefault, work);
    expect(atWork.tunnel.profileId).toBe(workProfile);
    expect(atWork.tunnel.profileEpoch).toBeGreaterThan(atDefault.tunnel.profileEpoch ?? 0);
    expect(() => linkChatAccountSetup(config, work, 'nope')).toThrow();
    expect(chatAccounts(linkChatAccountSetup(config, work, null)).list.find(row => row.id === work)).not.toHaveProperty('setupProfileId');
  });

  it('keeps one account and moves to a survivor when the active one is removed', () => {
    const base = defaultConfig('linux');
    expect(() => removeChatAccount(base, 'default')).toThrow();
    const added = addChatAccount(base, 'Work');
    const work = chatAccounts(added).active;
    const removed = removeChatAccount(added, work);
    expect(chatAccounts(removed)).toEqual({ active: 'default', list: [{ id: 'default', name: 'Default' }] });
  });
});

describe('local handoff brief', () => {
  it('carries the recorded conversation in order and says where it came from', () => {
    const brief = localBriefText('Port the parser', [
      { role: 'user', text: 'Port the parser to Rust' },
      { role: 'assistant', text: 'Done with the lexer.' },
      { role: 'user', text: '   ' },
      { role: 'user', text: 'Now the AST' }
    ]);
    expect(brief).toContain('“Port the parser”');
    expect(brief).toContain('assembled this brief from the messages it recorded locally');
    expect(brief.indexOf('Port the parser to Rust')).toBeLessThan(brief.indexOf('Done with the lexer.'));
    expect(brief.indexOf('Done with the lexer.')).toBeLessThan(brief.indexOf('Now the AST'));
    expect(brief.match(/^## User$/gm)).toHaveLength(2);
  });
});
