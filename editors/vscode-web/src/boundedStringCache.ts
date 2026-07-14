export const MATERIALIZED_RESOURCE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export class BoundedStringCache {
  readonly #values = new Map<string, string>();
  #bytes = 0;
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.#values.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(key: string): string | undefined {
    const value = this.#values.get(key);
    if (value === undefined) return undefined;
    this.#values.delete(key);
    this.#values.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    const previous = this.#values.get(key);
    if (previous !== undefined) {
      this.#values.delete(key);
      this.#bytes -= entryBytes(key, previous);
    }
    const nextBytes = entryBytes(key, value);
    if (nextBytes > this.maxBytes) return;
    while (this.#bytes + nextBytes > this.maxBytes) {
      const oldest = this.#values.entries().next().value as [string, string] | undefined;
      if (!oldest) break;
      this.#values.delete(oldest[0]);
      this.#bytes -= entryBytes(oldest[0], oldest[1]);
    }
    this.#values.set(key, value);
    this.#bytes += nextBytes;
  }

  clear(): void {
    this.#values.clear();
    this.#bytes = 0;
  }
}

function entryBytes(key: string, value: string): number {
  return (key.length + value.length) * 2;
}
