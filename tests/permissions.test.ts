import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createPermissionReminders } from '../src/telegram/permissions';

const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, description: string) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await wait(5);
  }
}
const request = (id = 'p1', sessionID = 's1') => ({ id, sessionID, action: 'bash', resources: ['<file>&'], message: 'run <cmd>&' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function memory<V>() {
  const data = new Map<string, V>();
  return { get: (id: string) => data.get(id), set: (id: string, value: V) => { data.set(id, value); },
    delete: (id: string) => data.delete(id), entries: () => [...data.entries()] };
}
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); });
function captureErrors() {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  disposals.push(() => errors.mockRestore());
  return errors;
}
const telegramError = (error_code: number, description: string) => Object.assign(new Error(description), {
  response: { body: { error_code, description } },
});

const indexSource = (await Bun.file(new URL('../src/index.tsx', import.meta.url)).text())
  .replace(/^\/\*\* @jsxImportSource[^\n]*\r?\n/, '')
  .replace(/^import[\s\S]*?;\r?$/gm, '')
  .replace('export default Plugin.define(', 'const plugin = Plugin.define(');
const indexCode = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react' } } })
  .transformSync(indexSource);

function indexHarness(pending: Record<string, any[]> = {}) {
  const handlers = new Map<string, (event: any) => void>();
  const statuses: any[][] = [];
  const responses: any[][] = [];
  const permissions = harness().lifecycle;
  const bindings = {
    Plugin: { define: (plugin: any) => plugin }, initTelegram() {}, logDebug() {},
    startPermissionReminders: () => permissions,
    computeStatus: (_id: string, type: string) => type || 'idle',
    getStatusSignal: () => [undefined, () => {}], saveSessionStatus() {},
    savePromptStatus: (...args: any[]) => statuses.push(args),
    savePromptResponse: (...args: any[]) => responses.push(args),
    localSessionTitle: () => 'Test', reconcileStaleStatuses: async () => {},
    leaderInterval: null, setLeaderInterval() {},
  };
  const plugin = new Function(...Object.keys(bindings), `${indexCode}\nreturn plugin;`)(...Object.values(bindings));
  const dispose = plugin.setup({
    data: {
      on: (name: string, handler: (event: any) => void) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
      session: {
        list: () => Object.keys(pending).map(id => ({ id })),
        pending: { list: (id: string) => pending[id] || [] },
      },
    },
    ui: { slot() {} },
  });
  disposals.push(dispose);
  return { statuses, responses, handlers, dispose,
    emit: (name: string, data: any) => handlers.get(name)?.({ type: name, data }) };
}

function harness(timeoutMs = 15, graceMs = 10) {
  let pending = [request()];
  let read: (sessionID: string) => Promise<any> = async sessionID => pending.filter(p => p.sessionID === sessionID);
  let leader = true;
  const sent: any[] = [];
  const edits: any[] = [];
  const requests = memory<any>();
  const notices = memory<any>();
  let send: (chat: number, text: string, opts: any) => Promise<any> = async (chat, text, opts) => {
    sent.push({ chat, text, opts });
    return { message_id: 7 };
  };
  const bot = {
    sendMessage: (chat: number, text: string, opts: any) => send(chat, text, opts),
    editMessageText: async (text: string, opts: any) => { edits.push({ text, opts }); },
  };
  const ctx = { client: { permission: { list: (input: any, opts: any) => {
    expect(Object.keys(input)).toEqual(['sessionID']);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    return read(input.sessionID);
  } } } };
  const env = {
    requests, notices, delivery: () => ({ leader, bot: bot as any, users: [11, 22] }),
    title: () => '<title>&', graceMs, retryMs: 25, timeoutMs,
  };
  const lifecycle = createPermissionReminders(ctx as any, env);
  disposals.push(lifecycle.dispose);
  return { lifecycle, sent, edits, requests, notices, bot,
    restart: () => {
      lifecycle.dispose();
      const restarted = createPermissionReminders(ctx as any, env);
      disposals.push(restarted.dispose);
      return restarted;
    },
    pending: (value: any[]) => { pending = value; }, read: (fn: typeof read) => { read = fn; },
    leader: (value: boolean) => { leader = value; }, send: (fn: typeof send) => { send = fn; } };
}

