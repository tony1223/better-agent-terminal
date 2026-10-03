// Bound caches by retained data as well as entry count. A count-only cache
// can retain hundreds of megabytes when its keys are full transcript strings.
export class WeightedLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>()
  private retainedWeight = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (key: K, value: V) => number,
  ) {}

  get size(): number { return this.entries.size }
  get weight(): number { return this.retainedWeight }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.retainedWeight -= previous.weight
    }
    const weight = this.weigh(key, value)
    // An oversized entry must not flush the useful cache or remain retained.
    if (!Number.isFinite(weight) || weight < 0 || weight > this.maxWeight || this.maxEntries < 1) return
    while (this.entries.size >= this.maxEntries || this.retainedWeight + weight > this.maxWeight) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.retainedWeight -= oldest[1].weight
    }
    this.entries.set(key, { value, weight })
    this.retainedWeight += weight
  }
}
