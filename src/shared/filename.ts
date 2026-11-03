const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_STEM = 180;

/** Make one path component safe on Windows, macOS and Linux. */
export function sanitizeName(name: string): string {
  let clean = name
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (clean.length > MAX_STEM) clean = clean.slice(0, MAX_STEM).trimEnd();
  if (!clean) return 'video';
  return RESERVED.test(clean) ? `_${clean}` : clean;
}

export interface FilenameTokens {
  title: string;
  site: string;
  quality: string;
  id: string;
  date?: Date;
}

export function renderFilename(
  template: string,
  tokens: FilenameTokens,
  ext: string,
  opts: { siteFolder?: boolean } = {},
): string {
  const date = (tokens.date ?? new Date()).toISOString().slice(0, 10);
  const values: Record<string, string> = {
    title: tokens.title,
    site: tokens.site,
    quality: tokens.quality,
    id: tokens.id,
    date,
  };
  const stem = template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
  const file = `${sanitizeName(stem)}.${ext}`;
  return opts.siteFolder ? `${sanitizeName(tokens.site)}/${file}` : file;
}
