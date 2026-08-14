const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  async take(n = 1): Promise<void> {
    for (;;) {
      if (this.tryTake(n)) return;
      await sleep(25);
    }
  }
}
