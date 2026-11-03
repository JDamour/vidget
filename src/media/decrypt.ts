import { JobError } from '@/src/shared/errors';
import type { SegmentKey } from './track';

/** HLS default IV: the media sequence number as a 128-bit big-endian integer. */
export function ivFor(key: SegmentKey, mediaSequence: number): Uint8Array {
  if (key.iv) return key.iv;
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(8, Math.floor(mediaSequence / 2 ** 32));
  view.setUint32(12, mediaSequence >>> 0);
  return iv;
}

/** HLS clear-key AES-128: CBC with PKCS#7 padding, which WebCrypto removes. */
export async function decryptAes128(
  data: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.length !== 16) {
    throw new JobError('unsupported', `Unexpected AES key length ${keyBytes.length}`);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as Uint8Array<ArrayBuffer>,
    'AES-CBC',
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as Uint8Array<ArrayBuffer> },
    key,
    data as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(plain);
}
