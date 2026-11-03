import { browser } from 'wxt/browser';
import { formatBytes, qualityLabel } from '@/src/shared/format';
import type { UiMessage } from '@/src/shared/messages';
import { request } from '@/src/shared/messaging';
import { loadSettings, type Settings } from '@/src/shared/settings';
import type { MediaInfo, TabState } from '@/src/shared/types';

const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

const STYLE = `
:host { all: initial; }
.root { position: fixed; z-index: 2147483647; display: none; flex-direction: column; align-items: flex-end;
  gap: 6px; font: 13px/1.3 system-ui, sans-serif; }
.root.on { display: flex; }
button { font: inherit; border: 0; cursor: pointer; color: #fff; background: rgba(15, 23, 42, .9);
  border-radius: 999px; padding: 6px 12px; }
button:hover, button:focus-visible { background: #2563eb; outline: none; }
.menu { display: flex; flex-direction: column; min-width: 180px; padding: 4px; border-radius: 10px;
  background: rgba(15, 23, 42, .95); }
.menu button { background: none; border-radius: 6px; text-align: left; display: flex;
  justify-content: space-between; gap: 16px; }
.menu button:hover, .menu button:focus-visible { background: #2563eb; }
.menu p { margin: 0; padding: 6px 12px; color: #cbd5e1; }
`;

const t = (key: string) => browser.i18n.getMessage(key as 'extName');

export function mountInPageButton(getVideos: () => HTMLVideoElement[]) {
  let settings: Settings | undefined;
  let target: HTMLVideoElement | undefined;
  let menuOpen = false;
  let lastMove = 0;

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${STYLE}</style><div class="root"><button class="pill"></button></div>`;
  const root = shadow.querySelector<HTMLDivElement>('.root')!;
  const pill = shadow.querySelector<HTMLButtonElement>('.pill')!;
  pill.textContent = t('actionDownload');

  const enabled = () =>
    !!settings?.inPageButton && !settings.inPageButtonOff.includes(location.hostname);

  const closeMenu = () => {
    menuOpen = false;
    shadow.querySelector('.menu')?.remove();
  };

  const hide = () => {
    closeMenu();
    target = undefined;
    root.classList.remove('on');
  };

  const place = (video: HTMLVideoElement) => {
    const rect = video.getBoundingClientRect();
    root.style.top = `${Math.max(rect.top + 8, 8)}px`;
    root.style.right = `${Math.max(window.innerWidth - rect.right + 8, 8)}px`;
  };

  const showMenu = async () => {
    closeMenu();
    menuOpen = true;
    const menu = document.createElement('div');
    menu.className = 'menu';
    root.append(menu);

    const state = await request<(TabState & { tabId?: number }) | undefined>({
      type: 'tab:get',
    } satisfies UiMessage);
    const items = state?.items ?? [];
    const src = target?.currentSrc;
    const item: MediaInfo | undefined =
      items.find((entry) => entry.variants.some((variant) => variant.url === src)) ?? items[0];

    const note = (text: string) => {
      const p = document.createElement('p');
      p.textContent = text;
      menu.append(p);
    };
    if (!item) return note(t('emptyState'));
    if (item.protected) return note(t('statusProtected'));
    if (item.status === 'live') return note(t('statusLive'));

    for (const variant of item.variants) {
      if (variant.needsFfmpeg) continue;
      const button = document.createElement('button');
      const label = document.createElement('span');
      label.textContent = qualityLabel(variant);
      const size = document.createElement('span');
      size.textContent = formatBytes(variant.sizeEstimate);
      button.append(label, size);
      button.addEventListener('click', () => {
        void request({
          type: 'job:start',
          mediaId: item.id,
          tabId: state?.tabId,
          variantId: variant.id,
        } satisfies UiMessage);
        hide();
      });
      menu.append(button);
    }
  };

  pill.addEventListener('click', () => {
    if (menuOpen) closeMenu();
    else void showMenu();
  });

  // Overlays usually sit above the <video>, so hover is tested by geometry.
  const onMove = (event: PointerEvent) => {
    const now = performance.now();
    if (now - lastMove < 150 || !enabled()) return;
    lastMove = now;
    if (menuOpen) return;
    const video = getVideos().find((candidate) => {
      if (candidate.paused) return false;
      const rect = candidate.getBoundingClientRect();
      return (
        rect.width >= MIN_WIDTH &&
        rect.height >= MIN_HEIGHT &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    });
    if (!video) return hide();
    target = video;
    place(video);
    root.classList.add('on');
  };

  void loadSettings().then((value) => {
    settings = value;
    document.documentElement.append(host);
    document.addEventListener('pointermove', onMove, { passive: true, capture: true });
  });

  browser.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    void loadSettings().then((value) => {
      settings = value;
      if (!enabled()) hide();
    });
  });
}
