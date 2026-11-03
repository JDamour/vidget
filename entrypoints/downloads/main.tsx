import { render } from 'preact';
import { Copy, FolderOpen, RotateCcw } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatBytes } from '@/src/shared/format';
import type { UiMessage } from '@/src/shared/messages';
import { request } from '@/src/shared/messaging';
import type { HistoryEntry } from '@/src/shared/types';
import { errorText, t } from '@/src/ui/i18n';
import { JobRow } from '@/src/ui/JobRow';
import '@/src/ui/style.css';
import { useJobs } from '@/src/ui/useJobs';

const DAY_MS = 86_400_000;

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const failed = entry.status === 'failed';
  return (
    <li class="flex items-center gap-2 py-2" data-testid="history-row">
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium" title={entry.filename}>
          {entry.title}
        </p>
        <p class={`truncate text-xs ${failed ? 'text-danger' : 'text-muted'}`}>
          {new Date(entry.finishedAt).toLocaleString()} · {entry.site} ·{' '}
          {failed ? errorText(entry.errorCode) : formatBytes(entry.sizeBytes)}
        </p>
      </div>
      {!failed && entry.downloadId !== undefined && (
        <button
          class="btn btn-icon"
          aria-label={t('actionShowFolder')}
          title={t('actionShowFolder')}
          onClick={() =>
            request({ type: 'history:show', downloadId: entry.downloadId! } satisfies UiMessage)
          }
        >
          <FolderOpen size={16} aria-hidden />
        </button>
      )}
      <button
        class="btn btn-icon"
        aria-label={t('actionRetry')}
        title={t('actionRetry')}
        onClick={() => request({ type: 'history:retry', jobId: entry.jobId } satisfies UiMessage)}
      >
        <RotateCcw size={16} aria-hidden />
      </button>
      <button
        class="btn btn-icon"
        aria-label={t('actionCopyUrl')}
        title={t('actionCopyUrl')}
        onClick={() => navigator.clipboard.writeText(entry.sourceUrl)}
      >
        <Copy size={16} aria-hidden />
      </button>
    </li>
  );
}

function App() {
  const { jobs } = useJobs();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [site, setSite] = useState('');
  const [status, setStatus] = useState('');
  const [days, setDays] = useState(0);

  const finished = jobs.filter((job) => job.status === 'done' || job.status === 'failed').length;
  useEffect(() => {
    void request<HistoryEntry[]>({ type: 'history:list' } satisfies UiMessage).then(setHistory);
  }, [finished]);

  const sites = useMemo(() => [...new Set(history.map((entry) => entry.site))].sort(), [history]);
  const needle = query.trim().toLowerCase();
  const cutoff = days ? Date.now() - days * DAY_MS : 0;
  const rows = history.filter(
    (entry) =>
      (!needle || `${entry.title} ${entry.filename}`.toLowerCase().includes(needle)) &&
      (!site || entry.site === site) &&
      (!status || entry.status === status) &&
      entry.finishedAt >= cutoff,
  );
  const queue = jobs.filter((job) => job.status !== 'done' && job.status !== 'failed');

  const clear = async () => {
    await request({ type: 'history:clear' } satisfies UiMessage);
    setHistory([]);
  };

  return (
    <div class="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 class="text-xl font-semibold">{t('downloadsTitle')}</h1>

      <section aria-labelledby="queue-heading">
        <h2 id="queue-heading" class="font-semibold">
          {t('downloadsQueue')}
        </h2>
        {queue.length ? (
          <ul class="divide-y divide-border">
            {queue.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        ) : (
          <p class="py-3 text-muted">{t('downloadsEmptyQueue')}</p>
        )}
      </section>

      <section aria-labelledby="history-heading" class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <h2 id="history-heading" class="font-semibold">
            {t('downloadsHistory')}
          </h2>
          <button class="btn" onClick={clear} disabled={!history.length}>
            {t('actionClearHistory')}
          </button>
        </div>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
          <input
            type="search"
            class="field"
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <select class="field" aria-label={t('filterSite')} value={site} onChange={(event) => setSite(event.currentTarget.value)}>
            <option value="">{t('filterSite')}</option>
            {sites.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select class="field" aria-label={t('filterStatus')} value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            <option value="">{t('filterStatus')}</option>
            <option value="done">{t('statusDone')}</option>
            <option value="failed">{t('statusFailed')}</option>
          </select>
          <select
            class="field"
            aria-label={t('filterDate')}
            value={days}
            onChange={(event) => setDays(Number(event.currentTarget.value))}
          >
            <option value={0}>{t('filterDate')}</option>
            <option value={1}>{t('filterToday')}</option>
            <option value={7}>{t('filterWeek')}</option>
            <option value={30}>{t('filterMonth')}</option>
          </select>
        </div>
        {rows.length ? (
          <ul class="divide-y divide-border">
            {rows.map((entry) => (
              <HistoryRow key={entry.jobId} entry={entry} />
            ))}
          </ul>
        ) : (
          <p class="py-3 text-muted">{t('downloadsEmptyHistory')}</p>
        )}
      </section>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
