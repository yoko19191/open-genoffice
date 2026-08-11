type PendingResult<T> = {
  value: T
  resolve: () => void
  reject: (error: Error) => void
}

export class ToolResultReorderBuffer<T> {
  private readonly pending = new Map<number, PendingResult<T>>()
  private draining = false
  private fatalError: Error | undefined
  private nextOrder = 0

  constructor(
    private readonly maxPending: number,
    private readonly publish: (value: T) => Promise<void>,
  ) {
    if (maxPending < 1) throw new Error('invalid_tool_reorder_buffer_size')
  }

  get nextToolOrder(): number {
    return this.nextOrder
  }

  settle(toolOrder: number, value: T): Promise<void> {
    if (this.fatalError) throw new Error('tool_result_publish_failed')
    if (!Number.isInteger(toolOrder) || toolOrder < this.nextOrder) {
      throw new Error('tool_order_already_published')
    }
    if (this.pending.has(toolOrder)) throw new Error('duplicate_tool_order')
    if (toolOrder >= this.nextOrder + this.maxPending) {
      throw new Error('tool_reorder_buffer_full')
    }

    const result = new Promise<void>((resolve, reject) => {
      this.pending.set(toolOrder, { value, resolve, reject })
    })
    this.scheduleDrain()
    return result
  }

  private scheduleDrain(): void {
    if (this.draining || !this.pending.has(this.nextOrder)) return
    this.draining = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    while (this.pending.has(this.nextOrder)) {
      const order = this.nextOrder
      const current = this.pending.get(order)!
      this.pending.delete(order)
      try {
        await this.publish(current.value)
        this.nextOrder += 1
        current.resolve()
      } catch (error) {
        this.fatalError = error instanceof Error ? error : new Error('tool_result_publish_failed')
        current.reject(this.fatalError)
        for (const pending of this.pending.values()) pending.reject(this.fatalError)
        this.pending.clear()
        this.draining = false
        return
      }
    }
    this.draining = false
    this.scheduleDrain()
  }
}
