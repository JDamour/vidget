import type { CompanionEvent, CompanionRequest } from './protocol';

interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

/** What Chrome reports when no host is registered under the name, in Chrome and Edge. */
const NOT_INSTALLED = /not found|not registered|forbidden/i;

/**
 * One port to the companion host. The host process lives as long as the port, and
 * an open port also keeps the service worker awake while a download runs.
 */
export class Companion {
  private port?: Port;

  constructor(
    private connect: () => Port,
    private onEvent: (event: CompanionEvent) => void,
    private lastError: () => string | undefined = () => undefined,
  ) {}

  send(request: CompanionRequest): void {
    this.port ??= this.open();
    this.port.postMessage(request);
  }

  /** For stops: a host that is not running has nothing to stop. */
  sendIfOpen(request: CompanionRequest): void {
    this.port?.postMessage(request);
  }

  close(): void {
    this.port?.disconnect();
    this.port = undefined;
  }

  private open(): Port {
    const port = this.connect();
    port.onMessage.addListener((message) => this.onEvent(message as CompanionEvent));
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = undefined;
      const reason = this.lastError() ?? 'The companion stopped';
      this.onEvent({
        type: 'disconnected',
        message: NOT_INSTALLED.test(reason) ? 'The Vidget companion is not installed' : reason,
      });
    });
    return port;
  }
}
