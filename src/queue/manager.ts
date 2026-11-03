import type { CompanionEvent } from '@/src/companion/protocol';
import { JobError } from '@/src/shared/errors';
import { renderFilename } from '@/src/shared/filename';
import { fileExtension, qualityLabel } from '@/src/shared/format';
import type { HeavyEvent, ProgressUpdate } from '@/src/shared/messages';
import type { Settings } from '@/src/shared/settings';
import type { ErrorCode, HistoryEntry, Job, MediaInfo, Variant } from '@/src/shared/types';
import { isRunning, nextToStart } from './scheduler';

const PERSIST_MS = 2000;
const DOWNLOAD_START_MS = 5000;

export type DownloadState = 'in_progress' | 'interrupted' | 'complete';

export interface DirectProgress {
  state: DownloadState;
  bytesReceived: number;
  totalBytes: number;
  error?: string;
}

/** Everything the queue needs from the browser, so it can be tested without one. */
export interface Platform {
  settings(): Promise<Settings>;
  saveJob(job: Job): Promise<void>;
  deleteJob(id: string): Promise<void>;
  addHistory(entry: HistoryEntry): Promise<void>;
  removeWorkDir(id: string): Promise<void>;
  setReferer(jobId: string, urls: string[], pageUrl: string): Promise<void>;
  clearReferer(jobId: string): Promise<void>;
  heavyRun(job: Job, workers: number): Promise<void>;
  heavyAbort(jobId: string, reason: 'pause' | 'cancel'): Promise<void>;
  heavyRelease(jobId: string): Promise<void>;
  heavyActive(): Promise<string[]>;
  download(url: string, filename: string): Promise<number>;
  saveBlob(url: string, filename: string): Promise<number>;
  downloadPause(id: number): Promise<void>;
  downloadResume(id: number): Promise<void>;
  downloadCancel(id: number): Promise<void>;
  downloadInfo(id: number): Promise<DirectProgress | undefined>;
  notify(job: Job): void;
  publish(job: Job): void;
  publishRemoved(jobId: string): void;
  now(): number;
  newId(): string;
  delay(ms: number): Promise<void>;
  /** Hand an `external` job to the companion app. */
  companionRun(job: Job): Promise<void>;
  /** Stop a companion job; `discard` also removes its partial files. */
  companionStop(jobId: string, discard: boolean): Promise<void>;
}

function isExternal(job: Job): boolean {
  return job.variant.kind === 'external';
}

/**
 * The browser's downloader handles single files, the companion handles external
 * pages, and everything else runs in the worker. A file the CDN will hand over
 * only with the page's Referer starts there: the browser's downloader would be
 * refused, and the refusal can cost the address its signature.
 */
function usesWorker(job: Job): boolean {
  if (isExternal(job)) return false;
  return (
    job.variant.kind !== 'direct' ||
    !!job.variant.audioUrl ||
    !!job.variant.needsReferer ||
    !!job.viaWorker
  );
}

