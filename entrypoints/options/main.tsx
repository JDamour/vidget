import { render, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  type DefaultQuality,
  loadSettings,
  saveSettings,
  SEGMENT_WORKERS_MAX,
  SEGMENT_WORKERS_MIN,
  type Settings,
} from '@/src/shared/settings';
import { t } from '@/src/ui/i18n';
import '@/src/ui/style.css';

const LICENSES = [
  ['m3u8-parser', 'Apache-2.0'],
  ['mpd-parser', 'Apache-2.0'],
  ['mux.js', 'Apache-2.0'],
  ['idb', 'ISC'],
  ['Preact', 'MIT'],
  ['Lucide', 'ISC'],
];

function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="font-medium">{props.label}</span>
      {props.children}
      {props.hint && <span class="text-xs text-muted">{props.hint}</span>}
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label class="flex items-center gap-2">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span class="font-medium">{props.label}</span>
    </label>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function App() {
  const [settings, setSettings] = useState<Settings>();

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const update = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    void saveSettings(patch);
  };

  const number = (key: keyof Settings, min: number, max: number) => ({
    type: 'number' as const,
    class: 'field w-32',
    min,
    max,
    value: settings[key] as number,
    onChange: (event: { currentTarget: HTMLInputElement }) =>
      update({ [key]: clamp(event.currentTarget.valueAsNumber, min, max) }),
  });

  return (
    <div class="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <h1 class="text-xl font-semibold">{t('optionsTitle')}</h1>

      <section class="flex flex-col gap-4">
        <Field label={t('optQuality')}>
          <select
            class="field w-48"
            value={settings.defaultQuality}
            onChange={(event) =>
              update({ defaultQuality: event.currentTarget.value as DefaultQuality })
            }
          >
            <option value="best">{t('optQualityBest')}</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="ask">{t('optQualityAsk')}</option>
          </select>
        </Field>

        <Field label={t('optFilename')} hint={t('optFilenameHint')}>
          <input
            class="field"
            value={settings.filenameTemplate}
            onChange={(event) =>
              update({ filenameTemplate: event.currentTarget.value.trim() || '{title}' })
            }
          />
        </Field>

        <Toggle
          label={t('optSubfolders')}
          checked={settings.siteSubfolders}
          onChange={(siteSubfolders) => update({ siteSubfolders })}
        />

        <Field label={t('optWorkers')}>
          <input {...number('segmentWorkers', SEGMENT_WORKERS_MIN, SEGMENT_WORKERS_MAX)} />
        </Field>
        <Field label={t('optJobs')}>
          <input {...number('concurrentJobs', 1, 5)} />
        </Field>
        <Field label={t('optMinDuration')}>
          <input {...number('minDurationSec', 0, 600)} />
        </Field>
        <Field label={t('optMinSize')}>
          <input {...number('minSizeKb', 0, 102400)} />
        </Field>

        <Toggle
          label={t('optInPage')}
          checked={settings.inPageButton}
          onChange={(inPageButton) => update({ inPageButton })}
        />
        <Field label={t('optInPageOff')} hint={t('optInPageOffHint')}>
          <textarea
            class="field font-mono"
            rows={3}
            value={settings.inPageButtonOff.join('\n')}
            onChange={(event) =>
              update({
                inPageButtonOff: event.currentTarget.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>

        <Field label={t('optHistoryDays')} hint={t('optHistoryDaysHint')}>
          <input {...number('historyDays', 0, 3650)} />
        </Field>
      </section>

      <section class="rounded bg-raised p-3">
        <h2 class="font-semibold">{t('optRightsTitle')}</h2>
        <p>{t('rightsNotice')}</p>
      </section>

      <section>
        <h2 class="font-semibold">{t('optLicenses')}</h2>
        <ul class="text-muted">
          {LICENSES.map(([name, license]) => (
            <li key={name}>
              {name} ({license})
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
