import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

/**
 * Chromium with no Playwright in the download path. Playwright's download handling,
 * even in 'allow' mode, replaces the names that extensions choose, so anything about
 * filenames has to be tested here, over plain CDP.
 */
export class RawChromium {
  private ids = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(err: Error): void }>();

  private constructor(
    private process: ChildProcess,
    private socket: WebSocket,
    private profile: string,
    readonly downloads: string,
  ) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async launch(extensions: string[]): Promise<RawChromium> {
    const profile = mkdtempSync(join(tmpdir(), 'vidget-raw-'));
    const downloads = join(profile, 'saved');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    mkdirSync(downloads);
    writeFileSync(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
    );
    const list = extensions.join(',');
    const child = spawn(chromium.executablePath(), [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      `--disable-extensions-except=${list}`,
      `--load-extension=${list}`,
      'about:blank',
    ]);
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stderr!.on('data', (chunk) => {
        output += String(chunk);
        const match = output.match(/DevTools listening on (ws:\S+)/);
        if (match) resolve(match[1]!);
      });
      child.once('exit', () => reject(new Error(`Chromium exited: ${output}`)));
    });
    const socket = new WebSocket(url);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    return new RawChromium(child, socket, profile, downloads);
  }

  private send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.ids;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Open a tab and return a function that evaluates async code inside it. */
  async open(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.navigate', { url }, sessionId);
    const loaded = async () => {
      const reply = await this.send(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        sessionId,
      ).catch(() => undefined);
      return reply?.result?.value === url;
    };
    // A new tab starts on about:blank, or has no context at all, until it commits.
    for (let attempt = 0; attempt < 50 && !(await loaded()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return async <T>(expression: string): Promise<T> => {
      const { result, exceptionDetails } = await this.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed');
      return result.value as T;
    };
  }

  /** The id of the extension called `name`. Chromium's built-in ones have workers too. */
  async extensionId(name: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const { targetInfos } = await this.send('Target.getTargets');
      for (const target of targetInfos) {
        if (target.type !== 'service_worker') continue;
        const { sessionId } = await this.send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        });
        // A worker that has not started yet would never answer.
        const reply = await Promise.race([
          this.send(
            'Runtime.evaluate',
            { expression: 'chrome.runtime.getManifest().name', returnByValue: true },
            sessionId,
          ).catch(() => undefined),
          new Promise<undefined>((resolve) => setTimeout(resolve, 300)),
        ]);
        if (reply?.result?.value === name) return new URL(target.url).hostname;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No extension called ${name}`);
  }

  async close(): Promise<void> {
    const exited = new Promise((resolve) => this.process.once('exit', resolve));
    this.process.kill();
    await exited;
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
