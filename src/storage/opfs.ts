const JOBS_DIR = 'jobs';

async function jobsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(JOBS_DIR, { create: true });
}

export async function jobDir(jobId: string): Promise<FileSystemDirectoryHandle> {
  return (await jobsDir()).getDirectoryHandle(jobId, { create: true });
}

export async function removeJobDir(jobId: string): Promise<void> {
  try {
    await (await jobsDir()).removeEntry(jobId, { recursive: true });
  } catch (err) {
    if ((err as DOMException).name !== 'NotFoundError') throw err;
  }
}

/** Delete working folders left by a crash, keeping those of `keep`. */
export async function sweepOrphans(keep: Set<string>): Promise<void> {
  const dir = (await jobsDir()) as FileSystemDirectoryHandle & {
    keys(): AsyncIterable<string>;
  };
  for await (const name of dir.keys()) {
    if (!keep.has(name)) await removeJobDir(name);
  }
}

export async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * `createWritable` writes to a swap file and replaces the target on close, so a
 * file that exists is always complete. Resume relies on this.
 */
export async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data as Uint8Array<ArrayBuffer>);
  await writable.close();
}

export async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<File> {
  return (await dir.getFileHandle(name)).getFile();
}

/** Fail before downloading when the file cannot fit, with the size it needs. */
export async function checkQuota(neededBytes: number): Promise<{ ok: boolean; available: number }> {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  const available = quota - usage;
  return { ok: available >= neededBytes, available };
}
