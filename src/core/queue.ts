// Durable cross-instance job queue. Replaces the old single `sync` slot,
// which had two fatal flaws:
//  1. last-writer-wins: a second Telegram command overwrote the first
//     before any instance consumed it (silent loss);
//  2. in-memory-only `lastSyncTimestamp` dedupe: every TUI (re)start
//     REPLAYED the stale record (the duplicate-message saga).
//
// Claims (claimedAt/claimedBy) and acks (doneAt) are persisted, but unlocked
// read-modify-write can race across instances; this is not exactly-once delivery.
// Job execution failures are reported via reportError -> leader -> Telegram.
import crypto from 'crypto';
import { apiRef } from './runtime';
import { storeGet, storeSet } from './store';
import { pendingQuestions, buildPromptOpts } from './context';
import { answerFlowWithText } from '../telegram/forms';
import { unwrapSessionId } from './ctx';

export type JobType = 'navigate' | 'prompt' | 'model_change';

export interface Job {
  id: string;
  type: JobType;
  targetDir: string;
  sessionId: string | null;
  text?: string;
  providerID?: string;
  modelID?: string;
  createdAt: number;
  claimedAt?: number;
  claimedBy?: string;
  doneAt?: number;
  error?: string;
}

const QUEUE_KEY = 'queue';
const MAX_JOBS = 50;

function readQueue(): Job[] {
  try {
    const q = storeGet<Job[]>(QUEUE_KEY, []);
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function writeQueue(jobs: Job[]) {
  storeSet(QUEUE_KEY, jobs.slice(-MAX_JOBS));
}

export function enqueue(partial: Omit<Job, 'id' | 'createdAt'>): Job {
  const job: Job = { ...partial, id: crypto.randomUUID(), createdAt: Date.now() };
  const q = readQueue();
  q.push(job);
  writeQueue(q);
  return job;
}

/** Persist this instance's pending claims; concurrent instances can race. */
export function claimDue(dir: string, owner: string): Job[] {
  const q = readQueue();
  const due = q.filter((j) => !j.claimedAt && !j.doneAt && j.targetDir === dir);
  if (due.length === 0) return [];
  const ids = new Set(due.map((j) => j.id));
  writeQueue(q.map((j) => (ids.has(j.id) ? { ...j, claimedAt: Date.now(), claimedBy: owner } : j)));
  return due;
}

export function ack(id: string, error?: string) {
  const now = Date.now();
  const q = readQueue().map((j) => (j.id === id ? { ...j, doneAt: now, ...(error ? { error } : {}) } : j));
  // Prune acks older than an hour; cap length.
  writeQueue(q.filter((j) => !j.doneAt || now - j.doneAt < 3600_000));
}

export function pendingJobCount(dir?: string): number {
  return readQueue().filter(
    (j) => !j.claimedAt && !j.doneAt && (!dir || j.targetDir === dir),
  ).length;
}

// --- Errors: always surfaced, never swallowed ---

export interface QueueError {
  action: string;
  detail: string;
  timestamp: number;
}

export function reportError(action: string, err: any) {
  const detail = String(err?.message || err || 'unknown error').slice(0, 300);
  storeSet('syncError', { action, detail, timestamp: Date.now() } satisfies QueueError);
  console.error(`[session-tracker] ${action} failed: ${detail}`);
}

export function takeSyncError(): QueueError | null {
  try {
    return storeGet<QueueError | null>('syncError', null);
  } catch {
    return null;
  }
}

export function clearSyncError() {
  storeSet('syncError', null);
}

// --- Job execution (runs in the owning instance) ---

export async function handleJob(job: Job) {
  try {
    if (job.type === 'navigate') {
      // Legacy navigation jobs must not take over a terminal's current view.
      return;
    }
    if (job.type === 'prompt' && job.sessionId) {
      // A pending form takes the text as its answer — no new prompt.
      try {
        const formId = pendingQuestions.get(job.sessionId);
        if (formId && answerFlowWithText(job.sessionId, formId, job.text || '')) {
          pendingQuestions.delete(job.sessionId);
          return;
        }
      } catch (e) {
        reportError('answer form', e);
      }
      await apiRef.client.session.prompt(buildPromptOpts(job.sessionId, job.text || ''));
      return;
    }
    if (job.type === 'prompt' && !job.sessionId) {
      const created: any = await apiRef.client.session.create({ location: { directory: job.targetDir } });
      const newId = unwrapSessionId(created);
      if (!newId) throw new Error('session.create returned no id');
      await apiRef.client.session.prompt(buildPromptOpts(newId, job.text || ''));
      return;
    }
    if (job.type === 'model_change' && job.sessionId) {
      await apiRef.client.session.switchModel({
        sessionID: job.sessionId,
        model: { id: job.modelID, providerID: job.providerID },
      });
      return;
    }
    throw new Error(`unhandled job type: ${job.type}`);
  } catch (e: any) {
    reportError(`job ${job.type}${job.text ? ` "${(job.text as string).slice(0, 60)}"` : ''}`, e);
    throw e;
  }
}
