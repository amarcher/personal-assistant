/**
 * Simple async iterable queue. `push(item)` enqueues; async iteration yields items as they arrive.
 * Calling `end()` signals no more items will be pushed.
 */
export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    this.queue.push(item);
    this.resolve?.();
    this.resolve = null;
  }

  end(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.resolve = r;
      });
    }
  }
}
