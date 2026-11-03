import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codeForDownloadError, JobManager, type Platform } from '@/src/queue/manager';
import { nextToStart, pickVariant } from '@/src/queue/scheduler';
import { DEFAULT_SETTINGS } from '@/src/shared/settings';
import type { Job, MediaInfo, Variant } from '@/src/shared/types';

const hls = (height: number): Variant => ({
  id: `v${height}`,
  kind: 'hls',
  url: `https://a.com/${height}.m3u8`,
  height,
});
const direct: Variant = { id: 'direct', kind: 'direct', url: 'https://a.com/talk.webm' };

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    id: 'm1',
    key: 'k',
    title: 'My: talk',
    site: 'a.com',
    protected: false,
    variants: [hls(1080), hls(720)],
    status: 'ready',
    pageUrl: 'https://a.com/page',
    source: 'network',
    ...overrides,
  };
}

function fakePlatform() {
  let now = 1000;
  let nextId = 0;
  let nextDownload = 100;
  const platform = {
    settings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, concurrentJobs: 2 })),
    saveJob: vi.fn(async () => {}),
    deleteJob: vi.fn(async () => {}),
    addHistory: vi.fn(async () => {}),
    removeWorkDir: vi.fn(async () => {}),
    setReferer: vi.fn(async () => {}),
    clearReferer: vi.fn(async () => {}),
    heavyRun: vi.fn(async () => {}),
    heavyAbort: vi.fn(async () => {}),
    heavyRelease: vi.fn(async () => {}),
    heavyActive: vi.fn(async () => [] as string[]),
    download: vi.fn(async () => nextDownload++),
    saveBlob: vi.fn(async () => nextDownload++),
    downloadPause: vi.fn(async () => {}),
    downloadResume: vi.fn(async () => {}),
    downloadCancel: vi.fn(async () => {}),
    downloadInfo: vi.fn(async () => undefined),
    notify: vi.fn(),
    publish: vi.fn(),
    publishRemoved: vi.fn(),
    now: () => (now += 1),
    newId: () => `job${++nextId}`,
    delay: vi.fn(() => new Promise<void>(() => {})),
    companionRun: vi.fn(async () => {}),
    companionStop: vi.fn(async () => {}),
  } satisfies Platform;
  return platform;
}