describe('permission reminders', () => {
  test('fast replies and authoritative empty lists send nothing', async () => {
    const h = harness();
    h.lifecycle.asked(request());
    h.lifecycle.replied('s1', 'p1');
    await wait();
    expect(h.sent).toHaveLength(0);
    h.lifecycle.asked(request('p2'));
    h.pending([]);
    await wait();
    expect(h.sent).toHaveLength(0);
    expect(h.requests.entries()).toHaveLength(0);
  });

  test('groups genuine pending requests per recipient and escapes HTML with short callback data', async () => {
    const h = harness();
    h.pending([request(), request('p2')]);
    h.lifecycle.asked(request());
    h.lifecycle.asked(request());
    h.lifecycle.asked(request('p2'));
    await wait();
    expect(h.sent).toHaveLength(2);
    for (const msg of h.sent) {
      expect(msg.text).toContain('&lt;title&gt;&amp;');
      expect(msg.text).toContain('run &lt;cmd&gt;&amp;');
      expect(msg.opts.reply_markup.inline_keyboard).toHaveLength(2);
      for (const row of msg.opts.reply_markup.inline_keyboard) for (const button of row) {
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      }
    }
    await wait(60);
    expect(h.sent).toHaveLength(2);
    expect(h.edits).toHaveLength(0);
  });

  test('authoritative resolution without replied removes buttons for both chats with colliding message IDs', async () => {
    const h = harness();
    h.lifecycle.asked(request());
    await wait();
    h.pending([]);
    await wait(45);
    expect(h.edits).toHaveLength(2);
    expect(h.edits.map(e => e.opts.chat_id).sort()).toEqual([11, 22]);
    expect(h.edits.every(e => e.opts.message_id === 7 && e.opts.reply_markup.inline_keyboard.length === 0)).toBe(true);
  });

  test('errors and timeouts warn once per recipient, retry and do not silently discard requests', async () => {
    const h = harness();
    h.read(async () => { throw new Error('offline'); });
    h.lifecycle.asked(request());
    await wait(65);
    expect(h.sent).toHaveLength(2);
    expect(h.sent.every(m => m.opts.reply_markup.inline_keyboard.length === 0)).toBe(true);
    expect(h.requests.entries()).toHaveLength(1);
    h.read(() => new Promise(() => {}));
    await wait(65);
    expect(h.sent).toHaveLength(2);
    h.read(async () => [request()]);
    await wait(70);
    expect(h.sent).toHaveLength(2);
    expect(h.edits).toHaveLength(2);
    expect(h.edits.every(m => m.opts.message_id === 7 && m.opts.reply_markup.inline_keyboard.length === 1)).toBe(true);
  });

  test('unknown response is not an authoritative empty result', async () => {
    const h = harness();
    h.read(async () => undefined);
    h.lifecycle.asked(request());
    await wait();
    expect(h.requests.entries()).toHaveLength(1);
    expect(h.sent[0].text).toContain('Unable to verify');
  });

  test('reply racing an in-flight send clears the just-created buttons', async () => {
    const h = harness();
    const sending = deferred<any>();
    h.send(async (chat, text, opts) => { h.sent.push({ chat, text, opts }); return sending.promise; });
    h.lifecycle.asked(request());
    await wait();
    h.lifecycle.replied('s1', 'p1');
    sending.resolve({ message_id: 7 });
    await wait();
    expect(h.edits.length).toBeGreaterThan(0);
    expect(h.edits.every(e => e.opts.reply_markup.inline_keyboard.length === 0)).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  test('keeps unsent requests when not leader and delivers after election', async () => {
    const h = harness();
    h.leader(false);
    h.lifecycle.asked(request());
    await wait(40);
    expect(h.sent).toHaveLength(0);
    h.leader(true);
    await wait(60);
    expect(h.sent).toHaveLength(2);
  });

  test('dispose cancels checks and clears buttons from an in-flight send', async () => {
    const h = harness();
    const sending = deferred<any>();
    h.send(async (chat, text, opts) => { h.sent.push({ chat, text, opts }); return sending.promise; });
    h.lifecycle.asked(request());
    await wait();
    h.lifecycle.dispose();
    sending.resolve({ message_id: 7 });
    await wait(60);
    expect(h.sent).toHaveLength(1);
    expect(h.edits[0].opts.reply_markup.inline_keyboard).toEqual([]);
  });

  test('an old list response cannot discard a request arriving while the read was in flight', async () => {
    const h = harness(100);
    const reading = deferred<any>();
    h.read(() => reading.promise);
    h.lifecycle.asked(request());
    await wait();
    h.lifecycle.asked(request('p2'));
    h.read(async () => [request('p2')]);
    reading.resolve([]);
    await wait();
    expect(h.requests.entries().some(([, r]) => r.permId === 'p2')).toBe(true);
  });

  test('failure for one recipient does not block delivery to another', async () => {
    const h = harness();
    const originalError = console.error;
    const errors: any[][] = [];
    console.error = (...args) => { errors.push(args); };
    try {
      h.send(async (chat, text, opts) => {
        if (chat === 11) throw new Error('recipient blocked bot');
        h.sent.push({ chat, text, opts });
        return { message_id: 7 };
      });
      h.lifecycle.asked(request());
      await waitFor(() => h.sent.some(m => m.chat === 22), 'delivery to the other recipient');
      expect(errors.some(([message, error]) => message === '[session-tracker] permission notification failed:'
        && error instanceof Error && error.message === 'recipient blocked bot')).toBe(true);
    } finally {
      h.lifecycle.dispose();
      console.error = originalError;
    }
  });

  test('large descriptions stay within the Telegram text limit', async () => {
    const h = harness();
    const burst = Array.from({ length: 20 }, (_, i) => ({ ...request(`p${i}`), message: '<'.repeat(1000) }));
    h.pending(burst);
    for (const p of burst) h.lifecycle.asked(p);
    await wait();
    expect(h.sent[0].text.length).toBeLessThanOrEqual(4096);
    expect(h.sent[0].opts.reply_markup.inline_keyboard).toHaveLength(20);
  });

  test('reload recovers durable pending requests and message IDs without duplicate delivery', async () => {
    const h = harness();
    h.lifecycle.asked(request());
    await wait();
    h.restart();
    await wait();
    expect(h.sent).toHaveLength(2);
    h.pending([]);
    await wait(60);
    expect(h.edits).toHaveLength(2);
    expect(h.requests.entries()).toHaveLength(0);
  });

  test('serializes edits when both permissions resolve while an edit is in flight', async () => {
    const h = harness();
    h.pending([request(), request('p2')]);
    h.lifecycle.asked(request());
    h.lifecycle.asked(request('p2'));
    await wait();
    const editing = deferred<void>();
    let first = true;
    h.bot.editMessageText = async (text, opts) => {
      if (first) { first = false; await editing.promise; }
      h.edits.push({ text, opts });
    };
    h.lifecycle.replied('s1', 'p1');
    await wait();
    h.lifecycle.replied('s1', 'p2');
    editing.resolve();
    await wait(60);
    for (const chat of [11, 22]) {
      const final = h.edits.filter(e => e.opts.chat_id === chat).at(-1);
      expect(final.opts.reply_markup.inline_keyboard).toEqual([]);
    }
  });

  test('session-scoped request IDs do not collide', async () => {
    const h = harness();
    h.pending([request(), request('p1', 's2')]);
    h.lifecycle.asked(request());
    h.lifecycle.asked(request('p1', 's2'));
    await wait();
    expect(h.sent).toHaveLength(4);
    h.lifecycle.replied('s1', 'p1');
    await wait();
    expect(h.requests.entries().map(([, r]) => r.sessionId)).toEqual(['s2']);
    expect(h.edits).toHaveLength(2);
  });

  test('dispose before the grace period prevents reads and sends', async () => {
    const h = harness();
    let reads = 0;
    h.read(async () => { reads++; return [request()]; });
    h.lifecycle.asked(request());
    h.lifecycle.dispose();
    await wait(60);
    expect(reads).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  test('an existing scheduled tick cannot skip a newly asked request grace period', async () => {
    const h = harness(100, 70);
    await wait(45);
    h.lifecycle.asked(request());
    await wait(40);
    expect(h.sent).toHaveLength(0);
    await wait(65);
    expect(h.sent).toHaveLength(2);
  });

  test('bounds a large burst and reveals every queued permission through the same messages', async () => {
    const h = harness();
    let remaining = Array.from({ length: 125 }, (_, i) => ({ ...request(`p${i}`), message: '<'.repeat(1000) }));
    h.pending(remaining);
    for (const p of remaining) h.lifecycle.asked(p);
    const current = (chat: number) => h.edits.filter(e => e.opts.chat_id === chat).at(-1)
      || h.sent.find(m => m.chat === chat);
    const settled = () => [11, 22].every(chat => {
      const message = current(chat);
      if (!message) return false;
      const rows = message.opts.reply_markup.inline_keyboard;
      if (!remaining.length) return !rows.length && message.text.includes('Permissions resolved');
      const more = remaining.length - Math.min(20, remaining.length);
      return rows.length === Math.min(20, remaining.length)
        && (more ? message.text.includes(`${more} more pending`) : !message.text.includes('more pending'))
        && rows.every((row: any[]) => {
          const permission = h.requests.get(row[0].callback_data.replace('perm_allow_', ''));
          return permission && remaining.some(p => p.id === permission.permId);
        });
    });
    await waitFor(settled, 'the complete burst in both current grouped messages');
    expect(h.requests.entries()).toHaveLength(125);
    expect(h.sent).toHaveLength(2);
    expect(current(11).text).toContain('105 more pending');
    const shown = new Set<string>();
    while (remaining.length) {
      await waitFor(settled, 'the next actionable page for both recipients');
      const message = current(11);
      expect(message.text.length).toBeLessThanOrEqual(4096);
      const rows = message.opts.reply_markup.inline_keyboard;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(20);
      const page = rows.map((row: any[]) => {
        const shortID = row[0].callback_data.replace('perm_allow_', '');
        expect(row[1].callback_data).toBe(`perm_deny_${shortID}`);
        const id = h.requests.get(shortID).permId as string;
        expect(shown.has(id)).toBe(false);
        return id;
      });
      page.forEach((id: string) => shown.add(id));
      remaining = remaining.filter(p => !page.includes(p.id));
      h.pending(remaining);
      page.forEach((id: string) => h.lifecycle.replied('s1', id));
    }
    await waitFor(settled, 'resolved messages for both recipients');
    expect(shown.size).toBe(125);
    expect(h.requests.entries()).toHaveLength(0);
    expect(h.sent).toHaveLength(2);
    expect(h.edits.every(e => e.text.length <= 4096 && e.opts.reply_markup.inline_keyboard.length <= 20)).toBe(true);
    expect(h.edits.at(-1).opts.reply_markup.inline_keyboard).toEqual([]);
  });

  test('tracks uncertainty messages and edits them to resolved when authority recovers empty', async () => {
    const h = harness();
    h.read(async () => { throw new Error('offline'); });
    h.lifecycle.asked(request());
    await wait();
    expect(h.sent).toHaveLength(2);
    expect(h.notices.get('s1').messages[11].id).toBe(7);
    expect(h.notices.get('s1').messages[22].id).toBe(7);
    h.read(async () => []);
    await wait(60);
    expect(h.sent).toHaveLength(2);
    expect(h.edits).toHaveLength(2);
    expect(h.edits.every(e => e.text.includes('Permissions resolved') && e.opts.message_id === 7)).toBe(true);
  });

  test.each(['message to edit not found', "message can't be edited"])(
    'replaces only the inaccessible recipient notice on a new permission: %s', async description => {
      const h = harness();
      const errors = captureErrors();
      h.lifecycle.asked(request());
      await waitFor(() => h.sent.length === 2, 'initial notices');
      h.bot.editMessageText = async (text, opts) => {
        if (opts.chat_id === 11 && opts.message_id === 7) throw telegramError(400, description);
        h.edits.push({ text, opts });
      };
      h.send(async (chat, text, opts) => { h.sent.push({ chat, text, opts }); return { message_id: 8 }; });
      h.pending([request(), request('p2')]);
      h.lifecycle.asked(request('p2'));
      await waitFor(() => h.notices.get('s1')?.messages[11]?.id === 8, 'replacement notice');
      expect(h.sent).toHaveLength(3);
      expect(h.sent.filter(m => m.chat === 22)).toHaveLength(1);
      expect(h.sent.at(-1).opts.reply_markup.inline_keyboard).toHaveLength(2);
      expect(h.notices.get('s1').messages[22].id).toBe(7);
      expect(h.edits.some(e => e.opts.chat_id === 22 && e.opts.reply_markup.inline_keyboard.length === 2)).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  test('explicit refresh discovers a deleted notice even when content has not changed', async () => {
    const h = harness();
    const errors = captureErrors();
    h.lifecycle.asked(request());
    await waitFor(() => h.sent.length === 2, 'initial notices');
    h.bot.editMessageText = async (text, opts) => {
      if (opts.chat_id === 11 && opts.message_id === 7) throw telegramError(400, 'message to edit not found');
      h.edits.push({ text, opts });
    };
    h.send(async (chat, text, opts) => { h.sent.push({ chat, text, opts }); return { message_id: 8 }; });
    h.lifecycle.refresh('s1');
    await waitFor(() => h.notices.get('s1')?.messages[11]?.id === 8, 'same-content replacement');
    expect(h.sent).toHaveLength(3);
    expect(h.sent.at(-1).opts.reply_markup.inline_keyboard).toHaveLength(1);
    expect(h.sent.filter(m => m.chat === 22)).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  test.each([
    new Error('network reset'),
    telegramError(429, 'Too Many Requests: retry after 1'),
    telegramError(500, 'Internal Server Error'),
  ])('transient edit failure retains the old ID and retries without duplicate sends: %s', async failure => {
    const h = harness();
    const errors = captureErrors();
    h.lifecycle.asked(request());
    await waitFor(() => h.sent.length === 2, 'initial notices');
    h.bot.editMessageText = async (text, opts) => {
      if (opts.chat_id === 11) throw failure;
      h.edits.push({ text, opts });
    };
    h.pending([request(), request('p2')]);
    h.lifecycle.asked(request('p2'));
    await waitFor(() => errors.mock.calls.length > 0 && h.edits.some(e => e.opts.chat_id === 22), 'logged edit failure');
    expect(errors.mock.calls.some(([message, error]) => message === '[session-tracker] permission notification failed:'
      && error === failure)).toBe(true);
    expect(h.notices.get('s1').messages[11].id).toBe(7);
    expect(h.sent).toHaveLength(2);
    h.bot.editMessageText = async (text, opts) => { h.edits.push({ text, opts }); };
    await waitFor(() => h.edits.some(e => e.opts.chat_id === 11 && e.opts.reply_markup.inline_keyboard.length === 2), 'edit retry');
    expect(h.sent).toHaveLength(2);
    expect(h.notices.get('s1').messages[11].id).toBe(7);
  });

  test('does not send an all-resolved replacement for a deleted notice', async () => {
    const h = harness();
    const errors = captureErrors();
    h.lifecycle.asked(request());
    await waitFor(() => h.sent.length === 2, 'initial notices');
    h.bot.editMessageText = async (text, opts) => {
      if (opts.chat_id === 11) throw telegramError(400, 'message to edit not found');
      h.edits.push({ text, opts });
    };
    h.pending([]);
    h.lifecycle.replied('s1', 'p1');
    await waitFor(() => Object.keys(h.notices.get('s1')?.messages || {}).length === 0, 'resolved notice cleanup');
    expect(h.sent).toHaveLength(2);
    expect(h.edits.some(e => e.opts.chat_id === 22 && e.opts.reply_markup.inline_keyboard.length === 0)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  test('replaces a deleted notice with tracked uncertainty and recovers that same replacement', async () => {
    const h = harness();
    const errors = captureErrors();
    h.lifecycle.asked(request());
    await waitFor(() => h.sent.length === 2, 'initial notices');
    h.bot.editMessageText = async (text, opts) => {
      if (opts.chat_id === 11 && opts.message_id === 7) throw telegramError(400, 'message to edit not found');
      h.edits.push({ text, opts });
    };
    h.send(async (chat, text, opts) => { h.sent.push({ chat, text, opts }); return { message_id: 8 }; });
    h.read(async () => { throw new Error('offline'); });
    await waitFor(() => h.notices.get('s1')?.messages[11]?.id === 8, 'uncertainty replacement');
    expect(h.sent).toHaveLength(3);
    expect(h.sent.at(-1).text).toContain('Unable to verify');
    expect(h.sent.at(-1).opts.reply_markup.inline_keyboard).toEqual([]);
    h.read(async () => [request()]);
    await waitFor(() => h.edits.some(e => e.opts.chat_id === 11 && e.opts.message_id === 8
      && e.opts.reply_markup.inline_keyboard.length === 1), 'replacement recovery');
    expect(h.sent).toHaveLength(3);
    expect(errors).not.toHaveBeenCalled();
  });

  test('message is not modified is successful refresh, not deletion or a retry loop', async () => {
    const h = harness();
    const errors = captureErrors();
    h.lifecycle.asked(request());
    await waitFor(() => h.sent.length === 2, 'initial notices');
    h.bot.editMessageText = async (text, opts) => {
      h.edits.push({ text, opts });
      throw telegramError(400, 'Bad Request: message is not modified');
    };
    h.lifecycle.refresh('s1');
    await waitFor(() => h.edits.length === 2, 'forced refresh attempts');
    await wait(60);
    expect(h.edits).toHaveLength(2);
    expect(h.sent).toHaveLength(2);
    expect(h.notices.get('s1').messages[11].signature).not.toBe('');
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('index event integration', () => {
  test('resets only on delivered user turns, forwards full prose and never overwrites response with Done', () => {
    const h = indexHarness();
    const user = { sessionID: 's1', inboxID: 'u1', item: { type: 'user', payload: { text: 'next' }, delivery: 'queue' } };
    h.emit('session.inbox.enqueued', user);
    expect(h.statuses).toHaveLength(0);
    h.emit('session.inbox.enqueued', { ...user, inboxID: 'synthetic', item: { type: 'synthetic' } });
    h.emit('session.inbox.delivered', { sessionID: 's1', inboxID: 'synthetic' });
    expect(h.statuses).toHaveLength(0);
    h.emit('session.inbox.delivered', { sessionID: 's1', inboxID: 'u1' });
    h.emit('session.inbox.delivered', { sessionID: 's1', inboxID: 'u1' });
    expect(h.statuses).toEqual([['s1', '⏳ Processing...', 'reset']]);
    h.emit('session.step.started', { sessionID: 's1' });
    h.emit('session.reasoning.started', { sessionID: 's1' });
    h.emit('session.text.started', { sessionID: 's1' });
    const first = 'a'.repeat(800);
    const second = 'b'.repeat(800);
    h.emit('session.text.delta', { sessionID: 's1', delta: first });
    h.emit('session.text.delta', { sessionID: 's1', delta: second });
    expect(h.statuses.at(-1)).toEqual(['s1', first + second, 'prose']);
    expect(h.statuses.filter(call => call[2] === 'reset')).toHaveLength(1);
    h.emit('session.text.ended', { sessionID: 's1' });
    expect(h.responses[0].slice(0, 2)).toEqual(['s1', first + second]);
    expect(h.statuses.at(-1)).toEqual(['s1', first + second, 'prose']);
    h.dispose();
    expect(h.handlers.size).toBe(0);
  });

  test('hydrates queued user turns on reload, isolates session IDs and ignores cancelled inbox items', () => {
    const h = indexHarness({
      s1: [{ id: 'same', sessionID: 's1', type: 'user' }],
      s2: [{ id: 'same', sessionID: 's2', type: 'user' }, { id: 'other', sessionID: 's2', type: 'compaction' }],
    });
    h.emit('session.inbox.delivered', { sessionID: 's1', inboxID: 'same' });
    h.emit('session.inbox.delivered', { sessionID: 's2', inboxID: 'other' });
    h.emit('session.inbox.cancelled', { sessionID: 's2', inboxID: 'same' });
    h.emit('session.inbox.delivered', { sessionID: 's2', inboxID: 'same' });
    expect(h.statuses).toEqual([['s1', '⏳ Processing...', 'reset']]);
    h.emit('session.inbox.enqueued', { sessionID: 's2', inboxID: 'new', item: { type: 'user' } });
    h.emit('session.inbox.delivered', { sessionID: 's2', inboxID: 'new' });
    expect(h.statuses.at(-1)).toEqual(['s2', '⏳ Processing...', 'reset']);
  });
});
