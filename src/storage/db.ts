import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { HistoryEntry, Job } from '@/src/shared/types';

interface VidgetDb extends DBSchema {
  jobs: { key: string; value: Job };
  history: { key: string; value: HistoryEntry; indexes: { finishedAt: number } };
}

export const HISTORY_LIMIT = 500;

let dbPromise: Promise<IDBPDatabase<VidgetDb>> | undefined;

function db() {
  dbPromise ??= openDB<VidgetDb>('vidget-db', 1, {
    upgrade(database) {
      database.createObjectStore('jobs', { keyPath: 'id' });
      const history = database.createObjectStore('history', { keyPath: 'jobId' });
      history.createIndex('finishedAt', 'finishedAt');
    },
  });
  return dbPromise;
}

export async function putJob(job: Job): Promise<void> {
  await (await db()).put('jobs', job);
}

export async function deleteJob(id: string): Promise<void> {
  await (await db()).delete('jobs', id);
}

export async function getJobs(): Promise<Job[]> {
  const jobs = await (await db()).getAll('jobs');
  return jobs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addHistory(entry: HistoryEntry): Promise<void> {
  const database = await db();
  await database.put('history', entry);
  await pruneHistory();
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const rows = await (await db()).getAllFromIndex('history', 'finishedAt');
  return rows.reverse();
}

export async function clearHistory(): Promise<void> {
  await (await db()).clear('history');
}

/** Keep the newest rows, and drop any older than `maxAgeDays` when it is set. */
export async function pruneHistory(maxAgeDays = 0, now = Date.now()): Promise<void> {
  const tx = (await db()).transaction('history', 'readwrite');
  const index = tx.store.index('finishedAt');
  const count = await index.count();
  let excess = count - HISTORY_LIMIT;
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86_400_000 : -Infinity;
  for (let cursor = await index.openCursor(); cursor; cursor = await cursor.continue()) {
    if (excess <= 0 && cursor.value.finishedAt >= cutoff) break;
    await cursor.delete();
    excess -= 1;
  }
  await tx.done;
}