describe('scheduler', () => {
  const job = (id: string, status: Job['status'], createdAt: number) =>
    ({ id, status, createdAt }) as Job;

  it('fills free slots oldest first', () => {
    const jobs = [job('c', 'queued', 3), job('a', 'queued', 1), job('b', 'queued', 2)];
    expect(nextToStart(jobs, 2).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('counts running jobs against the limit', () => {
    const jobs = [job('a', 'downloading', 1), job('b', 'merging', 2), job('c', 'queued', 3)];
    expect(nextToStart(jobs, 2)).toEqual([]);
    expect(nextToStart(jobs, 3).map((entry) => entry.id)).toEqual(['c']);
  });

  it('picks the tallest variant within the cap', () => {
    const item = media({ variants: [hls(2160), hls(1080), hls(720), hls(360)] });
    expect(pickVariant(item, 'best')?.height).toBe(2160);
    expect(pickVariant(item, '1080')?.height).toBe(1080);
    expect(pickVariant(item, '480')?.height).toBe(360);
    expect(pickVariant(media({ variants: [hls(1080), hls(720)] }), '480')?.height).toBe(720);
  });

  it('skips variants that need ffmpeg when another exists', () => {
    const item = media({ variants: [{ ...hls(2160), needsFfmpeg: true }, hls(720)] });
    expect(pickVariant(item, 'best')?.height).toBe(720);
  });
});

describe('codeForDownloadError', () => {
  it('maps browser errors to reasons', () => {
    expect(codeForDownloadError('FILE_NO_SPACE')).toBe('disk');
    expect(codeForDownloadError('NETWORK_FAILED')).toBe('network');
    expect(codeForDownloadError('SERVER_FORBIDDEN')).toBe('expired');
    expect(codeForDownloadError('USER_CANCELED')).toBe('canceled');
  });
});

describe('JobManager', () => {
  let platform: ReturnType<typeof fakePlatform>;
  let manager: JobManager;

  beforeEach(() => {
    platform = fakePlatform();
    manager = new JobManager(platform);
  });

  it('refuses protected media, whatever the UI did', async () => {
    await expect(manager.start(media({ protected: true }), hls(720))).rejects.toMatchObject({
      code: 'protected',
    });
    expect(platform.heavyRun).not.toHaveBeenCalled();
    expect(platform.download).not.toHaveBeenCalled();
  });

  it('sanitizes the filename from the template', async () => {
    const job = await manager.start(media(), hls(720));
    expect(job.filename).toBe('My talk (720p).mp4');
  });

  it('honors the concurrency limit, then pumps the queue', async () => {
    const a = await manager.start(media(), hls(720));
    await manager.start(media(), hls(720));
    const c = await manager.start(media(), hls(720));
    expect(platform.heavyRun).toHaveBeenCalledTimes(2);
    expect(manager.get(c.id)?.status).toBe('queued');

    await manager.onHeavyEvent({
      target: 'background',
      type: 'heavy:done',
      jobId: a.id,
      blobUrl: 'blob:x',
      sizeBytes: 500,
      ext: 'mp4',
    });
    await manager.onDownloadChange(manager.get(a.id)!.downloadId!, 'complete');
    expect(manager.get(a.id)?.status).toBe('done');
    expect(manager.get(c.id)?.status).toBe('downloading');
  });

  it('saves a stream, cleans up and records history', async () => {
    const job = await manager.start(media(), hls(720));
    await manager.onHeavyEvent({
      target: 'background',
      type: 'heavy:done',
      jobId: job.id,
      blobUrl: 'blob:x',
      sizeBytes: 500,
      ext: 'webm',
    });
    expect(platform.saveBlob).toHaveBeenCalledWith('blob:x', 'My talk (720p).webm');
    await manager.onDownloadChange(manager.get(job.id)!.downloadId!, 'complete');
    expect(platform.heavyRelease).toHaveBeenCalledWith(job.id);
    expect(platform.removeWorkDir).toHaveBeenCalledWith(job.id);
    expect(platform.clearReferer).toHaveBeenCalledWith(job.id);
    expect(platform.addHistory).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done', sizeBytes: 500, filename: 'My talk (720p).webm' }),
    );
  });

  it('hands direct files to the browser with their own extension', async () => {
    const job = await manager.start(media({ variants: [direct] }), direct);
    expect(job.filename).toMatch(/\.webm$/);
    expect(platform.download).toHaveBeenCalledWith(direct.url, job.filename);
    expect(platform.heavyRun).not.toHaveBeenCalled();
    await manager.onDownloadChange(job.downloadId!, 'interrupted', 'NETWORK_FAILED');
    expect(manager.get(job.id)).toMatchObject({ status: 'failed', errorCode: 'network' });
  });

  it('falls back to the worker when the browser downloader is refused', async () => {
    const job = await manager.start(media({ variants: [direct] }), direct);
    await manager.onDownloadChange(job.downloadId!, 'interrupted', 'SERVER_FORBIDDEN');
    expect(manager.get(job.id)).toMatchObject({ status: 'downloading', viaWorker: true });
    expect(platform.heavyRun).toHaveBeenCalledTimes(1);
    await manager.onHeavyEvent({
      target: 'background',
      type: 'heavy:failed',
      jobId: job.id,
      code: 'expired',
      message: 'HTTP 403',
    });
    expect(manager.get(job.id)).toMatchObject({ status: 'failed', errorCode: 'expired' });
  });

  it('never hands a Referer-gated file to the browser downloader', async () => {
    const gated: Variant = {
      id: 'tiktok-576',
      kind: 'direct',
      url: 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/x/oAVC1/',
      needsReferer: true,
    };
    await manager.start(media({ variants: [gated] }), gated);
    expect(platform.download).not.toHaveBeenCalled();
    expect(platform.heavyRun).toHaveBeenCalledTimes(1);
    expect(platform.setReferer).toHaveBeenCalledWith(
      expect.any(String),
      [gated.url],
      'https://a.com/page',
    );
  });

  it('moves to the worker when the browser never starts a download', async () => {
    let lateStart: (id: number) => void = () => {};
    platform.download.mockReturnValueOnce(new Promise((resolve) => (lateStart = resolve)));
    platform.delay.mockResolvedValueOnce(undefined);
    const job = await manager.start(media({ variants: [direct] }), direct);
    expect(manager.get(job.id)).toMatchObject({ status: 'downloading', viaWorker: true });
    expect(platform.heavyRun).toHaveBeenCalledTimes(1);

    lateStart(555);
    await vi.waitFor(() => expect(platform.downloadCancel).toHaveBeenCalledWith(555));
    expect(manager.get(job.id)?.downloadId).toBeUndefined();
  });

  it('does not revive a job canceled while the browser stalled', async () => {
    let timedOut: () => void = () => {};
    platform.download.mockReturnValueOnce(new Promise(() => {}));
    platform.delay.mockReturnValueOnce(new Promise((resolve) => (timedOut = resolve)));
    const starting = manager.start(media({ variants: [direct] }), direct);
    await vi.waitFor(() => expect(platform.delay).toHaveBeenCalled());
    await manager.cancel(manager.list()[0]!.id);
    timedOut();
    await starting;
    expect(platform.heavyRun).not.toHaveBeenCalled();
  });

  describe('companion jobs', () => {
    const page: Variant = { id: 'yt-dlp', kind: 'external', url: 'https://www.youtube.com/watch?v=abc' };
    const start = () => manager.start(media({ variants: [page] }), page);

    it('hand the page to the companion and nothing else', async () => {
      const job = await start();
      expect(platform.companionRun).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
      expect(platform.setReferer).not.toHaveBeenCalled();
      expect(platform.heavyRun).not.toHaveBeenCalled();
      expect(platform.download).not.toHaveBeenCalled();
      expect(manager.get(job.id)?.status).toBe('downloading');
    });

    it('show progress, then finish under the name yt-dlp chose', async () => {
      const job = await start();
      await manager.onCompanionEvent({ type: 'progress', jobId: job.id, stage: 'downloading', downloaded: 50, total: 200, speed: 10, eta: 15 });
      expect(manager.get(job.id)).toMatchObject({ segmentsDone: 50, segmentsTotal: 200, bytesPerSec: 10, etaSec: 15 });
      await manager.onCompanionEvent({ type: 'progress', jobId: job.id, stage: 'merging', downloaded: 200, total: 200 });
      expect(manager.get(job.id)?.status).toBe('merging');
      await manager.onCompanionEvent({ type: 'done', jobId: job.id, file: 'C:\\Users\\me\\Downloads\\A talk [abc].mp4', size: 200 });
      expect(manager.get(job.id)).toMatchObject({ status: 'done', filename: 'A talk [abc].mp4', bytes: 200 });
      expect(platform.addHistory).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', filename: 'A talk [abc].mp4' }));
      expect(platform.heavyRelease).not.toHaveBeenCalled();
    });

    it('keep the message yt-dlp gave when it fails', async () => {
      const job = await start();
      await manager.onCompanionEvent({ type: 'failed', jobId: job.id, message: 'Sign in to confirm' });
      expect(manager.get(job.id)).toMatchObject({ status: 'failed', errorCode: 'unknown', error: 'Sign in to confirm' });
    });

    it('fail with a companion error when the app is missing or stops', async () => {
      const job = await start();
      await manager.onCompanionEvent({ type: 'disconnected', message: 'The Vidget companion is not installed' });
      expect(manager.get(job.id)).toMatchObject({ status: 'failed', errorCode: 'companion' });
      expect(manager.hasCompanionJobs()).toBe(false);
    });

    it('pause by stopping yt-dlp, resume by starting it again, cancel by discarding', async () => {
      const job = await start();
      await manager.pause(job.id);
      expect(platform.companionStop).toHaveBeenLastCalledWith(job.id, false);
      expect(platform.heavyAbort).not.toHaveBeenCalled();
      await manager.resume(job.id);
      expect(platform.companionRun).toHaveBeenCalledTimes(2);
      await manager.cancel(job.id);
      expect(platform.companionStop).toHaveBeenLastCalledWith(job.id, true);
      expect(manager.get(job.id)).toBeUndefined();
    });

    it('ignore news about jobs that are no longer running', async () => {
      const job = await start();
      await manager.pause(job.id);
      await manager.onCompanionEvent({ type: 'failed', jobId: job.id, message: 'killed' });
      expect(manager.get(job.id)?.status).toBe('paused');
    });
  });

  it('ignores downloads it did not start', async () => {
    await manager.onDownloadChange(999, 'complete');
    expect(platform.addHistory).not.toHaveBeenCalled();
  });

  it('pauses and resumes a stream through the queue', async () => {
    const job = await manager.start(media(), hls(720));
    await manager.pause(job.id);
    expect(platform.heavyAbort).toHaveBeenCalledWith(job.id, 'pause');
    expect(manager.get(job.id)?.status).toBe('paused');

    // The aborted run reports a failure; a paused job must not take it.
    await manager.onHeavyEvent({
      target: 'background',
      type: 'heavy:failed',
      jobId: job.id,
      code: 'canceled',
      message: 'pause',
    });
    expect(manager.get(job.id)?.status).toBe('paused');
    expect(platform.removeWorkDir).not.toHaveBeenCalled();

    await manager.resume(job.id);
    expect(manager.get(job.id)?.status).toBe('downloading');
    expect(platform.heavyRun).toHaveBeenCalledTimes(2);
  });

  it('does not pause during a merge', async () => {
    const job = await manager.start(media(), hls(720));
    await manager.onHeavyEvent({
      target: 'background',
      type: 'heavy:progress',
      update: { jobId: job.id, status: 'merging', segmentsDone: 3, segmentsTotal: 3, bytes: 10 },
    });
    await manager.pause(job.id);
    expect(manager.get(job.id)?.status).toBe('merging');
  });

  it('cancels, removing partial files', async () => {
    const job = await manager.start(media(), hls(720));
    await manager.cancel(job.id);
    expect(platform.heavyAbort).toHaveBeenCalledWith(job.id, 'cancel');
    expect(platform.removeWorkDir).toHaveBeenCalledWith(job.id);
    expect(platform.deleteJob).toHaveBeenCalledWith(job.id);
    expect(platform.publishRemoved).toHaveBeenCalledWith(job.id);
    expect(manager.get(job.id)).toBeUndefined();
  });

  it('still forgets a canceled job when its folder cannot be deleted', async () => {
    const job = await manager.start(media(), hls(720));
    platform.removeWorkDir.mockRejectedValueOnce(new Error('locked'));
    await manager.cancel(job.id);
    expect(platform.publishRemoved).toHaveBeenCalledWith(job.id);
  });

  it('keeps segments for retry unless the job can never succeed', async () => {
    const job = await manager.start(media(), hls(720));
    await manager.onHeavyEvent({
      target: 'background',
      type: 'heavy:failed',
      jobId: job.id,
      code: 'network',
      message: 'x',
    });
    expect(platform.removeWorkDir).not.toHaveBeenCalled();
    await manager.retry(job.id);
    expect(manager.get(job.id)?.status).toBe('downloading');

    await manager.onHeavyEvent({
      target: 'background',
      type: 'heavy:failed',
      jobId: job.id,
      code: 'protected',
      message: 'x',
    });
    expect(platform.removeWorkDir).toHaveBeenCalledWith(job.id);
  });

  it('restarts streams the worker lost, and leaves live ones alone', async () => {
    const base = { variant: hls(720), status: 'downloading', createdAt: 1 } as Job;
    platform.heavyActive.mockResolvedValue(['alive']);
    await manager.restore([
      { ...base, id: 'alive' },
      { ...base, id: 'lost', createdAt: 2 },
      { ...base, id: 'finished', status: 'done' },
    ]);
    expect(manager.get('alive')?.status).toBe('downloading');
    expect(platform.heavyRun).toHaveBeenCalledTimes(1);
    expect(manager.get('lost')?.status).toBe('downloading');
    expect(manager.get('finished')).toBeUndefined();
    expect(platform.deleteJob).toHaveBeenCalledWith('finished');
  });
});
