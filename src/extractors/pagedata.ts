const JSON_SCRIPT = /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

export type Node = Record<string, unknown>;

/** The inline JSON blocks that match `wanted`. Pages can carry dozens of others. */
export function pageData(html: string, wanted: RegExp): unknown[] {
  const blocks: unknown[] = [];
  for (const [, text] of html.matchAll(JSON_SCRIPT)) {
    if (!text || !wanted.test(text)) continue;
    try {
      blocks.push(JSON.parse(text));
    } catch {
      // Not every block is well-formed, and the others may still hold the video.
    }
  }
  return blocks;
}

export function walk(value: unknown, visit: (node: Node) => void): void {
  if (!value || typeof value !== 'object') return;
  visit(value as Node);
  for (const child of Object.values(value)) walk(child, visit);
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function pageTitle(html: string): string | undefined {
  return html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1]?.trim() || undefined;
}