export function codeForDownloadError(error: string | undefined): ErrorCode {
  if (!error) return 'unknown';
  if (error.startsWith('FILE_NO_SPACE') || error.startsWith('FILE_TOO_LARGE')) return 'disk';
  if (error.startsWith('USER_')) return 'canceled';
  if (/^SERVER_(FORBIDDEN|UNAUTHORIZED|BAD_CONTENT)/.test(error)) return 'expired';
  if (/^(NETWORK|SERVER)_/.test(error)) return 'network';
  return 'unknown';
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private lastSaved = new Map<string, number>();
  private lastDirectBytes = new Map<string, { bytes: number; at: number }>();

  constructor(private platform: Platform) {}

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Rebuild state after the service worker restarts. Streaming jobs the worker
   * host no longer knows about go back in the queue; their OPFS files let them
   * resume where they stopped.
   */
  async restore(saved: Job[]): Promise<void> {
    const alive = new Set(await this.platform.heavyActive().catch(() => [] as string[]));
    for (const job of saved) {
      // Finished jobs live on in history, so they need not survive a restart.
      if (job.status === 'done') {
        await this.platform.deleteJob(job.id);
        continue;
      }
      this.jobs.set(job.id, job);
      if (!isRunning(job)) continue;
      if (job.downloadId !== undefined) {
        const info = await this.platform.downloadInfo(job.downloadId);
        if (info) {
          await this.onDownloadChange(job.downloadId, info.state, info.error);
          continue;
        }
      } else if (alive.has(job.id)) continue;
      job.status = 'queued';
      job.downloadId = undefined;
      await this.save(job);
    }
    await this.pump();
  }

  async start(item: MediaInfo, variant: Variant, tabId?: number): Promise<Job> {
    if (item.protected) throw new JobError('protected');
    const settings = await this.platform.settings();
    const id = this.platform.newId();
    const quality = qualityLabel(variant);
    const ext = variant.kind === 'direct' ? fileExtension(variant.url) : 'mp4';
    const job: Job = {
      id,
      mediaId: item.id,
      tabId,
      sourceUrl: variant.url,
      pageUrl: item.pageUrl,
      variant,
      status: 'queued',
      segmentsTotal: 0,
      segmentsDone: 0,
      bytes: 0,
      filename: renderFilename(
        settings.filenameTemplate,
        { title: item.title, site: item.site, quality, id: item.id },
        ext,
        { siteFolder: settings.siteSubfolders },
      ),
      createdAt: this.platform.now(),
      title: item.title,
      site: item.site,
      quality,
    };
    this.jobs.set(id, job);
    await this.save(job);
    await this.pump();
    return job;
  }

  private async save(job: Job): Promise<void> {
    this.lastSaved.set(job.id, this.platform.now());
    await this.platform.saveJob(job);
    this.platform.publish(job);
  }

  private async pump(): Promise<void> {
    const settings = await this.platform.settings();
    for (const job of nextToStart(this.list(), settings.concurrentJobs)) {
      await this.launch(job, settings);
    }
  }

  private async launch(job: Job, settings: Settings): Promise<void> {
    job.status = 'downloading';
    job.error = undefined;
    job.errorCode = undefined;
    await this.save(job);
    try {
      if (isExternal(job)) {
        await this.platform.companionRun(job);
        return;
      }
      await this.platform.setReferer(job.id, [job.variant.url], job.pageUrl);
      if (usesWorker(job)) {
        await this.platform.heavyRun(job, settings.segmentWorkers);
      } else {
        await this.startBrowserDownload(job, settings);
      }
    } catch (err) {
      await this.fail(job, err instanceof JobError ? err.code : 'unknown', String(err));
    }
  }

  /**
   * downloads.download() can stall inside the browser without sending any request,
   * and would leave the job waiting forever. The worker's fetch is not affected.
   */
  private async startBrowserDownload(job: Job, settings: Settings): Promise<void> {
    const started = this.platform.download(job.variant.url, job.filename);
    const id = await Promise.race([started, this.platform.delay(DOWNLOAD_START_MS)]);
    if (id !== undefined) {
      job.downloadId = id;
      await this.save(job);
      return;
    }
    // If the browser's copy starts after all, it would be a second file.
    started.then((late) => this.platform.downloadCancel(late)).catch(() => {});
    if (this.jobs.get(job.id) === job && isRunning(job)) {
      job.viaWorker = true;
      await this.save(job);
      await this.platform.heavyRun(job, settings.segmentWorkers);
    }
  }

  async onHeavyEvent(event: HeavyEvent): Promise<void> {
    if (event.type === 'heavy:progress') return this.onProgress(event.update);
    const job = 'jobId' in event ? this.jobs.get(event.jobId) : undefined;
    if (!job) return;
    if (event.type === 'heavy:hosts') {
      await this.platform.setReferer(job.id, event.hosts.map((host) => `https://${host}/`), job.pageUrl);
    } else if (event.type === 'heavy:failed') {
      // An abort from pause or cancel has already moved the job on.
      if (isRunning(job)) await this.fail(job, event.code ?? 'unknown', event.message);
    } else if (event.type === 'heavy:done') {
      await this.saveOutput(job, event.blobUrl, event.sizeBytes, event.ext);
    }
  }

  async onCompanionEvent(event: CompanionEvent): Promise<void> {
    if (event.type === 'hello') return;
    if (event.type === 'disconnected') {
      const running = this.list().filter((job) => isExternal(job) && isRunning(job));
      for (const job of running) await this.fail(job, 'companion', event.message);
      return;
    }
    const job = this.jobs.get(event.jobId);
    if (!job || !isRunning(job)) return;
    if (event.type === 'progress') {
      await this.onProgress({
        jobId: job.id,
        status: event.stage,
        segmentsDone: event.downloaded,
        segmentsTotal: event.total ?? 0,
        bytes: event.downloaded,
        bytesPerSec: event.speed,
        etaSec: event.eta,
      });
    } else if (event.type === 'done') {
      // yt-dlp names the file from the video's own metadata.
      job.filename = event.file.split(/[\\/]/).pop() ?? job.filename;
      job.bytes = event.size;
      await this.finish(job);
    } else {
      await this.fail(job, 'unknown', event.message);
    }
  }

  /** Jobs the companion is running, so its port can close when there are none. */
  hasCompanionJobs(): boolean {
    return this.list().some((job) => isExternal(job) && isRunning(job));
  }

  private async onProgress(update: ProgressUpdate): Promise<void> {
    const job = this.jobs.get(update.jobId);
    if (!job || !isRunning(job)) return;
    const statusChanged = job.status !== update.status;
    Object.assign(job, update);
    if (statusChanged || this.platform.now() - (this.lastSaved.get(job.id) ?? 0) > PERSIST_MS) {
      await this.save(job);
    } else {
      this.platform.publish(job);
    }
  }

  private async saveOutput(job: Job, blobUrl: string, size: number, ext: string): Promise<void> {
    job.status = 'merging';
    job.bytes = size;
    job.filename = job.filename.replace(/\.[^./]+$/, `.${ext}`);
    try {
      job.downloadId = await this.platform.saveBlob(blobUrl, job.filename);
      await this.save(job);
    } catch (err) {
      await this.fail(job, 'disk', String(err));
    }
  }

  /** Feed `downloads.onChanged` here; ids that are not ours are ignored. */
  async onDownloadChange(
    downloadId: number,
    state: DownloadState | undefined,
    error?: string,
  ): Promise<void> {
    const job = this.list().find((entry) => entry.downloadId === downloadId);
    if (!job || !isRunning(job)) return;
    if (state === 'complete') await this.finish(job);
    else if (state === 'interrupted') {
      const code = codeForDownloadError(error);
      if (code === 'expired' && !usesWorker(job)) return this.fallBackToWorker(job);
      await this.fail(job, code, error ?? 'Download interrupted');
    }
  }

  /**
   * Declarative rules never reach the browser's downloader, so a CDN that wants
   * a Referer refuses it. The worker's fetch is covered by those rules.
   */
  private async fallBackToWorker(job: Job): Promise<void> {
    const settings = await this.platform.settings();
    job.viaWorker = true;
    job.downloadId = undefined;
    await this.save(job);
    await this.platform.heavyRun(job, settings.segmentWorkers);
  }

  /** Poll progress of direct downloads; the browser pushes no byte counts. */
  async tick(): Promise<boolean> {
    const direct = this.list().filter(
      (job) => job.status === 'downloading' && job.downloadId !== undefined,
    );
    for (const job of direct) {
      const info = await this.platform.downloadInfo(job.downloadId!);
      if (!info) continue;
      const now = this.platform.now();
      const previous = this.lastDirectBytes.get(job.id);
      job.bytes = info.bytesReceived;
      job.segmentsDone = info.bytesReceived;
      job.segmentsTotal = Math.max(info.totalBytes, 0);
      if (previous && now > previous.at) {
        job.bytesPerSec = ((info.bytesReceived - previous.bytes) / (now - previous.at)) * 1000;
        const left = info.totalBytes - info.bytesReceived;
        job.etaSec = job.bytesPerSec > 0 && info.totalBytes > 0 ? left / job.bytesPerSec : undefined;
      }
      this.lastDirectBytes.set(job.id, { bytes: info.bytesReceived, at: now });
      this.platform.publish(job);
    }
    return direct.length > 0;
  }

  private async cleanup(job: Job): Promise<void> {
    this.lastDirectBytes.delete(job.id);
    await this.platform.clearReferer(job.id);
    if (usesWorker(job)) await this.platform.heavyRelease(job.id).catch(() => {});
  }

  private history(job: Job, status: HistoryEntry['status']): HistoryEntry {
    return {
      jobId: job.id,
      title: job.title,
      site: job.site,
      filename: job.filename,
      sizeBytes: job.bytes,
      downloadId: job.downloadId,
      finishedAt: job.finishedAt ?? this.platform.now(),
      status,
      sourceUrl: job.sourceUrl,
      pageUrl: job.pageUrl,
      variant: job.variant,
      quality: job.quality,
      errorCode: job.errorCode,
    };
  }

  private async finish(job: Job): Promise<void> {
    job.status = 'done';
    job.finishedAt = this.platform.now();
    job.etaSec = undefined;
    job.bytesPerSec = undefined;
    await this.save(job);
    await this.cleanup(job);
    await this.platform.removeWorkDir(job.id);
    await this.platform.addHistory(this.history(job, 'done'));
    this.platform.notify(job);
    await this.pump();
  }

  private async fail(job: Job, code: ErrorCode, message: string): Promise<void> {
    job.status = 'failed';
    job.errorCode = code;
    job.error = message;
    job.finishedAt = this.platform.now();
    job.etaSec = undefined;
    job.bytesPerSec = undefined;
    await this.save(job);
    await this.cleanup(job);
    // Segments stay on disk so Retry can resume, except when they are the problem.
    if (code === 'protected' || code === 'disk') await this.platform.removeWorkDir(job.id);
    await this.platform.addHistory(this.history(job, 'failed'));
    this.platform.notify(job);
    await this.pump();
  }

  async pause(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job?.status === 'queued') {
      job.status = 'paused';
      await this.save(job);
      return;
    }
    // A merge cannot stop partway, and it is about to finish on its own.
    if (job?.status !== 'downloading') return;
    job.status = 'paused';
    job.bytesPerSec = undefined;
    job.etaSec = undefined;
    await this.save(job);
    // yt-dlp keeps its .part files, so starting it again resumes the download.
    if (isExternal(job)) {
      await this.platform.companionStop(id, false);
    } else if (!usesWorker(job) && job.downloadId !== undefined) {
      await this.platform.downloadPause(job.downloadId);
    } else {
      await this.platform.heavyAbort(id, 'pause');
    }
    await this.pump();
  }

  async resume(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job?.status !== 'paused') return;
    if (!usesWorker(job) && job.downloadId !== undefined) {
      try {
        await this.platform.downloadResume(job.downloadId);
        job.status = 'downloading';
        await this.save(job);
        return;
      } catch {
        job.downloadId = undefined; // The browser dropped it; start over.
      }
    }
    job.status = 'queued';
    await this.save(job);
    await this.pump();
  }

  async retry(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job?.status !== 'failed') return;
    job.status = 'queued';
    job.downloadId = undefined;
    job.finishedAt = undefined;
    await this.save(job);
    await this.pump();
  }

  /** Stop a job if needed and forget it, along with its partial files. */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const wasRunning = isRunning(job);
    this.jobs.delete(id);
    if (isExternal(job)) {
      await this.platform.companionStop(id, true).catch(() => {});
    } else if (wasRunning || job.status === 'paused') {
      if (job.downloadId !== undefined) await this.platform.downloadCancel(job.downloadId).catch(() => {});
      else await this.platform.heavyAbort(id, 'cancel').catch(() => {});
    }
    await this.cleanup(job);
    // Anything left behind is swept at the next startup.
    await this.platform.removeWorkDir(id).catch(() => {});
    await this.platform.deleteJob(id);
    this.platform.publishRemoved(id);
    await this.pump();
  }
}
