import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// The E2E build grants host access at install: Playwright cannot click through
// the permission prompt that production builds show on first use.
const e2e = process.env.VIDGET_E2E === '1';
const featureYoutube = process.env.FEATURE_YOUTUBE === 'true';
// Self-distributed only: hands YouTube pages to the companion app. Store builds
// never request nativeMessaging and never offer YouTube.
const companion = process.env.VIDGET_COMPANION === '1';

export default defineConfig({
  srcDir: '.',
  outDir: e2e ? '.output-e2e' : companion ? '.output-companion' : '.output',
  manifestVersion: 3,
  vite: () => ({
    plugins: [preact(), tailwindcss()],
    define: {
      __FEATURE_YOUTUBE__: JSON.stringify(featureYoutube),
      __FEATURE_COMPANION__: JSON.stringify(companion),
    },
  }),
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: [
      'webRequest',
      'downloads',
      'storage',
      'unlimitedStorage',
      'scripting',
      'activeTab',
      'contextMenus',
      'notifications',
      'declarativeNetRequestWithHostAccess',
      ...(browser === 'firefox' ? ['tabs'] : ['offscreen']),
      ...(companion ? ['nativeMessaging'] : []),
    ],
    ...(e2e
      ? { host_permissions: ['<all_urls>'] }
      : { optional_host_permissions: ['<all_urls>'] }),
    action: { default_title: '__MSG_extName__' },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: { id: 'vidget@vidget.app', strict_min_version: '128.0' },
          },
        }
      : {}),
  }),
});
