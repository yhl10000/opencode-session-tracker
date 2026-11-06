import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { apiRef, setActiveProjectDir, setAllowedUsers, setApiRef, setBot, setLastSessionsMessage } from '../src/core/runtime';
import { getActiveSessionId, hasActiveSessionSelection, pendingQuestions, qfMap, setActiveSessionId, updateCurrentSessionId } from '../src/core/context';
import { readState, storeGet, storeSet } from '../src/core/store';
import { onMessage } from '../src/telegram/bot';
import { registerCallbackHandler } from '../src/telegram/callbacks';
import { getSessionsKeyboard } from '../src/telegram/keyboards';
import { activeTails, closeTailsForSession } from '../src/telegram/tail';
import { handleJob, type Job } from '../src/core/queue';

const local = 'routing-local';
const other = 'routing-other';
let sent: { text: string; message_id: number }[];
let prompts: any[];
let creates: any[];
let routes: any[];
let gets: string[];
let formReplies: any[];
let messageLists: string[];
let promptError: Error | null;
let handlers: Record<string, (query: any) => Promise<void>>;
let fakeBot: any;

async function message(text: string, replyTo?: number) {
  await onMessage(fakeBot, {
    from: { id: 1 }, chat: { id: 1 }, message_id: 50, text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
  } as any);
}

async function select(id: string) {
  await handlers.callback_query({
    id: 'query', from: { id: 1 }, data: `nav_${id}`,
    message: { message_id: 10, chat: { id: 1 } },
  });
}

function expectNoUiOrJobs() {
  expect(routes).toEqual([]);
  expect(storeGet('queue', [])).toEqual([]);
  expect(storeGet<any>('activeSessions', {})[local]).toBe('A');
}

