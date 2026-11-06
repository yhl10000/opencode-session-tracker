import fs from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { STATE_DIR, setApiRef, setBot } from '../src/core/runtime';
import { activeTails, closeTailsForSession, getSessionActiveContent, startTailTracking } from '../src/telegram/tail';
import { buildMessageWithHeaderAndFooter, buildStatusFromParts, formatAssistantProse } from '../src/telegram/formatters';
import { getPromptStatusPath, savePromptResponse, savePromptStatus } from '../src/core/status';
import { registerCallbackHandler } from '../src/telegram/callbacks';

let messages: any[] = [];
let runStatus = 'running';
let permissionRequests: any[] = [];
let formRequests: any[] = [];
const statusFiles = new Set<string>();

function statusSessionId(prefix: string): string {
  const sessionId = `${prefix}-${randomUUID()}`;
  const statusPath = getPromptStatusPath(sessionId);
  if (path.dirname(statusPath) !== STATE_DIR) throw new Error('Prompt status test path must stay in the sandbox cache');
  statusFiles.add(statusPath);
  return sessionId;
}

const intervalCallbacks = new Map<number, () => any>();
const timeoutCallbacks = new Map<number, () => any>();
const clearedIntervals = new Set<number>();
let timerId = 0;
let restoreTimers: (() => void) | null = null;

