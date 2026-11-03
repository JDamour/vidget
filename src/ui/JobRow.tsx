import { FolderOpen, Pause, Play, RotateCcw, X } from 'lucide-preact';
import { formatBytes, formatDuration } from '@/src/shared/format';
import type { UiMessage } from '@/src/shared/messages';
import { request } from '@/src/shared/messaging';
import type { Job } from '@/src/shared/types';
import { errorText, t } from './i18n';
import { sendJob } from './useJobs';

const STATUS_KEYS: Record<Job['status'], string> = {
  queued: 'statusQueued',
  downloading: 'statusDownloading',
  merging: 'statusMerging',
  done: 'statusDone',
  failed: 'statusFailed',
  paused: 'statusPaused',
};

function percent(job: Job): number | undefined {
  if (!job.segmentsTotal) return undefined;
  return Math.min(100, Math.round((job.segmentsDone / job.segmentsTotal) * 100));
}

function detail(job: Job): string {
  if (job.status === 'failed') return errorText(job.errorCode);
  if (job.status !== 'downloading' && job.status !== 'paused') {
    return job.status === 'done' ? formatBytes(job.bytes) : '';
  }
  const parts: string[] = [];
  const value = percent(job);
  if (value !== undefined) parts.push(`${value}%`);
  if (job.bytesPerSec) parts.push(`${formatBytes(job.bytesPerSec)}/s`);
  if (job.etaSec) parts.push(t('etaLeft', formatDuration(job.etaSec)));
  if ((job.variant.kind === 'hls' || job.variant.kind === 'dash') && job.segmentsTotal) {
    parts.push(t('segmentsProgress', String(job.segmentsDone), String(job.segmentsTotal)));
  }
  return parts.join(' · ');
}

export function JobRow({ job }: { job: Job }) {
  const value = percent(job);
  const active = job.status === 'downloading' || job.status === 'paused';
  return (
    <li class="flex flex-col gap-1 py-2" data-testid="job" data-status={job.status}>
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium" title={job.title}>
            {job.title}
          </p>
          <p
            class={`truncate text-xs ${job.status === 'failed' ? 'text-danger' : 'text-muted'}`}
            title={job.status === 'failed' ? job.error : undefined}
          >
            {t(STATUS_KEYS[job.status])} · {job.quality}
            {detail(job) ? ` · ${detail(job)}` : ''}
          </p>
        </div>
        {job.status === 'downloading' && (
          <button class="btn btn-icon" aria-label={t('actionPause')} title={t('actionPause')} onClick={() => sendJob('job:pause', job.id)}>
            <Pause size={16} aria-hidden />
          </button>
        )}
        {job.status === 'paused' && (
          <button class="btn btn-icon" aria-label={t('actionResume')} title={t('actionResume')} onClick={() => sendJob('job:resume', job.id)}>
            <Play size={16} aria-hidden />
          </button>
        )}
        {job.status === 'failed' && job.errorCode !== 'protected' && (
          <button class="btn btn-icon" aria-label={t('actionRetry')} title={t('actionRetry')} onClick={() => sendJob('job:retry', job.id)}>
            <RotateCcw size={16} aria-hidden />
          </button>
        )}
        {job.status === 'done' && job.downloadId !== undefined && (
          <button
            class="btn btn-icon"
            aria-label={t('actionShowFolder')}
            title={t('actionShowFolder')}
            onClick={() =>
              request({ type: 'history:show', downloadId: job.downloadId! } satisfies UiMessage)
            }
          >
            <FolderOpen size={16} aria-hidden />
          </button>
        )}
        <button class="btn btn-icon" aria-label={t('actionCancel')} title={t('actionCancel')} onClick={() => sendJob('job:cancel', job.id)}>
          <X size={16} aria-hidden />
        </button>
      </div>
      {active && (
        <div
          class="progress"
          role="progressbar"
          aria-label={job.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
        >
          <div style={{ width: `${value ?? 0}%` }} />
        </div>
      )}
      {job.status === 'merging' && (
        <div class="progress progress-indeterminate" role="progressbar" aria-label={job.title}>
          <div />
        </div>
      )}
    </li>
  );
}
