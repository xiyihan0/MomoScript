export type SequenceFetches = Map<string, Promise<Uint8Array>>;

export function sequenceFetchKey(url: URL, sha256: string): string {
  return `${url.href}\0${sha256}`;
}

export async function fetchSequenceOnce(
  pending: SequenceFetches,
  key: string,
  load: () => Promise<Uint8Array>
): Promise<Uint8Array> {
  let request = pending.get(key);
  if (!request) {
    request = load();
    pending.set(key, request);
  }
  try {
    return await request;
  } catch (error) {
    if (pending.get(key) === request) pending.delete(key);
    throw error;
  }
}