describe('Telegram independent session routing', () => {
  beforeEach(() => {
    sent = []; prompts = []; creates = []; routes = []; gets = []; formReplies = []; messageLists = []; handlers = {}; promptError = null;
    for (const key of ['activeSessions', 'telegramActiveSessions', 'messageSessions', 'pendingQuestions', 'qfMap']) storeSet(key, {});
    storeSet('queue', []);
    setActiveProjectDir(local);
    setAllowedUsers([1]);
    setLastSessionsMessage({ chatId: 1, messageId: 10, timestamp: Date.now() });
    fakeBot = {
      on: (event: string, handler: any) => { handlers[event] = handler; },
      sendMessage: async (_chat: number, text: string) => {
        const msg = { text, message_id: 100 + sent.length, chat: { id: 1 } };
        sent.push(msg);
        return msg;
      },
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
      editMessageText: async () => {},
    };
    setBot(fakeBot);
    setApiRef({
      ui: { router: { navigate: (route: any) => routes.push(route) }, input: { submit: () => { throw new Error('UI input forbidden'); } } },
      data: { location: { default: () => ({ directory: local }) }, session: { status: () => 'idle' } },
      client: {
        session: {
          list: async () => [{ id: 'A', title: 'A', time: { updated: Date.now() } }, { id: 'B', title: 'B', time: { updated: Date.now() } }],
          get: async ({ sessionID }: any) => { gets.push(sessionID); return { id: sessionID, title: sessionID, location: { directory: sessionID === 'A' ? other : local } }; },
          prompt: async (opts: any) => { prompts.push(opts); if (promptError) throw promptError; },
          create: async (opts: any) => { creates.push(opts); return { id: 'NEW' }; },
          form: { reply: async (opts: any) => { formReplies.push(opts); } },
        },
        message: { list: async ({ sessionID }: any) => { messageLists.push(sessionID); return []; } },
      },
    });
    updateCurrentSessionId('A');
    registerCallbackHandler(fakeBot, () => true);
  });

  afterEach(() => {
    for (const tail of [...activeTails.values()]) closeTailsForSession(tail.sessionId);
    setBot(null);
    setActiveProjectDir(null);
    setLastSessionsMessage(null);
    setAllowedUsers([]);
    for (const key of ['activeSessions', 'telegramActiveSessions', 'messageSessions', 'pendingQuestions', 'qfMap']) storeSet(key, {});
    storeSet('queue', []);
  });

  test('selecting B changes only remote selection, never terminal view or navigation jobs', async () => {
    await select('B');
    expect(getActiveSessionId()).toBe('B');
    expectNoUiOrJobs();
  });

  test('same-directory prompts reach B exactly once without terminal navigation', async () => {
    setActiveSessionId(local, 'B');
    await message('same-directory');
    expect(prompts).toEqual([{ sessionID: 'B', text: 'same-directory' }]);
    expect(creates).toEqual([]);
    expectNoUiOrJobs();
  });

  test('different-directory prompts reach B exactly once without queueing', async () => {
    setActiveProjectDir(other);
    setActiveSessionId(other, 'B');
    await message('different-directory');
    expect(prompts).toEqual([{ sessionID: 'B', text: 'different-directory' }]);
    expect(creates).toEqual([]);
    expectNoUiOrJobs();
  });

  test('terminal observation A cannot overwrite durable remote selection B', () => {
    setActiveSessionId(local, 'B');
    updateCurrentSessionId('A');
    expect(getActiveSessionId()).toBe('B');
    expect(readState().telegramActiveSessions[local]).toBe('B');
    expectNoUiOrJobs();
  });

  test('reply to A uses its directory for this interaction and leaves default B unchanged', async () => {
    setActiveSessionId(local, 'B');
    setActiveSessionId(other, 'B');
    storeSet('messageSessions', { 9: { sessionId: 'A', directory: other } });
    await message('reply A', 9);
    expect(prompts).toEqual([{ sessionID: 'A', text: 'reply A' }]);
    expect(getActiveSessionId(local)).toBe('B');
    expect(getActiveSessionId(other)).toBe('B');
    expect(storeGet<any>('messageSessions', {})[100]).toMatchObject({ sessionId: 'A', directory: other });
    expectNoUiOrJobs();
  });

  test('missing remote selection ignores legacy A and asks for /sessions without creating', async () => {
    await message('no selection');
    expect(prompts).toEqual([]);
    expect(creates).toEqual([]);
    expect(sent.some(msg => msg.text.includes('/sessions'))).toBe(true);
    expect(getActiveSessionId()).toBeNull();
    expect(hasActiveSessionSelection()).toBe(false);
    expectNoUiOrJobs();
  });

  test('explicit New Session creates in selected directory and prompts new SID without UI', async () => {
    setActiveProjectDir(other);
    await select('home');
    expect(hasActiveSessionSelection(other)).toBe(true);
    await message('new conversation');
    expect(creates).toEqual([{ location: { directory: other } }]);
    expect(prompts).toEqual([{ sessionID: 'NEW', text: 'new conversation' }]);
    expect(getActiveSessionId(other)).toBe('NEW');
    expectNoUiOrJobs();
  });

  test('keyboard marks New Session only after an explicit selection', async () => {
    expect((await getSessionsKeyboard())[0][0].text.startsWith('→')).toBe(false);
    await select('home');
    expect((await getSessionsKeyboard())[0][0].text.startsWith('→')).toBe(true);
    await select('B');
    expect((await getSessionsKeyboard()).flat().find(button => button.callback_data === 'nav_B')?.text.startsWith('→')).toBe(true);
    expectNoUiOrJobs();
  });

  test.each([local, other])('target API failure in %s is reported once without retry, queue, or A fallback', async (dir) => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      setActiveProjectDir(dir);
      setActiveSessionId(dir, 'B');
      promptError = new Error('Target B deleted');
      await message('must fail');
      expect(prompts).toEqual([{ sessionID: 'B', text: 'must fail' }]);
      expect(creates).toEqual([]);
      expect(sent.some(msg => msg.text.includes('Target B deleted'))).toBe(true);
      expect(activeTails.size).toBe(0);
      expectNoUiOrJobs();
      expect(errors).toHaveBeenCalledTimes(1);
    } finally { errors.mockRestore(); }
  });

  test('pending form text stays bound to the target session, including old-message replies', async () => {
    setActiveSessionId(local, 'B');
    storeSet('pendingQuestions', { A: 'form-A', B: 'form-B' });
    storeSet('qfMap', Object.fromEntries(['A', 'B'].map(sessionId => [`form-${sessionId}`, {
      requestId: `form-${sessionId}`, sessionId, title: sessionId, currentIndex: 0,
      questions: [{ key: 'answer', question: 'Answer?' }],
    }])));
    storeSet('messageSessions', { 9: { sessionId: 'A', directory: other } });
    await message('answer B');
    await message('answer A', 9);
    expect(formReplies).toEqual([
      { sessionID: 'B', formID: 'form-B', answer: { answer: 'answer B' } },
      { sessionID: 'A', formID: 'form-A', answer: { answer: 'answer A' } },
    ]);
    expect(prompts).toEqual([]);
    expect(creates).toEqual([]);
    expect(getActiveSessionId(local)).toBe('B');
    expectNoUiOrJobs();
  });

  test('recap defaults to remote selection B and never observes legacy A', async () => {
    setActiveSessionId(local, 'B');
    await message('/recap');
    expect(messageLists).toEqual(['B']);
    expect(gets).toEqual(['B']);
    expectNoUiOrJobs();
  });

  test('tail defaults to remote B; explicit A keeps its own directory for future replies', async () => {
    setActiveSessionId(local, 'B');
    await message('/tail');
    expect([...activeTails.values()].map(tail => tail.sessionId)).toEqual(['B']);
    await message('/tail A');
    expect(gets).toEqual(['B', 'A']);
    expect(storeGet<any>('messageSessions', {})[101]).toMatchObject({ sessionId: 'A', directory: other });
    expect(getActiveSessionId(local)).toBe('B');
    expectNoUiOrJobs();
  });
});

