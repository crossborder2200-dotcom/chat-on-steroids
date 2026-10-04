import { randomUUID } from 'node:crypto';
import type { ChatAccount, Config } from '../shared/types.js';
import { switchSetupProfile } from './setup-profiles.js';

/**
 * ChatGPT accounts of the built-in browser. Each one is a persistent browser session
 * (`embedded-browser-policy.ts::accountPartition`), so its sign-in survives restarts and
 * switching is a choice of session, never a sign-out. Config transforms only; the browser
 * follows the committed choice through `embedded-browser.ts::syncEmbeddedBrowser`.
 *
 * An account may name the setup profile its ChatGPT plugins use: a plugin created in one
 * account's ChatGPT is not visible from another, so switching the account switches that
 * profile's tunnel IDs and key in the same config commit.
 */

const MAX_ACCOUNTS = 12;

export function chatAccounts(config: Config): { active: string; list: ChatAccount[] } {
  return config.chatAccounts ?? { active: 'default', list: [{ id: 'default', name: 'Default' }] };
}

function accountName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error('Enter an account name (1–80 characters)');
  return trimmed;
}

function requireAccount(config: Config, id: string): ChatAccount {
  const account = chatAccounts(config).list.find(row => row.id === id);
  if (!account) throw new Error('ChatGPT account not found');
  return account;
}

function knownSetupProfile(config: Config, id: string): boolean {
  return (config.tunnel.profileId ?? 'default') === id || Boolean(config.setupProfiles?.some(profile => profile.id === id));
}

export function selectChatAccount(config: Config, id: string): Config {
  const accounts = chatAccounts(config);
  const account = requireAccount(config, id);
  let next: Config = { ...config, chatAccounts: { ...accounts, active: id } };
  const linked = account.setupProfileId;
  if (linked && linked !== (config.tunnel.profileId ?? 'default') && knownSetupProfile(config, linked)) {
    next = switchSetupProfile(next, linked);
  }
  return next;
}

export function addChatAccount(config: Config, name: string): Config {
  const accounts = chatAccounts(config);
  if (accounts.list.length >= MAX_ACCOUNTS) throw new Error('ChatGPT account limit reached');
  const id = randomUUID();
  return selectChatAccount({ ...config, chatAccounts: { ...accounts, list: [...accounts.list, { id, name: accountName(name) }] } }, id);
}

export function renameChatAccount(config: Config, id: string, name: string): Config {
  requireAccount(config, id);
  const accounts = chatAccounts(config);
  return { ...config, chatAccounts: { ...accounts, list: accounts.list.map(row => row.id === id ? { ...row, name: accountName(name) } : row) } };
}

/** Links (or with null, unlinks) the setup profile an account's plugins use. */
export function linkChatAccountSetup(config: Config, id: string, setupProfileId: string | null): Config {
  requireAccount(config, id);
  if (setupProfileId !== null && !knownSetupProfile(config, setupProfileId)) throw new Error('Setup profile not found');
  const accounts = chatAccounts(config);
  return {
    ...config,
    chatAccounts: {
      ...accounts,
      list: accounts.list.map(row => {
        if (row.id !== id) return row;
        const { setupProfileId: _old, ...rest } = row;
        return setupProfileId === null ? rest : { ...rest, setupProfileId };
      })
    }
  };
}

/** Removing the active account selects a surviving one in the same commit. */
export function removeChatAccount(config: Config, id: string): Config {
  requireAccount(config, id);
  const accounts = chatAccounts(config);
  if (accounts.list.length <= 1) throw new Error('Keep at least one ChatGPT account');
  const list = accounts.list.filter(row => row.id !== id);
  const trimmed: Config = { ...config, chatAccounts: { active: accounts.active === id ? list[0]!.id : accounts.active, list } };
  return accounts.active === id ? selectChatAccount(trimmed, list[0]!.id) : trimmed;
}
