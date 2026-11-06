import type { OpenCodeClient, PermissionRequest } from '@opencode/client';
import type TelegramBot from 'node-telegram-bot-api';
import { bot, allowedUsers, isLeader } from '../core/runtime';
import { permissionRequests, type PermissionRequest as StoredRequest } from '../core/context';
import { createStore } from '../core/store';
import { localSessionTitle } from '../core/ctx';
import { escapeHtml } from './formatters';

type MapStore<T> = Pick<ReturnType<typeof createStore<T>>, 'get' | 'set' | 'delete' | 'entries'>;
type Notice = { messages: Record<string, { id: number; signature: string }> };
interface Environment {
  requests: MapStore<StoredRequest>;
  notices: MapStore<Notice>;
  delivery: () => { leader: boolean; bot: TelegramBot | null; users: number[] };
  title: (sessionID: string) => string;
  graceMs: number;
  retryMs: number;
  timeoutMs: number;
}
const defaults: Environment = {
  requests: permissionRequests, notices: createStore<Notice>('permissionNotices'),
  delivery: () => ({ leader: isLeader, bot, users: allowedUsers }), title: localSessionTitle,
  graceMs: 1000, retryMs: 3000, timeoutMs: 2000,
};

export function createPermissionReminders(ctx: { client: Pick<OpenCodeClient, 'permission'> }, env = defaults) {
  const sessions = new Map<string, { notice: Notice; confirmed: Set<string>; busy: boolean; again: boolean }>();
  const resolved = new Set<string>();
  const controllers = new Set<AbortController>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextCheck = 0;
  const key = (sessionID: string, id: string) => JSON.stringify([sessionID, id]);
  const requests = (sessionID: string) => env.requests.entries().filter(([, r]) => r.sessionId === sessionID);
  const state = (sessionID: string) => {
    let s = sessions.get(sessionID);
    if (!s) {
      s = { notice: env.notices.get(sessionID) || { messages: {} }, confirmed: new Set(), busy: false, again: false };
      sessions.set(sessionID, s);
    }
    return s;
  };
  const rememberResolved = (sessionID: string, id: string) => {
    resolved.add(key(sessionID, id));
    if (resolved.size > 2048) resolved.delete(resolved.values().next().value!);
  };
  const remove = (sessionID: string, id: string) => {
    rememberResolved(sessionID, id);
    for (const [shortID, r] of requests(sessionID)) if (r.permId === id) env.requests.delete(shortID);
    state(sessionID).confirmed.delete(id);
  };
  const persist = (sessionID: string) => {
    if (!disposed) env.notices.set(sessionID, state(sessionID).notice);
  };

  function schedule(delay = env.retryMs) {
    for (const [, r] of env.requests.entries()) {
      const remaining = (r.notBefore || 0) - Date.now();
      if (remaining > 0) delay = Math.min(delay, remaining);
    }
    if (disposed || (timer && nextCheck <= Date.now() + delay)) return;
    clearTimeout(timer);
    nextCheck = Date.now() + delay;
    timer = setTimeout(() => {
      timer = undefined;
      for (const [, r] of env.requests.entries()) state(r.sessionId);
      for (const [sessionID, notice] of env.notices.entries()) if (Object.keys(notice.messages).length) state(sessionID);
      for (const [sessionID] of sessions) void check(sessionID);
      schedule();
    }, delay);
  }

  function content(sessionID: string, pending: [string, StoredRequest][]) {
    const title = escapeHtml((env.title(sessionID) || sessionID.slice(0, 8)).slice(0, 120));
    const visible = pending.slice(0, 20);
    const more = pending.length - visible.length;
    const descriptionLimit = Math.min(180, Math.max(0, Math.floor(3000 / Math.max(1, visible.length) / 6) - 8));
    return {
      text: pending.length
        ? `🔐 <b>Permission Requested</b> — ${title}\n\n` + visible.map(([, r], i) =>
          `${i + 1}. ${escapeHtml((r.description || 'Approve action?').slice(0, descriptionLimit))}`).join('\n')
          + (more ? `\n\n${more} more pending; resolve these to see next.` : '')
        : `🔐 <b>Permissions resolved</b> — ${title}`,
      keyboard: visible.map(([shortID], i) => [
        { text: `✅ Allow ${i + 1}`, callback_data: `perm_allow_${shortID}` },
        { text: `❌ Deny ${i + 1}`, callback_data: `perm_deny_${shortID}` },
      ]),
    };
  }

  async function render(sessionID: string, uncertain: boolean) {
    const s = state(sessionID);
    let ok = true;
    for (const user of env.delivery().users) {
      const delivery = env.delivery();
      if (disposed || !delivery.leader || !delivery.bot) return false;
      try {
        const pending = requests(sessionID).filter(([, r]) => s.confirmed.has(r.permId));
        const current = content(sessionID, uncertain ? [] : pending);
        const text = uncertain
          ? `⚠️ Unable to verify pending permissions — ${escapeHtml((env.title(sessionID) || sessionID).slice(0, 120))}. Retrying; check OpenCode.`
          : current.text;
        const keyboard = current.keyboard;
        const signature = JSON.stringify([text, keyboard]);
        const previous = s.notice.messages[user];
        if (previous && previous.signature !== signature) {
          try {
            await delivery.bot.editMessageText(text, {
              chat_id: user, message_id: previous.id, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard },
            });
          } catch (error) {
            const body = (error as any)?.response?.body;
            const description = body?.error_code === 400 && typeof body.description === 'string'
              ? body.description : '';
            if (/message (?:to edit not found|can't be edited)/i.test(description)) {
              delete s.notice.messages[user];
              persist(sessionID);
              s.again = true;
              continue;
            }
            if (!/message is not modified/i.test(description)) throw error;
          }
          previous.signature = signature;
          persist(sessionID);
        } else if (!previous && (pending.length || (uncertain && requests(sessionID).length))) {
          const sent = await delivery.bot.sendMessage(user, text, {
            parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard },
          });
          s.notice.messages[user] = { id: sent.message_id, signature };
          persist(sessionID);
          // A reply/disposal may race sendMessage; never leave its newly-created buttons live.
          const remaining = content(sessionID, requests(sessionID).filter(([, r]) => s.confirmed.has(r.permId)));
          if (disposed || !requests(sessionID).length || (keyboard.length && JSON.stringify(remaining.keyboard) !== JSON.stringify(keyboard))) {
            await delivery.bot.editMessageText(content(sessionID, []).text, {
              chat_id: user, message_id: sent.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] },
            });
            s.notice.messages[user].signature = '';
            persist(sessionID);
          }
        }
      } catch (error) {
        ok = false;
        console.error('[session-tracker] permission notification failed:', error);
      }
    }
    return ok;
  }

  async function check(sessionID: string) {
    const s = state(sessionID);
    if (disposed || !env.delivery().leader) return;
    if (s.busy) { s.again = true; return; }
    s.notice = env.notices.get(sessionID) || s.notice;
    s.busy = true;
    const snapshot = requests(sessionID).filter(([, r]) => (r.notBefore || 0) <= Date.now());
    let uncertain = false;
    const controller = new AbortController();
    controllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (snapshot.length) {
        const result = await Promise.race([
          ctx.client.permission.list({ sessionID }, { signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => { controller.abort(); reject(new Error('Permission read timed out')); }, env.timeoutMs);
          }),
        ]);
        if (disposed) return;
        if (!Array.isArray(result) || result.some(r => !r || typeof r.id !== 'string' || r.sessionID !== sessionID)) {
          throw new Error('Invalid permission list');
        }
        const pending = new Set(result.map(r => r.id));
        for (const [, r] of snapshot) {
          if (!pending.has(r.permId)) remove(sessionID, r.permId);
          else if (!resolved.has(key(sessionID, r.permId))) s.confirmed.add(r.permId);
        }
      }
    } catch {
      uncertain = true;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
    try {
      if (!disposed && await render(sessionID, uncertain && requests(sessionID).length > 0) && !s.again && !requests(sessionID).length) {
        s.notice.messages = {};
        persist(sessionID);
        sessions.delete(sessionID);
      }
    } catch (error) {
      console.error('[session-tracker] permission notification failed:', error);
    } finally {
      s.busy = false;
      if (s.again && !disposed) { s.again = false; void check(sessionID); }
    }
  }

  schedule(env.graceMs);
  return {
    asked(request: PermissionRequest) {
      if (disposed || !request.sessionID || !request.id || resolved.has(key(request.sessionID, request.id))) return;
      if (requests(request.sessionID).some(([, r]) => r.permId === request.id)) return;
      const shortID = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      env.requests.set(shortID, { sessionId: request.sessionID, permId: request.id,
        description: request.message || `${request.action}: ${(request.resources || []).join(', ')}`,
        notBefore: Date.now() + env.graceMs });
      state(request.sessionID);
      schedule(env.graceMs);
    },
    replied(sessionID: string, requestID: string) {
      if (disposed || !sessionID || !requestID) return;
      remove(sessionID, requestID);
      void check(sessionID);
    },
    refresh(sessionID: string) {
      const s = state(sessionID);
      s.notice = env.notices.get(sessionID) || s.notice;
      for (const message of Object.values(s.notice.messages)) message.signature = '';
      persist(sessionID);
      void check(sessionID);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    },
  };
}

const shared = globalThis as typeof globalThis & { __stPermissions?: ReturnType<typeof createPermissionReminders> };
export function startPermissionReminders(ctx: Parameters<typeof createPermissionReminders>[0]) {
  shared.__stPermissions?.dispose();
  shared.__stPermissions = createPermissionReminders(ctx);
  return shared.__stPermissions;
}
export function permissionResolved(sessionID: string, requestID: string) { shared.__stPermissions?.replied(sessionID, requestID); }
export function refreshPermissions(sessionID: string) { shared.__stPermissions?.refresh(sessionID); }
