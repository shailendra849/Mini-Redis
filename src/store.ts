type Entry = { key: string; value: string; expiresAt?: number; bytes: number };
type LruNode = { entry: Entry; newer?: LruNode; older?: LruNode };

/** Map-backed key/value store with an O(1) LRU list and approximate byte cap. */
export class Store {
  private readonly entries = new Map<string, LruNode>();
  private newest?: LruNode;
  private oldest?: LruNode;
  private usedBytes = 0;

  /** Keys that currently have a TTL — random sample without scanning all entries. */
  private readonly ttlKeys: string[] = [];
  private readonly ttlIndex = new Map<string, number>();

  constructor(readonly maxBytes: number) {}

  get size(): number { return this.entries.size; }
  get memoryBytes(): number { return this.usedBytes; }
  /** Number of keys tracked for active expiry (useful for tests / debugging). */
  get ttlCount(): number { return this.ttlKeys.length; }

  get(key: string): string | undefined {
    const node = this.liveNode(key);
    if (!node) return undefined;
    this.touch(node);
    return node.entry.value;
  }

  getExpiresAt(key: string): number | undefined {
    const node = this.liveNode(key);
    if (!node) return undefined;
    this.touch(node);
    return node.entry.expiresAt;
  }

  has(key: string): boolean {
    const node = this.liveNode(key);
    if (!node) return false;
    this.touch(node);
    return true;
  }

  set(key: string, value: string, expiresAt?: number): string[] {
    const bytes = this.entryBytes(key, value);
    if (bytes > this.maxBytes) throw new Error("value exceeds maxmemory limit");

    const existing = this.entries.get(key);
    if (existing) this.removeNode(existing);
    const node: LruNode = { entry: { key, value, expiresAt, bytes } };
    this.entries.set(key, node);
    this.usedBytes += bytes;
    this.addNewest(node);
    this.syncTtlTracking(key, expiresAt);

    const evicted: string[] = [];
    while (this.usedBytes > this.maxBytes && this.oldest) {
      const victim = this.oldest;
      evicted.push(victim.entry.key);
      this.removeNode(victim);
    }
    return evicted;
  }

  delete(key: string): boolean {
    const node = this.liveNode(key);
    if (!node) return false;
    this.removeNode(node);
    return true;
  }

  expire(key: string, expiresAt: number): boolean {
    const node = this.liveNode(key);
    if (!node) return false;
    node.entry.expiresAt = expiresAt;
    this.syncTtlTracking(key, expiresAt);
    this.touch(node);
    return true;
  }

  ttl(key: string): number {
    const node = this.liveNode(key);
    if (!node) return -2;
    this.touch(node);
    if (node.entry.expiresAt === undefined) return -1;
    return Math.max(0, Math.ceil((node.entry.expiresAt - Date.now()) / 1000));
  }

  /**
   * Redis-style active expiry: sample only TTL keys, delete expired ones, and
   * repeat while a large fraction expired — but stop once the time budget ends.
   * Lazy expiry on access still catches anything this misses.
   */
  activeExpire(sampleSize = 20, timeBudgetMs = 1): number {
    const budgetEnds = Date.now() + timeBudgetMs;
    let removed = 0;

    while (this.ttlKeys.length > 0 && Date.now() < budgetEnds) {
      const sampleCount = Math.min(sampleSize, this.ttlKeys.length);
      let expiredInSample = 0;

      for (let index = 0; index < sampleCount; index += 1) {
        const key = this.ttlKeys[Math.floor(Math.random() * this.ttlKeys.length)];
        const node = this.entries.get(key);
        if (!node || node.entry.expiresAt === undefined) {
          this.untrackTtl(key);
          continue;
        }
        if (node.entry.expiresAt <= Date.now()) {
          this.removeNode(node);
          expiredInSample += 1;
        }
      }

      removed += expiredInSample;
      // Same idea as Redis: keep going only while expiry looks "dense".
      if (expiredInSample / sampleCount <= 0.25) break;
    }

    return removed;
  }

  private liveNode(key: string): LruNode | undefined {
    const node = this.entries.get(key);
    if (node?.entry.expiresAt !== undefined && node.entry.expiresAt <= Date.now()) {
      this.removeNode(node);
      return undefined;
    }
    return node;
  }

  private syncTtlTracking(key: string, expiresAt?: number): void {
    if (expiresAt === undefined) this.untrackTtl(key);
    else this.trackTtl(key);
  }

  private trackTtl(key: string): void {
    if (this.ttlIndex.has(key)) return;
    this.ttlIndex.set(key, this.ttlKeys.length);
    this.ttlKeys.push(key);
  }

  /** O(1) removal via swap-with-last so random sampling stays cheap. */
  private untrackTtl(key: string): void {
    const index = this.ttlIndex.get(key);
    if (index === undefined) return;
    const lastKey = this.ttlKeys.pop()!;
    if (lastKey !== key) {
      this.ttlKeys[index] = lastKey;
      this.ttlIndex.set(lastKey, index);
    }
    this.ttlIndex.delete(key);
  }

  private entryBytes(key: string, value: string): number {
    return Buffer.byteLength(key) + Buffer.byteLength(value) + 64;
  }

  private touch(node: LruNode): void {
    if (node === this.newest) return;
    this.unlink(node);
    this.addNewest(node);
  }

  private addNewest(node: LruNode): void {
    node.newer = undefined;
    node.older = this.newest;
    if (this.newest) this.newest.newer = node;
    else this.oldest = node;
    this.newest = node;
  }

  private unlink(node: LruNode): void {
    // older===undefined means this node is the LRU tail; newer===undefined means MRU head.
    if (node.older) node.older.newer = node.newer;
    else this.oldest = node.newer;
    if (node.newer) node.newer.older = node.older;
    else this.newest = node.older;
    node.newer = undefined;
    node.older = undefined;
  }

  private removeNode(node: LruNode): void {
    this.unlink(node);
    this.entries.delete(node.entry.key);
    this.usedBytes -= node.entry.bytes;
    this.untrackTtl(node.entry.key);
  }
}
