type Entry = { key: string; value: string; expiresAt?: number; bytes: number };
type LruNode = { entry: Entry; newer?: LruNode; older?: LruNode };

/** Map-backed key/value store with an O(1) LRU list and approximate byte cap. */
export class Store {
  private readonly entries = new Map<string, LruNode>();
  private newest?: LruNode;
  private oldest?: LruNode;
  private usedBytes = 0;

  constructor(readonly maxBytes: number) {}

  get size(): number { return this.entries.size; }
  get memoryBytes(): number { return this.usedBytes; }

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

  /** Remove a random sample of keys whose deadlines have passed. */
  activeExpire(sampleSize = 20): number {
    const nodes = [...this.entries.values()];
    let removed = 0;
    const sampleCount = Math.min(sampleSize, nodes.length);
    for (let index = 0; index < sampleCount; index += 1) {
      const [node] = nodes.splice(Math.floor(Math.random() * nodes.length), 1);
      if (node.entry.expiresAt !== undefined && node.entry.expiresAt <= Date.now()) {
        this.removeNode(node);
        removed += 1;
      }
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
    if (node.older) node.older.newer = node.newer;
    else this.newest = node.newer;
    if (node.newer) node.newer.older = node.older;
    else this.oldest = node.older;
    node.newer = undefined;
    node.older = undefined;
  }

  private removeNode(node: LruNode): void {
    this.unlink(node);
    this.entries.delete(node.entry.key);
    this.usedBytes -= node.entry.bytes;
  }
}
