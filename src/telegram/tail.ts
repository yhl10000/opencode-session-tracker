import fs from 'fs';
import { bot, apiRef } from '../core/runtime';
import { computeStatus, getPromptStatusPath } from '../core/status';
import { buildMessageWithHeaderAndFooter, buildStatusFromParts, formatDuration, toMs } from './formatters';
import { localRunStatus, unwrapSessionList, sortMessagesAsc } from '../core/ctx';

export interface TailTracking {
  sessionId: string;
  chatId: number;
  messageId: number;
  lastText: string;
  lastEditAt: number;
  isComplete: boolean;
  timer: any;
  hasStartedRunning?: boolean;
  startedAt: number;
}

export const activeTails = new Map<number, TailTracking>();

const POLL_INTERVAL_MS = 2000;
const EDIT_THROTTLE_MS = 1200;
const MAX_MESSAGE_LEN = 4000;
const IDLE_START_GRACE_MS = 15000;
const EXPIRY_MS = 30 * 60 * 1000;

const roleOf = (m: any): string => m.type || (m.info || m).role;

/** Text of the last prompt status file written by the plugin, if any. */
function readLiveStatus(sessionId: string): { prose: string; proseTimestamp: number } {
  const statusFile = getPromptStatusPath(sessionId);
  if (!fs.existsSync(statusFile)) return { prose: '', proseTimestamp: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const prose = data.prose || (data.isComplete ? data.text : '') || '';
    return { prose, proseTimestamp: data.proseTimestamp || (data.isComplete ? data.timestamp : 0) || 0 };
  } catch {
    return { prose: '', proseTimestamp: 0 };
  }
}

function computeAssistantDuration(msgs: any[], lastAssistant: any): string {
  const assistantIndex = msgs.findIndex(m => (m.id || m.requestID) === (lastAssistant.id || lastAssistant.requestID));
  const lastUserMsg = assistantIndex > 0 ? msgs[assistantIndex - 1] : null;
  if (!lastUserMsg) return '';

  const startMs = toMs(lastUserMsg.time?.created || lastUserMsg.timeCreated);
  const endMs = toMs(lastAssistant.time?.completed || lastAssistant.time?.updated || lastAssistant.timeUpdated || lastAssistant.time?.created || lastAssistant.timeCreated);
  return startMs && endMs && endMs >= startMs ? formatDuration((endMs - startMs) / 1000) : '';
}

export async function getSessionActiveContent(
  sessionId: string,
  directory: string
): Promise<{
  activeText: string;
  activityText: string;
  lastAssistant: any;
  statusType: string;
  historyMsgs: any[];
  lastMsgIsAssistant: boolean;
  calculatedDurationStr?: string;
  proseTimestamp?: number;
}> {
  const msgsRes = await apiRef.client.message.list({ sessionID: sessionId, limit: 50, order: "desc" }).catch(() => null);
  const msgs = sortMessagesAsc(unwrapSessionList(msgsRes));

  const latestUserIndex = msgs.findLastIndex(m => roleOf(m) === 'user');
  const latestUser = latestUserIndex >= 0 ? msgs[latestUserIndex] : null;
  const rawStatus = localRunStatus(sessionId);
  const statusType = computeStatus(sessionId, rawStatus === 'running' ? 'busy' : rawStatus);

  let lastAssistant: any = null;
  let historyMsgs = latestUser ? [latestUser] : [];
  let lastMsgIsAssistant = false;

  if (msgs.length > 0) lastMsgIsAssistant = roleOf(msgs[msgs.length - 1]) === 'assistant';

  const currentTurnAssistants = msgs.slice(latestUserIndex + 1).filter(m => roleOf(m) === 'assistant');
  lastAssistant = currentTurnAssistants[currentTurnAssistants.length - 1] || null;

  const calculatedDurationStr = lastAssistant ? computeAssistantDuration(msgs, lastAssistant) : '';
  const live = readLiveStatus(sessionId);
  const latestUserTime = toMs(latestUser?.time?.created || latestUser?.timeCreated);
  const liveProseIsCurrent = !!live.prose && (!latestUser || (!!latestUserTime && live.proseTimestamp >= latestUserTime));
  let apiProse = '';
  let apiProseTimestamp = 0;
  for (const assistant of [...currentTurnAssistants].reverse()) {
    apiProse = buildStatusFromParts(assistant.content || assistant.parts || []);
    if (!apiProse) continue;
    apiProseTimestamp = toMs(assistant.time?.completed || assistant.time?.updated || assistant.timeUpdated || assistant.time?.created || assistant.timeCreated);
    break;
  }
  const useLiveProse = liveProseIsCurrent && (!apiProse || (apiProseTimestamp > 0 && live.proseTimestamp > apiProseTimestamp));
  const activeText = useLiveProse ? buildStatusFromParts([{ type: 'text', text: live.prose }]) : apiProse;
  const proseTimestamp = useLiveProse ? live.proseTimestamp : apiProseTimestamp;

  const activityText = statusType === 'perm'
    ? '🔐 Waiting for permission'
    : statusType === 'ask'
      ? '❓ Waiting for your answer'
      : statusType === 'idle' ? '✅ Completed' : '⏳ Working';

  return { activeText, activityText, lastAssistant, statusType, historyMsgs, lastMsgIsAssistant, calculatedDurationStr, proseTimestamp };
}

