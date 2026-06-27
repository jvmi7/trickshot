import { describe, expect, test } from "bun:test";
import { makeQueue } from "./queue";

// makeQueue is the streaming-prompt backpressure point: push() appends + wakes a
// parked consumer, and the async iterator yields FIFO and parks when empty. The
// iterator is intentionally infinite (the session never closes), so these tests
// drive it via the iterator protocol (`.next()`) rather than `for await`.
describe("makeQueue", () => {
  test("yields items pushed before iteration, in FIFO order", async () => {
    const q = makeQueue<number>();
    q.push(1);
    q.push(2);
    const it = q[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(1);
    expect((await it.next()).value).toBe(2);
  });

  test("a push wakes a parked consumer (push after await)", async () => {
    const q = makeQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next(); // parks: the queue is empty
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve(); // run a microtask turn — still parked, nothing pushed
    expect(resolved).toBe(false);
    q.push("hi");
    expect((await pending).value).toBe("hi");
  });

  test("drains every queued item before parking again", async () => {
    const q = makeQueue<number>();
    const it = q[Symbol.asyncIterator]();
    q.push(10);
    q.push(20);
    q.push(30);
    expect((await it.next()).value).toBe(10);
    expect((await it.next()).value).toBe(20);
    expect((await it.next()).value).toBe(30);
  });

  test("never reports done (the session stays open)", async () => {
    const q = makeQueue<number>();
    const it = q[Symbol.asyncIterator]();
    q.push(1);
    const first = await it.next();
    expect(first.done).toBe(false);
  });
});
