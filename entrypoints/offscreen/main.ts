import { browser } from 'wxt/browser';
import { parseManifest } from '@/src/media/manifest';
import { runJob } from '@/src/media/runner';
import { toJobError } from '@/src/shared/errors';
import type { HeavyEvent, HeavyRequest, TrackPlan } from '@/src/shared/messages';
import { listen, request } from '@/src/shared/messaging';

const running = new Map<string, { controller: AbortController; finished: Promise<void> }>();
const blobUrls = new Map<string, string>();

function emit(event: HeavyEvent) {
  browser.runtime.sendMessage(event).catch(() => {
    // The service worker wakes on the next message; progress is safe to lose.
  });
}

async function run(plan: TrackPlan, controller: AbortController) {
  const { jobId } = plan;
  try {
    const { file, ext } = await runJob(
      plan,
      {
        progress: (update) => emit({ target: 'background', type: 'heavy:progress', update }),
        hosts: (hosts) =>
          request<void>({ target: 'background', type: 'heavy:hosts', jobId, hosts }),
      },
      controller.signal,
    );
    const blobUrl = URL.createObjectURL(file);
    blobUrls.set(jobId, blobUrl);
    emit({
      target: 'background',
      type: 'heavy:done',
      jobId,
      blobUrl,
      sizeBytes: file.size,
      ext,
    });
  } catch (err) {
    const failure = toJobError(err);
    emit({
      target: 'background',
      type: 'heavy:failed',
      jobId,
      code: failure.code,
      message: failure.message,
    });
  }
}

function start(plan: TrackPlan) {
  const controller = new AbortController();
  const finished = run(plan, controller).finally(() => running.delete(plan.jobId));
  running.set(plan.jobId, { controller, finished });
}

function save(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Resolves once the job has stopped, so its folder is free to delete. */
async function abort(jobId: string, reason: string) {
  const job = running.get(jobId);
  if (!job) return true;
  job.controller.abort(new DOMException(reason, 'AbortError'));
  await job.finished;
  return true;
}

listen((message: HeavyRequest) => {
  if (message.target !== 'heavy') return undefined;
  switch (message.type) {
    case 'parse':
      return parseManifest(message.url, message.kind);
    case 'run':
      start(message.plan);
      return true;
    case 'abort':
      return abort(message.jobId, message.reason);
    case 'release': {
      const url = blobUrls.get(message.jobId);
      if (url) URL.revokeObjectURL(url);
      blobUrls.delete(message.jobId);
      return true;
    }
    case 'save':
      save(message.url, message.filename);
      return true;
    case 'active':
      return [...running.keys(), ...blobUrls.keys()];
  }
});