export function notifySessionIdle(sessionId: string) {
  // No-op since prompt tracking is removed in favor of persistent tail logs
}

/** When the parent is idle, an active child/sub-session keeps the tail alive. */
async function resolveEffectiveStatus(sessionId: string, directory: string, statusType: string): Promise<string> {
  if (statusType !== 'idle') return statusType;
  try {
    const listRes = await apiRef.client.session.list({ directory, limit: 50 }).catch(() => null);
    const sessions = unwrapSessionList(listRes);
    if (!Array.isArray(sessions)) return statusType;

    const children = sessions.filter((s: any) => s.parentID === sessionId && s.status !== 'deleted' && !s.time?.archived);
    if (children.length === 0) return statusType;

    const hasActiveChild = children.some((s: any) => {
      try {
        const st = localRunStatus(s.id);
        return st !== 'idle';
      } catch (e) {
        return false;
      }
    });
    if (hasActiveChild) return 'running';
  } catch (e) { /* child check best-effort */ }
  return statusType;
}

function renderHistoryMessage(m: any): { role: string; text: string } {
  const role = roleOf(m);
  if (role === 'assistant') {
    return { role, text: buildStatusFromParts(m.content || m.parts || []) };
  }
  // v2 user messages carry `text` directly; fall back to v1 parts parsing.
  const rawText = String(m.text || (typeof m.content === 'string' ? m.content : '') || (m.parts || [])
    .map((p: any) => {
      if (p.type === 'text') return p.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n')).trim();
  return { role, text: buildStatusFromParts([{ type: 'text', text: rawText }], 350) };
}

const ROLE_ICONS: Record<string, string> = { user: '👤', assistant: '🤖' };

/** Retire live tails of a session (their messages keep last content, buttons cleared). */
export function closeTailsForSession(sessionId: string) {
  for (const [msgId, tail] of activeTails.entries()) {
    if (tail.sessionId !== sessionId || tail.isComplete) continue;
    tail.isComplete = true;
    if (tail.timer) clearInterval(tail.timer);
    activeTails.delete(msgId);
    bot?.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: tail.chatId, message_id: msgId }).catch(() => {});
  }
}

export function startTailTracking(
  sessionId: string,
  chatId: number,
  trackingMessageId: number,
  directory: string
) {
  // One live tail per session: a second /tail (or Tail button) must not leave
  // the previous one editing its own message with phase-shifted content.
  closeTailsForSession(sessionId);
  const tracking: TailTracking = {
    sessionId,
    chatId,
    messageId: trackingMessageId,
    lastText: '',
    lastEditAt: 0,
    isComplete: false,
    timer: null as any,
    hasStartedRunning: false,
    startedAt: Date.now()
  };
  activeTails.set(trackingMessageId, tracking);

  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  // retryWithHtml: whether the fallback attempt keeps parse_mode HTML (final edits) or drops it (live edits)
  function sendEdit(text: string, retryWithHtml: boolean) {
    const edit = (parseMode?: 'HTML') => bot?.editMessageText(text, {
      chat_id: chatId,
      message_id: trackingMessageId,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: {
        inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${trackingMessageId}` }]]
      }
    });
    edit('HTML')?.catch((err: any) => {
      if ((err?.message || String(err)).includes('message is not modified')) return;
      edit(retryWithHtml ? 'HTML' : undefined)?.catch(() => {});
    });
  }

  function editMessageDirectly(text: string) {
    const safeText = text.slice(0, MAX_MESSAGE_LEN);
    tracking.lastText = safeText;
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    sendEdit(safeText, true);
  }

  function scheduleEdit(text: string) {
    if (tracking.isComplete) return;
    const safeText = text.slice(0, MAX_MESSAGE_LEN);
    if (safeText === tracking.lastText) return;
    tracking.lastText = safeText;

    if (pendingEdit) clearTimeout(pendingEdit);
    const sinceLastEdit = Date.now() - tracking.lastEditAt;
    const delay = Math.max(0, EDIT_THROTTLE_MS - sinceLastEdit);

    pendingEdit = setTimeout(() => {
      if (tracking.isComplete && tracking.lastText === safeText) return;
      tracking.lastEditAt = Date.now();
      sendEdit(safeText, false);
    }, delay);
  }

  let lastActivityTimestamp = Date.now();
  let lastFormattedContent = '';
  let promptStartedAt: number | null = null;
  let frozenDuration = '';

  tracking.timer = setInterval(async () => {
    try {
      if (tracking.isComplete) return;
      const { activeText, activityText, lastAssistant, statusType, historyMsgs, lastMsgIsAssistant, calculatedDurationStr, proseTimestamp } = await getSessionActiveContent(sessionId, directory);
      const effectiveStatusType = await resolveEffectiveStatus(sessionId, directory, statusType);

      const formattedHistory = historyMsgs
        .map(renderHistoryMessage)
        .filter(c => c.text)
        .map(c => `${ROLE_ICONS[c.role] || '❓'} ${c.text}\n\n`)
        .join('');

      const displayActivity = effectiveStatusType === 'running' && statusType === 'idle' ? '⏳ Working' : activityText;
      const staleProse = proseTimestamp && Date.now() - proseTimestamp > 30000
        ? ` · updated ${formatDuration((Date.now() - proseTimestamp) / 1000)} ago` : '';
      const formattedActive = (effectiveStatusType !== 'idle' || lastMsgIsAssistant || activeText)
        ? `🤖 ${activeText ? `${activeText}\n\n` : ''}${displayActivity}${staleProse}\n\n` : '';
      const contentText = `${formattedHistory}${formattedActive}`.trim();

      if (contentText !== lastFormattedContent || effectiveStatusType !== 'idle') {
        lastActivityTimestamp = Date.now();
        lastFormattedContent = contentText;
      }

      // Manage duration tracking and track if prompt has started running
      if (effectiveStatusType !== 'idle') {
        tracking.hasStartedRunning = true;
        if (!promptStartedAt) promptStartedAt = Date.now();
        frozenDuration = '';
      } else if (promptStartedAt) {
        frozenDuration = formatDuration((Date.now() - promptStartedAt) / 1000);
        promptStartedAt = null;
      } else if (calculatedDurationStr) {
        frozenDuration = calculatedDurationStr;
      }

      const durationStr = promptStartedAt
        ? formatDuration((Date.now() - promptStartedAt) / 1000)
        : (frozenDuration || '0.0s');

      // Finalize tail if session goes idle (and has started running, or has been idle for 15s since tail started)
      const timeSinceStart = Date.now() - tracking.startedAt;
      const isSessionCompleted = effectiveStatusType === 'idle' && (tracking.hasStartedRunning || timeSinceStart > IDLE_START_GRACE_MS);
      const isExpired = Date.now() - lastActivityTimestamp > EXPIRY_MS;
      const isFinal = isSessionCompleted || isExpired;

      if (isFinal) {
        tracking.isComplete = true;
        clearInterval(tracking.timer);
        activeTails.delete(trackingMessageId);
      }

      const finalMsg = await buildMessageWithHeaderAndFooter(sessionId, contentText, lastAssistant, lastActivityTimestamp, durationStr);
      if (isFinal) editMessageDirectly(finalMsg);
      else scheduleEdit(finalMsg);
    } catch (err) {
      console.error('[Telegram] Tail polling interval error:', err);
    }
  }, POLL_INTERVAL_MS);
}
