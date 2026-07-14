/**
 * Small async lane for broker state mutations. Management ticks may skip a busy lane; entry/order
 * commits queue behind the current owner so sync and submission never overlap.
 */
export class ExecutionLane {
  constructor() {
    this.tail = Promise.resolve();
    this.depth = 0;
  }

  get busy() {
    return this.depth > 0;
  }

  async run(work, { skipIfBusy = false } = {}) {
    if (skipIfBusy && this.busy) return { skipped: true };

    this.depth += 1;
    const previous = this.tail.catch(() => {});
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.tail = previous.then(() => gate);
    await previous;

    try {
      return await work();
    } finally {
      this.depth -= 1;
      release();
    }
  }
}
