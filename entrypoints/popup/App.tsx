import { Download, List, Lock, Settings as SettingsIcon } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { pickVariant } from '@/src/queue/scheduler';
import { formatBytes, formatDuration, qualityLabel } from '@/src/shared/format';
import type { UiMessage } from '@/src/shared/messages';
import { request } from '@/src/shared/messaging';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '@/src/shared/settings';
import type { MediaInfo, TabState } from '@/src/shared/types';
import { t } from '@/src/ui/i18n';
import { JobRow } from '@/src/ui/JobRow';
import { useJobs } from '@/src/ui/useJobs';

type TabView = TabState & { tabId: number; blocked?: boolean };

const HOST_ACCESS = '*://*/*';

/** Lets the E2E suite open this page in a tab and point it at another tab. */
const forcedTabId = Number(new URLSearchParams(location.search).get('tabId')) || undefined;

function MediaRow({ item, settings, tabId }: { item: MediaInfo; settings: Settings; tabId: number }) {
  const initial = pickVariant(item, settings.defaultQuality);
  const [variantId, setVariantId] = useState(initial?.id);
  const variant = item.variants.find((entry) => entry.id === variantId) ?? initial;
  const blocked = item.protected || item.status !== 'ready' || !variant;
  const size = formatBytes(variant?.sizeEstimate ?? item.sizeBytes);

  const facts = [formatDuration(item.durationSec), item.site, size].filter(Boolean).join(' · ');

  return (
    <li class={`flex gap-2 py-2 ${item.protected ? 'opacity-70' : ''}`} data-testid="media">
      <div class="h-[54px] w-24 shrink-0 overflow-hidden rounded bg-raised">
        {item.thumbnail && <img src={item.thumbnail} alt="" class="h-full w-full object-cover" />}
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <p class="truncate font-medium" title={item.title}>
          {item.title}
        </p>
        <p class="truncate text-xs text-muted">{facts}</p>
        {item.protected ? (
          <p class="flex items-center gap-1 text-xs text-muted" title={t('statusProtectedHint')} data-testid="protected">
            <Lock size={12} aria-hidden /> {t('statusProtected')}
          </p>
        ) : item.status === 'live' ? (
          <p class="text-xs text-muted">{t('statusLive')}</p>
        ) : item.status === 'parsing' ? (
          <p class="text-xs text-muted">{t('statusParsing')}</p>
        ) : (
          <div class="flex items-center gap-2">
            {item.variants.length > 1 && (
              <select
                class="field min-w-0 flex-1 py-1"
                aria-label={t('qualityLabel')}
                value={variantId}
                onChange={(event) => setVariantId(event.currentTarget.value)}
              >
                {item.variants.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {qualityLabel(entry)}
                  </option>
                ))}
              </select>
            )}
            <button
              class="btn btn-primary ml-auto py-1"
              disabled={blocked}
              data-testid="download"
              aria-label={`${t('actionDownload')}: ${item.title}`}
              onClick={() =>
                request({
                  type: 'job:start',
                  mediaId: item.id,
                  tabId,
                  variantId: variant?.id,
                } satisfies UiMessage)
              }
            >
              <Download size={14} aria-hidden /> {t('actionDownload')}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function App() {
  const { jobs, tabChange } = useJobs(':popup');
  const [view, setView] = useState<TabView>();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hasAccess, setHasAccess] = useState(true);

  const refresh = () =>
    request<TabView | undefined>({ type: 'tab:get', tabId: forcedTabId } satisfies UiMessage).then(setView);

  useEffect(() => {
    void refresh();
    void loadSettings().then(setSettings);
    void browser.permissions.contains({ origins: [HOST_ACCESS] }).then(setHasAccess);
  }, []);

  useEffect(() => {
    if (view && tabChange.tabId === view.tabId) void refresh();
  }, [tabChange]);

  const grantAccess = async () => {
    const granted = await browser.permissions.request({ origins: [HOST_ACCESS] });
    // Chrome often closes the popup for its prompt, so the service worker does the
    // real work in permissions.onAdded. This only runs if the popup survived.
    setHasAccess(granted);
    if (granted) await refresh();
  };

  const items = view?.items ?? [];
  const visibleJobs = jobs.filter((job) => job.status !== 'done' || job.tabId === view?.tabId);

  return (
    <div class="flex max-h-[600px] w-[380px] flex-col">
      <header class="flex items-center gap-2 border-b border-border px-3 py-2">
        <img src="/icon/32.png" alt="" class="h-5 w-5" />
        <h1 class="flex-1 text-sm font-semibold">Vidget</h1>
        <button
          class="btn btn-icon"
          aria-label={t('popupSettings')}
          title={t('popupSettings')}
          onClick={() => browser.runtime.openOptionsPage()}
        >
          <SettingsIcon size={16} aria-hidden />
        </button>
      </header>

      <main class="scroll-thin min-h-0 flex-1 overflow-y-auto px-3">
        {!settings.rightsAccepted && (
          <section class="my-2 rounded bg-raised p-2 text-xs" data-testid="rights">
            <p>{t('rightsNotice')}</p>
            <button
              class="btn mt-2"
              onClick={() => saveSettings({ rightsAccepted: true }).then(setSettings)}
            >
              {t('rightsAccept')}
            </button>
          </section>
        )}

        {!hasAccess && (
          <section class="my-2 rounded bg-raised p-2 text-xs" data-testid="access">
            <p class="font-medium">{t('accessTitle')}</p>
            <p class="text-muted">{t('accessBody')}</p>
            <button class="btn btn-primary mt-2" onClick={grantAccess}>
              {t('accessGrant')}
            </button>
          </section>
        )}

        {visibleJobs.length > 0 && (
          <ul class="divide-y divide-border border-b border-border">
            {visibleJobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        )}

        {items.length > 0 ? (
          <ul class="divide-y divide-border">
            {items.map((item) => (
              <MediaRow key={item.id} item={item} settings={settings} tabId={view!.tabId} />
            ))}
          </ul>
        ) : (
          <p class="py-8 text-center text-muted" data-testid="empty">
            {t(view?.blocked ? 'siteUnavailable' : 'emptyState')}
          </p>
        )}
      </main>

      <footer class="border-t border-border px-3 py-2">
        <button
          class="btn w-full justify-center"
          onClick={() => browser.tabs.create({ url: browser.runtime.getURL('/downloads.html') })}
        >
          <List size={14} aria-hidden /> {t('popupDownloadsLink')}
        </button>
      </footer>
    </div>
  );
}
