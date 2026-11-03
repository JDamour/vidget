interface AccessDeps {
  hasAccess(): Promise<boolean>;
  subscribe(): void;
  unsubscribe(): void;
}

/**
 * Chrome reports an error for a webRequest subscription made without host
 * access, and access here is optional, so it can arrive or go at any time.
 */
export class AccessGate {
  private subscribed = false;

  constructor(private deps: AccessDeps) {}

  async sync(): Promise<void> {
    const allowed = await this.deps.hasAccess();
    if (allowed === this.subscribed) return;
    this.subscribed = allowed;
    if (allowed) this.deps.subscribe();
    else this.deps.unsubscribe();
  }
}
