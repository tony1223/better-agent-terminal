// LiveQuery — long-lived SDK Query in streaming-input mode.
//
// The single-shot path in claude-send.mjs spawns a fresh `claude` CLI
// subprocess per `claude.sendMessage` (cold start ~3-4 s on macOS).
// Streaming-input mode replaces that with one `sdk.query()` per session
// whose `prompt` is an AsyncIterable<SDKUserMessage>. The CLI subprocess
// stays alive across user turns, so subsequent sends pay only the
// per-turn API roundtrip — first send still pays init cost.
//
// Streaming-input also unlocks the SDK's control methods: `stopTask`,
// `interrupt`, `setPermissionMode`, `setModel`, `applyFlagSettings`. None of
// these work on single-shot generators per the SDK contract (sdk.d.ts:2025-2049):
// "only supported when streaming input/output is used."
//
// This module is unwired in the slice that introduced it — the sendMessage
// rewrite that consumes it lands separately. We ship the module + tests
// first so the API surface (push/stopTask/interrupt/close + per-turn
// result deferreds) is locked before we change the production path.
//
// API summary:
//   const lq = new LiveQuery({ sdk, queryOptions, onMessage, onError })
//   const result = await lq.push(userMessage)   // resolves on next 'result' frame
//   await lq.stopTask(taskId)
//   await lq.interrupt()
//   lq.close()
//   lq.isClosed                                  // true after close() / fatal error
//
// Lifecycle:
//   - On construction: start sdk.query({prompt: <controlled iterable>, options})
//     and a background loop that for-await's the generator. Every yielded
//     message is dispatched via onMessage callback. Each 'result' message
//     resolves the head pending push() promise (FIFO).
//   - On generator throw / done: mark closed, reject all pending
//     push() promises with the error (or 'LiveQuery closed' on graceful
//     end), and forward the error to onError.
//   - close(): mark closed, wake any iterator-side waiter so the
//     iterator finishes, ask the SDK to terminate the subprocess via
//     generator.close(), and reject pending pushes.

const TURN_END_TYPES = new Set(['result'])

export class LiveQuery {
  constructor({ sdk, queryOptions, onMessage, onError } = {}) {
    if (!sdk || typeof sdk.query !== 'function') {
      throw new Error('LiveQuery: sdk.query is required')
    }
    if (typeof onMessage !== 'function') {
      throw new Error('LiveQuery: onMessage callback is required')
    }
    this._queue = []
    this._waker = null  // resolve fn for the iterator-side waiter
    this._closed = false
    this._turnDeferreds = []  // FIFO {resolve, reject} per push()
    this._onMessage = onMessage
    this._onError = typeof onError === 'function' ? onError : () => {}

    const self = this
    const promptIterable = {
      async *[Symbol.asyncIterator]() {
        while (!self._closed) {
          if (self._queue.length > 0) {
            yield self._queue.shift()
            continue
          }
          // Wait for the next push() / close().
          await new Promise(resolve => { self._waker = resolve })
          self._waker = null
        }
      },
    }
    // Stash for tests — they can introspect what was passed to sdk.query.
    this._queryArgs = { prompt: promptIterable, options: queryOptions }
    this.generator = sdk.query(this._queryArgs)
    // Kick off the background drain. Don't await — fires-and-forgets,
    // but we capture the promise so unhandled rejection warnings
    // don't blow up tests.
    this._loopPromise = this._drain()
  }

  get isClosed() { return this._closed }

  async _drain() {
    try {
      for await (const msg of this.generator) {
        if (this._closed) break
        try { this._onMessage(msg) }
        catch (err) { this._onError(err) }
        if (msg && typeof msg === 'object' && TURN_END_TYPES.has(msg.type)) {
          const d = this._turnDeferreds.shift()
          if (d) d.resolve(msg)
        }
      }
    } catch (err) {
      this._onError(err)
      const wrapped = err instanceof Error ? err : new Error(String(err))
      for (const d of this._turnDeferreds) d.reject(wrapped)
      this._turnDeferreds.length = 0
    } finally {
      this._closed = true
      if (this._waker) { this._waker(); this._waker = null }
      // Pending pushes that never got a 'result' frame are rejected
      // with a closed-state error so callers don't hang.
      const closedErr = new Error('LiveQuery closed before turn completed')
      for (const d of this._turnDeferreds) d.reject(closedErr)
      this._turnDeferreds.length = 0
    }
  }

  // Push a user message and wait for its turn's 'result' frame.
  push(userMessage) {
    if (this._closed) {
      return Promise.reject(new Error('LiveQuery is closed'))
    }
    return new Promise((resolve, reject) => {
      this._turnDeferreds.push({ resolve, reject })
      this._queue.push(userMessage)
      if (this._waker) this._waker()
    })
  }

  async stopTask(taskId) {
    if (this._closed) throw new Error('LiveQuery is closed')
    if (typeof this.generator?.stopTask !== 'function') {
      throw new Error('stopTask not supported by this SDK build')
    }
    return this.generator.stopTask(taskId)
  }

  async interrupt() {
    if (this._closed) throw new Error('LiveQuery is closed')
    if (typeof this.generator?.interrupt !== 'function') {
      throw new Error('interrupt not supported by this SDK build')
    }
    return this.generator.interrupt()
  }

  async setPermissionMode(mode) {
    if (this._closed) throw new Error('LiveQuery is closed')
    if (typeof this.generator?.setPermissionMode !== 'function') {
      throw new Error('setPermissionMode not supported by this SDK build')
    }
    return this.generator.setPermissionMode(mode)
  }

  async setModel(model) {
    if (this._closed) throw new Error('LiveQuery is closed')
    if (typeof this.generator?.setModel !== 'function') {
      throw new Error('setModel not supported by this SDK build')
    }
    return this.generator.setModel(model)
  }

  async applyFlagSettings(settings) {
    if (this._closed) throw new Error('LiveQuery is closed')
    if (typeof this.generator?.applyFlagSettings !== 'function') {
      throw new Error('applyFlagSettings not supported by this SDK build')
    }
    return this.generator.applyFlagSettings(settings)
  }

  close() {
    if (this._closed) return
    this._closed = true
    if (this._waker) { this._waker(); this._waker = null }
    try { this.generator?.close?.() } catch { /* ignore */ }
    const closedErr = new Error('LiveQuery is closed')
    for (const d of this._turnDeferreds) d.reject(closedErr)
    this._turnDeferreds.length = 0
  }
}