function installFakeTimers() {
  const native = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  intervalCallbacks.clear();
  timeoutCallbacks.clear();
  clearedIntervals.clear();
  globalThis.setInterval = ((callback: () => any) => {
    const id = ++timerId;
    intervalCallbacks.set(id, callback);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { clearedIntervals.add(id); }) as typeof clearInterval;
  globalThis.setTimeout = ((callback: () => any) => {
    const id = ++timerId;
    timeoutCallbacks.set(id, callback);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timeoutCallbacks.delete(id); }) as typeof clearTimeout;
  restoreTimers = () => {
    globalThis.setInterval = native.setInterval;
    globalThis.clearInterval = native.clearInterval;
    globalThis.setTimeout = native.setTimeout;
    globalThis.clearTimeout = native.clearTimeout;
    restoreTimers = null;
  };
}

async function pollTail(id: number) {
  await intervalCallbacks.get(id)?.();
  for (const [timeoutId, callback] of [...timeoutCallbacks]) {
    timeoutCallbacks.delete(timeoutId);
    callback();
  }
  await Promise.resolve();
}

function setMessages(next: any[]) {
  messages = next;
  setApiRef({
    client: {
      message: { list: async () => ({ data: messages }) },
      session: { get: async () => ({ id: 's', title: '<tail>' }), list: async () => [] },
    },
    data: {
      session: {
        status: () => runStatus,
        permission: { list: () => permissionRequests },
        form: { list: () => formRequests },
      },
    },
  });
}

describe('Telegram tail prose', () => {
  beforeEach(() => {
    messages = [];
    runStatus = 'running';
    permissionRequests = [];
    formRequests = [];
    setMessages([]);
  });

  afterEach(() => {
    for (const sessionId of new Set([...activeTails.values()].map(tail => tail.sessionId))) closeTailsForSession(sessionId);
    setBot(null);
    restoreTimers?.();
    for (const statusPath of statusFiles) fs.rmSync(statusPath, { force: true });
    statusFiles.clear();
  });

  test('keeps assistant prose when a later tool event has no text', async () => {
    const sessionId = statusSessionId('tail-test-prose');
    savePromptStatus(sessionId, 'I found the cause and am fixing it.', 'prose');
    savePromptStatus(sessionId, '⚙️ edit_file...', 'activity');
    setMessages([
      { id: 'u1', type: 'user', text: 'Please fix it', time: { created: 1000 } },
      { id: 'a1', type: 'assistant', time: { created: 1100 }, content: [
        { type: 'tool', tool: 'edit_file', state: { status: 'running', input: { path: 'private/path.ts' } } },
      ] },
    ]);

    const result = await getSessionActiveContent(sessionId, '');

    expect(result.activeText).toContain('I found the cause');
    expect(result.activeText).not.toContain('private/path.ts');
    expect(result.activityText).toContain('Working');
  });

  test('keeps prose through activity updates, saves final answers, and clears prose on reset', async () => {
    const sessionId = statusSessionId('tail-test-status-file');
    savePromptStatus(sessionId, 'Streaming commentary.', 'prose');
    savePromptStatus(sessionId, 'Tool running', 'activity');
    let data = JSON.parse(fs.readFileSync(getPromptStatusPath(sessionId), 'utf8'));
    expect(data.prose).toBe('Streaming commentary.');

    savePromptResponse(sessionId, 'The final response.');
    savePromptStatus(sessionId, 'Completed activity', 'activity');
    data = JSON.parse(fs.readFileSync(getPromptStatusPath(sessionId), 'utf8'));
    expect(data.prose).toBe('The final response.');
    expect(data.isComplete).toBe(false);

    savePromptStatus(sessionId, '⏳ Processing...', 'reset');
    data = JSON.parse(fs.readFileSync(getPromptStatusPath(sessionId), 'utf8'));
    expect(data.prose).toBe('');
    expect(data.proseTimestamp).toBe(0);
    expect(data.text).toBeUndefined();

    setMessages([{ id: 'u1', type: 'user', text: 'New turn', time: { created: 1000 } }]);
    expect((await getSessionActiveContent(sessionId, '')).activeText).toBe('');
  });

  test('prefers newer durable assistant prose over an older live commentary', async () => {
    const sessionId = statusSessionId('tail-test-api-final');
    savePromptStatus(sessionId, 'I am still working.', 'prose');
    setMessages([
      { id: 'u1', type: 'user', text: 'Finish', time: { created: Date.now() - 5000 } },
      { id: 'a1', type: 'assistant', time: { created: Date.now() - 4000, completed: Date.now() + 1000 }, content: [{ type: 'text', text: 'The final API answer.' }] },
    ]);

    const result = await getSessionActiveContent(sessionId, '');

    expect(result.activeText).toContain('The final API answer.');
    expect(result.activeText).not.toContain('still working');
  });

  test('never displays reasoning, command inputs, or tool outputs as assistant prose', () => {
    const rendered = buildStatusFromParts([
      { type: 'reasoning', text: 'secret chain of thought' },
      { type: 'tool', tool: 'bash', state: { input: { command: 'cat /private/key' }, status: 'running' } },
      { type: 'tool_result', content: 'raw tool output' },
      { type: 'text', text: 'Here is the useful result.' },
    ]);

    expect(rendered).toContain('Here is the useful result.');
    expect(rendered).not.toMatch(/secret chain|cat \/private\/key|raw tool output|bash/);
  });

  test('looks back past tool-only assistant messages for the latest useful prose', async () => {
    setMessages([
      { id: 'u1', type: 'user', text: 'Do the work', time: { created: 1000 } },
      { id: 'a1', type: 'assistant', time: { created: 1100 }, content: [{ type: 'text', text: 'Still working on the fix.' }] },
      { id: 'a2', type: 'assistant', time: { created: 1200 }, content: [{ type: 'tool', tool: 'read_file', state: { status: 'complete' } }] },
      { id: 'a3', type: 'assistant', time: { created: 1300 }, content: [{ type: 'reasoning', text: 'internal only' }] },
    ]);

    const result = await getSessionActiveContent('tail-test-lookback', '');

    expect(result.activeText).toContain('Still working on the fix.');
    expect(result.activeText).not.toContain('internal only');
  });

  test('does not replay the previous turn before the new turn has prose', async () => {
    setMessages([
      { id: 'old-user', type: 'user', text: 'Old request', time: { created: 1000 } },
      { id: 'old-answer', type: 'assistant', time: { created: 1100 }, content: [{ type: 'text', text: 'Old answer must stay hidden.' }] },
      { id: 'new-user', type: 'user', text: 'New request', time: { created: 2000 } },
      { id: 'new-assistant', type: 'assistant', time: { created: 2100 }, content: [{ type: 'tool', tool: 'bash', state: { status: 'running' } }] },
    ]);

    const result = await getSessionActiveContent('tail-test-new-turn', '');

    expect(result.activeText).toBe('');
    expect(result.activityText).toContain('Working');
  });

  test('labels pending answer and permission waits separately', async () => {
    formRequests = [{ id: 'question' }];
    setMessages([{ id: 'u1', type: 'user', text: 'Choose', time: { created: 1000 } }]);
    expect((await getSessionActiveContent('tail-test-answer-wait', '')).activityText).toContain('Waiting for your answer');

    formRequests = [];
    permissionRequests = [{ id: 'permission' }];
    setMessages([{ id: 'u1', type: 'user', text: 'Run it', time: { created: 1000 } }]);
    expect((await getSessionActiveContent('tail-test-permission-wait', '')).activityText).toContain('Waiting for permission');
  });

  test('retains the final assistant answer when the session is idle', async () => {
    runStatus = 'idle';
    setMessages([
      { id: 'u1', type: 'user', text: 'Summarize', time: { created: 1000 } },
      { id: 'a1', type: 'assistant', time: { created: 1100 }, content: [{ type: 'text', text: 'The final answer is ready.' }] },
    ]);

    const result = await getSessionActiveContent('tail-test-final', '');

    expect(result.activeText).toContain('The final answer is ready.');
    expect(result.activityText).toContain('Completed');
  });

  test('truncates before HTML escaping and keeps output within the Telegram budget', () => {
    const source = `${'😀<&>'.repeat(1600)}\n\nFinal paragraph <done>`;
    const rendered = formatAssistantProse(source, 900);

    expect(rendered.length).toBeLessThanOrEqual(900);
    expect(rendered).toContain('Final paragraph');
    expect(rendered).toContain('&lt;done&gt;');
    expect(rendered.startsWith('…')).toBe(true);
    expect(rendered).not.toMatch(/<(?!\/?(?:b|i|code|pre)\b)[^>]*$/);
  });

  test('keeps the complete Telegram message bounded without squeezing the final prose', async () => {
    setApiRef({ client: { session: { get: async () => ({ id: 's', title: '<title>'.repeat(100) }) } } });
    const history = formatAssistantProse('😀<&>'.repeat(800), 350);
    const body = `${history}\n\n${formatAssistantProse(`${'😀<&>'.repeat(800)}\n\nThe final answer remains visible.`)}\n\n⏳ Working`;
    const rendered = await buildMessageWithHeaderAndFooter('tail-test-limit', body, {
      agent: '<agent>'.repeat(100), model: { modelID: '<model>'.repeat(100) },
    }, Date.now());

    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(rendered).toContain('The final answer remains visible.');
    expect(rendered).toContain('&lt;title&gt;');
  });

  test('poll renders only the newest user prompt and keeps one tail; stop and idle completion clean up', async () => {
    installFakeTimers();
    let runState = 'running';
    setApiRef({
      client: {
        message: { list: async () => ({ data: [
          { id: 'old-user', type: 'user', text: 'Old request' },
          { id: 'old-answer', type: 'assistant', content: [{ type: 'text', text: 'OLD TURN MUST NOT APPEAR' }] },
          { id: 'new-user', type: 'user', text: 'Latest <query> & details' },
          { id: 'new-assistant', type: 'assistant', content: [
            { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'secret command' } } },
            { type: 'tool_result', content: 'secret output' },
          ] },
        ] }) },
        session: { get: async () => ({ id: 's', title: '<session>' }), list: async () => [] },
      },
      data: { session: { status: () => runState, permission: { list: () => [] }, form: { list: () => [] } } },
    });

    const edits: any[] = [];
    const markups: any[] = [];
    const callbackHandlers: Record<string, (query: any) => Promise<void>> = {};
    const fakeBot: any = {
      on: (event: string, handler: (query: any) => Promise<void>) => { callbackHandlers[event] = handler; },
      editMessageText: (text: string, options: any) => { edits.push({ text, options }); return Promise.resolve({}); },
      editMessageReplyMarkup: (markup: any, options: any) => { markups.push({ markup, options }); return Promise.resolve({}); },
      answerCallbackQuery: () => Promise.resolve(),
    };
    setBot(fakeBot);

    startTailTracking('tail-test-render', 7, 101, '');
    const first = activeTails.get(101)!;
    const firstInterval = first.timer as number;
    await pollTail(firstInterval);
    const rendered = edits.at(-1).text;
    expect(rendered).toContain('Latest &lt;query&gt; &amp; details');
    expect(rendered).not.toMatch(/OLD TURN|Old request|secret command|secret output/);
    expect(rendered.length).toBeLessThanOrEqual(4000);

    startTailTracking('tail-test-render', 7, 102, '');
    expect(first.isComplete).toBe(true);
    expect(clearedIntervals.has(firstInterval)).toBe(true);
    expect(activeTails.size).toBe(1);
    const secondInterval = activeTails.get(102)!.timer as number;
    registerCallbackHandler(fakeBot, () => true);
    await callbackHandlers.callback_query({
      id: 'stop', data: 'stop_tracking_102', from: { id: 1 },
      message: { message_id: 102, chat: { id: 7 } },
    });
    expect(activeTails.size).toBe(0);
    expect(clearedIntervals.has(secondInterval)).toBe(true);
    expect(edits.at(-1).options.reply_markup.inline_keyboard).toEqual([]);
    expect(markups.some(item => item.options.message_id === 101)).toBe(true);

    runState = 'idle';
    startTailTracking('tail-test-completion', 7, 103, '');
    const finalTail = activeTails.get(103)!;
    finalTail.startedAt = Date.now() - 16000;
    setApiRef({
      client: {
        message: { list: async () => ({ data: [
          { id: 'u', type: 'user', text: 'Final request' },
          { id: 'a', type: 'assistant', content: [{ type: 'text', text: 'Final answer stays visible.' }] },
        ] }) },
        session: { get: async () => ({ id: 's', title: 'Done' }), list: async () => [] },
      },
      data: { session: { status: () => runState, permission: { list: () => [] }, form: { list: () => [] } } },
    });
    await pollTail(finalTail.timer as number);
    expect(finalTail.isComplete).toBe(true);
    expect(activeTails.has(103)).toBe(false);
    expect(edits.at(-1).text).toContain('Final answer stays visible.');
    expect(edits.at(-1).text).toContain('Completed');
    expect(edits.at(-1).options.reply_markup.inline_keyboard).toEqual([]);
  });

  test('poll does not preserve old assistant prose when the newest user turn has attachments only', async () => {
    installFakeTimers();
    setMessages([
      { id: 'old-user', type: 'user', text: 'Old request' },
      { id: 'old-answer', type: 'assistant', content: [{ type: 'text', text: 'OLD TURN MUST STAY HIDDEN' }] },
      { id: 'new-user', type: 'user', text: '', parts: [{ type: 'file', path: 'private/attachment.txt' }] },
      { id: 'new-assistant', type: 'assistant', content: [{ type: 'tool', tool: 'read_file', state: { status: 'running' } }] },
    ]);
    const edits: any[] = [];
    setBot({
      editMessageText: (text: string, options: any) => { edits.push({ text, options }); return Promise.resolve({}); },
      editMessageReplyMarkup: () => Promise.resolve({}),
    } as any);

    startTailTracking('tail-test-empty-prompt', 7, 104, '');
    const tail = activeTails.get(104)!;
    await pollTail(tail.timer as number);

    expect(edits.at(-1).text).not.toContain('OLD TURN MUST STAY HIDDEN');
    expect(edits.at(-1).text).not.toContain('Old request');
    expect(edits.at(-1).text).not.toContain('private/attachment.txt');
    expect(edits.at(-1).text).toContain('Working');
  });
});