describe('legacy queue routing', () => {
  const DIR_A = 'Q:/queue-project-a';
  const DIR_B = 'Q:/queue-project-b';
  const observed = { [DIR_A]: 'A', [DIR_B]: 'B-local' };
  const remote = { [DIR_A]: 'B', [DIR_B]: 'B' };
  const keys = ['activeSessions', 'telegramActiveSessions', 'pendingQuestions', 'qfMap', 'syncError', 'menuUpdateTimestamp'];
  let previousApi: any;
  let previousState: any[];
  let errors: ReturnType<typeof spyOn>;
  let view: { type: string; sessionID?: string };
  let navigate: ReturnType<typeof mock>;
  let session: any;

  beforeEach(() => {
    previousApi = apiRef;
    previousState = keys.map(key => storeGet(key, null));
    storeSet('activeSessions', observed);
    storeSet('telegramActiveSessions', remote);
    storeSet('pendingQuestions', {});
    storeSet('qfMap', {});
    storeSet('syncError', null);
    storeSet('menuUpdateTimestamp', 123);
    errors = spyOn(console, 'error').mockImplementation(() => {});
    view = { type: 'session', sessionID: 'A' };
    navigate = mock((route: typeof view) => { view = route; });
    session = {
      create: mock(async () => ({ id: 'B-new' })),
      prompt: mock(async () => {}),
      switchModel: mock(async () => {}),
      form: { reply: mock(async () => {}) },
    };
    setApiRef({
      client: { session },
      data: { location: { default: () => ({ directory: DIR_A }) } },
      ui: { router: { navigate, current: () => view } },
    });
  });

  afterEach(() => {
    setApiRef(previousApi);
    keys.forEach((key, index) => storeSet(key, previousState[index]));
    errors.mockRestore();
  });

  function job(overrides: Partial<Job> = {}): Job {
    return { id: 'legacy-job', type: 'prompt', targetDir: DIR_B, sessionId: 'B', text: 'continue B', createdAt: 1, ...overrides };
  }

  function expectUnchangedViewAndSelection() {
    expect(navigate).not.toHaveBeenCalled();
    expect(view).toEqual({ type: 'session', sessionID: 'A' });
    expect(storeGet('activeSessions', {})).toEqual(observed);
    expect(storeGet('telegramActiveSessions', {})).toEqual(remote);
    expect(storeGet('menuUpdateTimestamp', 0)).toBe(123);
  }

  for (const sessionId of ['B', null]) {
    test(`navigate ${sessionId} is a no-op, leaving acknowledgement to the caller`, async () => {
      await handleJob(job({ type: 'navigate', sessionId }));
      expectUnchangedViewAndSelection();
      expect(session.create).not.toHaveBeenCalled();
      expect(session.prompt).not.toHaveBeenCalled();
      expect(session.switchModel).not.toHaveBeenCalled();
    });
  }

  for (const targetDir of [DIR_A, DIR_B]) {
    test(`prompt sends only to explicit B in ${targetDir} without navigating A`, async () => {
      await handleJob(job({ targetDir }));
      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(session.prompt).toHaveBeenCalledWith({ sessionID: 'B', text: 'continue B' });
      expect(session.create).not.toHaveBeenCalled();
      expectUnchangedViewAndSelection();
    });
  }

  test('null-session prompt creates in the job directory, not the current TUI directory', async () => {
    await handleJob(job({ sessionId: null }));
    expect(session.create).toHaveBeenCalledWith({ location: { directory: DIR_B } });
    expect(session.prompt).toHaveBeenCalledWith({ sessionID: 'B-new', text: 'continue B' });
    expectUnchangedViewAndSelection();
  });

  test('pending form text answers B without creating a prompt or changing selection', async () => {
    pendingQuestions.set('B', 'form-B');
    qfMap.set('form-B', {
      requestId: 'form-B', sessionId: 'B', title: 'Question', currentIndex: 0,
      questions: [{ key: 'answer', question: 'Continue?' }],
    });
    await handleJob(job());
    expect(session.form.reply).toHaveBeenCalledWith({ sessionID: 'B', formID: 'form-B', answer: { answer: 'continue B' } });
    expect(pendingQuestions.get('B')).toBeUndefined();
    expect(qfMap.get('form-B')).toBeUndefined();
    expect(session.prompt).not.toHaveBeenCalled();
    expectUnchangedViewAndSelection();
  });

  test('form handling errors remain reported and fall through to explicit B prompt', async () => {
    pendingQuestions.set('B', 'form-B');
    qfMap.set('form-B', { requestId: 'form-B', sessionId: 'B', title: 'Broken', currentIndex: 0, questions: [] });
    await handleJob(job());
    expect(storeGet<any>('syncError', null)?.action).toBe('answer form');
    expect(session.prompt).toHaveBeenCalledWith({ sessionID: 'B', text: 'continue B' });
    expectUnchangedViewAndSelection();
  });

  test('prompt API error is reported and propagated without any A fallback', async () => {
    const failure = new Error('B prompt failed');
    session.prompt.mockRejectedValue(failure);
    await expect(handleJob(job())).rejects.toBe(failure);
    expect(storeGet<any>('syncError', null)).toMatchObject({ action: 'job prompt "continue B"', detail: failure.message });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith({ sessionID: 'B', text: 'continue B' });
    expectUnchangedViewAndSelection();
  });

  test('create API failure is reported without prompting any session', async () => {
    const failure = new Error('B creation failed');
    session.create.mockRejectedValue(failure);
    await expect(handleJob(job({ sessionId: null }))).rejects.toBe(failure);
    expect(storeGet<any>('syncError', null)?.detail).toBe(failure.message);
    expect(session.prompt).not.toHaveBeenCalled();
    expectUnchangedViewAndSelection();
  });

  test('missing created session ID is reported without an A fallback', async () => {
    session.create.mockResolvedValue({});
    await expect(handleJob(job({ sessionId: null }))).rejects.toThrow('session.create returned no id');
    expect(storeGet<any>('syncError', null)?.detail).toBe('session.create returned no id');
    expect(session.prompt).not.toHaveBeenCalled();
    expectUnchangedViewAndSelection();
  });

  test('missing API client rejects instead of silently acknowledging a dropped prompt', async () => {
    setApiRef({ ...apiRef, client: undefined });
    await expect(handleJob(job())).rejects.toThrow();
    expect(storeGet<any>('syncError', null)?.action).toBe('job prompt "continue B"');
    expectUnchangedViewAndSelection();
  });

  test('model change still targets explicit B without changing A or remote selection', async () => {
    await handleJob(job({ type: 'model_change', providerID: 'provider', modelID: 'model' }));
    expect(session.switchModel).toHaveBeenCalledWith({ sessionID: 'B', model: { id: 'model', providerID: 'provider' } });
    expect(session.prompt).not.toHaveBeenCalled();
    expectUnchangedViewAndSelection();
  });

  test('missing switchModel rejects and reports failure instead of silently dropping the job', async () => {
    session.switchModel = undefined;
    await expect(handleJob(job({ type: 'model_change' }))).rejects.toThrow();
    expect(storeGet<any>('syncError', null)?.action).toBe('job model_change "continue B"');
    expectUnchangedViewAndSelection();
  });
});
