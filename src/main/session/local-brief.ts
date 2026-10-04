import type { StoredText } from '../../shared/session.js';
import { transcriptEntries } from '../../shared/markdown-export.js';
import { getSession, readEvents, readOverflowText } from './store.js';

/**
 * A Compact & Resume brief written by the app from the session's own recording, for a chat A
 * that cannot write one: it belongs to another ChatGPT account than the one now signed in, or
 * it is gone. The ordinary brief is the model's own summary from inside chat A
 * (`handoff-prompt.ts`); this is the conversation itself, user and final assistant messages
 * in order. `handoff.ts::prepareHandoff` bounds it, keeping its start and its latest part.
 */
export function localBriefText(title: string, entries: readonly { role: 'user' | 'assistant'; text: string }[]): string {
  const parts = [
    `# Handoff for “${title.trim() || 'this session'}”, assembled from the recorded conversation`,
    'The previous ChatGPT chat could not be asked for a summary, so Chat On Steroids assembled this brief from the messages it recorded locally. Tool calls and their results are not repeated here. Re-read the relevant project files for their current state before continuing, then continue the most recent unfinished request.'
  ];
  for (const entry of entries) {
    const text = entry.text.trim();
    if (text) parts.push(`## ${entry.role === 'user' ? 'User' : 'Assistant'}\n\n${text}`);
  }
  return `${parts.join('\n\n')}\n`;
}

async function fullText(sessionId: string, stored: StoredText): Promise<string> {
  if (!stored.truncated || !stored.assetId) return stored.text;
  return (await readOverflowText(sessionId, stored.assetId)) ?? stored.text;
}

export async function localSessionBrief(sessionId: string): Promise<string> {
  const summary = await getSession(sessionId);
  if (!summary) throw new Error('That session no longer exists');
  const entries = transcriptEntries(await readEvents(sessionId));
  if (!entries.length) throw new Error('This session has no recorded messages to continue from.');
  return localBriefText(summary.title, await Promise.all(entries.map(async entry =>
    ({ role: entry.role, text: await fullText(sessionId, entry.stored) }))));
}
