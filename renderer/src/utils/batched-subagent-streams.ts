export interface SubagentStreamSnapshot {
  text: Map<string, string>
  thinking: Map<string, string>
}

interface StreamScheduler {
  schedule(callback: () => void, delay: number): unknown
  cancel(handle: unknown): void
}

// Mutable buffers stay outside React. Only a scheduled flush copies the maps;
// deleting a completed agent also cancels its unpublished chunks.
export class BatchedSubagentStreams {
  private text = new Map<string, string>()
  private thinking = new Map<string, string>()
  private pending: unknown = null
  private active = true
  private dirty = false

  constructor(private readonly publish: (snapshot: SubagentStreamSnapshot) => void,
    private readonly scheduler: StreamScheduler) {}

  append(id: string, delta: { text?: string; thinking?: string }): void {
    if (!delta.text && !delta.thinking) return
    if (delta.text) this.text.set(id, (this.text.get(id) || '') + delta.text)
    if (delta.thinking) this.thinking.set(id, (this.thinking.get(id) || '') + delta.thinking)
    this.dirty = true
    this.schedule()
  }

  delete(id: string): void {
    const textChanged = this.text.delete(id)
    const thinkingChanged = this.thinking.delete(id)
    if (textChanged || thinkingChanged) { this.dirty = true; this.flush() }
  }

  clear(): void {
    this.cancel()
    this.text.clear()
    this.thinking.clear()
    this.dirty = true
    this.flush()
  }

  setActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    this.cancel()
    if (this.dirty) this.schedule()
  }

  flush(): void {
    this.cancel()
    if (!this.dirty) return
    this.dirty = false
    this.publish({ text: new Map(this.text), thinking: new Map(this.thinking) })
  }

  dispose(): void {
    this.cancel()
    this.text.clear()
    this.thinking.clear()
    this.dirty = false
  }

  private cancel(): void {
    if (this.pending !== null) this.scheduler.cancel(this.pending)
    this.pending = null
  }

  private schedule(): void {
    if (this.pending !== null) return
    this.pending = this.scheduler.schedule(() => this.flush(), this.active ? 50 : 500)
  }
}
