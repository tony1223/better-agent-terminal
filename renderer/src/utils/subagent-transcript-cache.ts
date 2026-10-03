// A reset or history replacement invalidates outstanding disk reads. Keeping
// the same Map also lets callers release the previous transcript immediately.
export class SubagentTranscriptCache<T> extends Map<string, T[]> {
  private revision = 0
  private readonly liveVersions = new Map<string, number>()
  private readonly readVersions = new Map<string, number>()

  override set(id: string, messages: T[]): this {
    this.liveVersions.set(id, (this.liveVersions.get(id) ?? 0) + 1)
    return super.set(id, messages)
  }

  override clear(): void {
    this.revision++
    this.liveVersions.clear()
    this.readVersions.clear()
    super.clear()
  }

  replace(buckets: ReadonlyMap<string, T[]>): void {
    this.clear()
    for (const [id, messages] of buckets) super.set(id, messages)
  }

  async load(id: string, read: () => Promise<T[]>): Promise<T[] | null> {
    const revision = this.revision
    const liveVersion = this.liveVersions.get(id) ?? 0
    const readVersion = (this.readVersions.get(id) ?? 0) + 1
    this.readVersions.set(id, readVersion)
    const isCurrent = () => this.revision === revision && this.readVersions.get(id) === readVersion
    let messages: T[]
    try {
      messages = await read()
    } catch (error) {
      if (!isCurrent()) return null
      throw error
    }
    if (!isCurrent()) return null
    // Live events arriving during the disk read are more current than its
    // snapshot. This tracks set() even when the caller appends to a bucket
    // in place. Disk writes do not count as live events; a later completion
    // read must be able to replace a partial snapshot.
    if ((this.liveVersions.get(id) ?? 0) !== liveVersion) return this.get(id) ?? []
    if (messages.length > 0) super.set(id, messages)
    return messages
  }
}
