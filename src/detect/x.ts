/**
 * Names for videos on X, whose feed pages all share one title and whose players
 * use blob: URLs. X's markup has no test ids and no <time> elements, so this reads
 * only what a reader can see: the status link and the text of the post.
 */
import { shortTitle } from '@/src/shared/format';

const X_HOSTS = /(^|\.)(x|twitter)\.com$/i;
const MEDIA_ID = /\/(?:amplify_video|ext_tw_video|tweet_video)(?:_thumb)?\/(\d+)(?=[/.?]|$)/;
const STATUS_PATH = /^\/([^/]+)\/status\/\d+/;
const COUNTER = /^[\d.,]+\s*[kmb]?$/i;
const END_OF_TEXT = /^(ALT|GIF|Show more|Translate post|Quote|\d+:\d{2}(:\d{2})?)$/i;
const NOT_TEXT = /^(·|Replying to|@\w+)$/;
const DATE = /^(now|\d+\s?[smhd]|\d{1,2}\s\p{L}{3,}\.?(\s\d{4})?|\p{L}{3,}\.?\s\d{1,2}(,\s\d{4})?)$/iu;
const NOT_RENDERED = new Set(['SCRIPT', 'STYLE', 'VIDEO', 'IMG', 'svg']);
const GENERIC_TITLES = new Set(['Home', 'Explore', 'Notifications', 'Bookmarks', 'Search', 'Messages']);

export function isXHost(hostname: string): boolean {
  return X_HOSTS.test(hostname);
}

/** The id shared by a video's stream URLs and, for most uploads, its poster. */
export function xMediaId(url: string): string | undefined {
  return url.match(MEDIA_ID)?.[1];
}

/**
 * A post's text, one entry per line. Not innerText: on a hidden or still-hydrating
 * page that loses every line break and includes the source of X's inline scripts.
 * The status link is left out because that is where a feed post shows its date.
 */
function postLines(article: Element, statusPath: string): string[] {
  const lines: string[] = [];
  let line = '';
  const endLine = () => {
    lines.push(line);
    line = '';
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        line += child.nodeValue ?? '';
      } else if (child instanceof Element && !NOT_RENDERED.has(child.nodeName)) {
        if (child.nodeName === 'A' && child.getAttribute('href') === statusPath) continue;
        const isBlock = child.nodeName === 'DIV' || child.nodeName === 'P';
        if (isBlock) endLine();
        walk(child);
        if (isBlock) endLine();
      }
    }
  };
  walk(article);
  endLine();
  return lines.flatMap((text) => text.split('\n')).map((text) => text.trim()).filter(Boolean);
}

/**
 * Build a title from a post's lines: name, @handle, then the words. A feed post may
 * have a date after the handle and a post page has none, so it goes by what it is.
 */
export function xPostTitle(lines: string[], statusPath: string): string | undefined {
  const handle = statusPath.match(STATUS_PATH)?.[1];
  if (!handle) return undefined;
  const at = lines.findIndex((line) => line.toLowerCase() === `@${handle}`.toLowerCase());
  if (at < 0) return undefined;

  const words: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (DATE.test(line) || line === '·') continue;
    if (COUNTER.test(line) || END_OF_TEXT.test(line)) break;
    if (!NOT_TEXT.test(line)) words.push(line);
  }
  const body = shortTitle(words.join(' '));
  return body ? `@${handle} - ${body}` : `@${handle} video`;
}

/** Page titles read `(2) Home / X` or `Name on X: "words" / X`. */
export function cleanXTitle(title: string): string | undefined {
  const plain = title.replace(/^\(\d+\)\s*/, '').replace(/\s*\/\s*X$/, '').trim();
  const post = plain.match(/^(.+?) on X:\s*"(.*)"?$/s);
  if (post) return `${post[1]} - ${shortTitle(post[2]!.replace(/"$/, ''))}`;
  return GENERIC_TITLES.has(plain) ? undefined : plain || undefined;
}

function postTitleOf(video: HTMLVideoElement): string | undefined {
  const article = video.closest('article');
  if (!article) return undefined;
  const links = article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]');
  const link = [...links].find((entry) => STATUS_PATH.test(entry.getAttribute('href') ?? ''));
  const href = link?.getAttribute('href');
  return href ? xPostTitle(postLines(article, href), href) : undefined;
}

/** Titles of the posts on screen, keyed by media id, for matching to streams. */
export function xPostsById(videos: HTMLVideoElement[]): Record<string, string> {
  const posts: Record<string, string> = {};
  for (const video of videos) {
    const id = xMediaId(video.poster);
    const title = id && postTitleOf(video);
    if (id && title) posts[id] = title;
  }
  return posts;
}

/**
 * Some posters are plain images with no media id. For those, the post whose video
 * is playing when a stream appears is the best guess. Videos that do have an id
 * are left out, because the id match is exact and a guess could only contradict it.
 */
export function xPlayingPostTitle(videos: HTMLVideoElement[]): string | undefined {
  const playing = videos.filter((video) => !video.paused && !xMediaId(video.poster));
  return playing.length === 1 ? postTitleOf(playing[0]!) : undefined;
}
