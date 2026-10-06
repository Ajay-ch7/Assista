// Action log (F11): everything Assista did on a page, kept on the device in
// chrome.storage.local. "What did you do?" reads it back; it is never sent anywhere.

import type { ActionReply, ToolRequest } from '../shared/messages';

export type ActionOutcome = 'done' | 'confirmed' | 'held' | 'declined' | 'private' | 'failed';

export interface ActionEntry {
  at: number;
  tool: string;
  /** The name of the control, field or tab acted on. */
  target?: string;
  /** The text typed, the option chosen, the site opened, or where a scroll ended. */
  detail?: string;
  outcome: ActionOutcome;
}

const KEY = 'actionLog';
export const MAX_ENTRIES = 50;
/** How many actions "what did you do?" reads back. */
export const READ_BACK = 5;

/** Describes what running `tool` led to. `confirmed` marks an action the user said yes to. */
export function entryFor(
  tool: ToolRequest,
  reply: ActionReply,
  at: number,
  confirmed = false,
): ActionEntry {
  if (reply.ok) {
    const { target, detail } = reply.result;
    const entry: ActionEntry = { at, tool: tool.name, outcome: confirmed ? 'confirmed' : 'done' };
    if (target?.name) entry.target = target.name;
    if (detail) entry.detail = detail;
    return entry;
  }
  if (reply.held) return { at, tool: tool.name, target: reply.held.control, outcome: 'held' };
  if (reply.sensitive) {
    return { at, tool: tool.name, target: reply.sensitive.field, outcome: 'private' };
  }
  return { at, tool: tool.name, outcome: 'failed' };
}

// Appends run one after another, so two actions finishing together both get logged.
let writing: Promise<unknown> = Promise.resolve();

export function logAction(entry: ActionEntry): Promise<void> {
  const write = writing.then(async () => {
    const entries = [...(await loadActions()), entry].slice(-MAX_ENTRIES);
    await chrome.storage.local.set({ [KEY]: entries });
  });
  writing = write.catch(() => undefined);
  return write;
}

export async function loadActions(): Promise<ActionEntry[]> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return Array.isArray(stored) ? (stored as ActionEntry[]) : [];
}

const FAILED_VERBS: Record<string, string> = {
  click: 'press that',
  type: 'type that',
  select: 'choose that',
  scroll: 'scroll',
  go_back: 'go back',
  switch_tab: 'switch tabs',
  open_url: 'open that',
};

function sentence(entry: ActionEntry): string {
  const target = entry.target || 'something';
  switch (entry.outcome) {
    case 'held':
      return `I stopped before pressing ${target} and asked you first.`;
    case 'declined':
      return `You said no, so I did not press ${target}.`;
    case 'private':
      return `I moved to ${target} for you to type.`;
    case 'failed':
      return `I tried to ${FAILED_VERBS[entry.tool] ?? 'do something'}, but it did not work.`;
  }
  const after = entry.outcome === 'confirmed' ? ' after you said yes' : '';
  switch (entry.tool) {
    case 'click':
      return `I pressed ${target}${after}.`;
    case 'type':
      return `I typed ${entry.detail ?? 'text'} into ${target}.`;
    case 'select':
      return `I chose ${entry.detail ?? 'an option'} for ${target}.`;
    case 'scroll':
      if (entry.target) return `I scrolled to ${entry.target}.`;
      return entry.detail?.includes(' of the page')
        ? `I scrolled to the ${entry.detail}.`
        : `I scrolled ${entry.detail ?? 'the page'}.`;
    case 'go_back':
      return 'I went back a page.';
    case 'switch_tab':
      return `I switched to the tab ${target}.`;
    case 'open_url':
      return `I opened ${entry.detail ?? 'a page'}.`;
    case 'focus':
      return `I moved to ${target}.`;
    case 'web_search':
      return `I searched the web for ${entry.detail ?? 'something'}.`;
    case 'set_watch':
      return `I started watching ${target}.`;
    case 'cancel_watch':
      return `I stopped watching ${entry.detail ?? 'a page'}.`;
    case 'list_watches':
      return 'I listed what I am watching.';
    default:
      return `I did ${entry.tool}.`;
  }
}

/** The latest actions as sentences, oldest first. */
export function describeActions(entries: ActionEntry[], count = READ_BACK): string {
  if (entries.length === 0) return 'I have not done anything on a page yet.';
  const recent = entries.slice(-count);
  const lead =
    entries.length > recent.length
      ? `Here are my last ${recent.length} actions.`
      : recent.length === 1
        ? 'I did one thing.'
        : `I did ${recent.length} things.`;
  return [lead, ...recent.map(sentence)].join(' ');
}
