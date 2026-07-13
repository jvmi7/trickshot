// A pushable async-iterable used as a streaming `prompt`. Never closed, so the
// session stays open for a multi-turn chat. Provider-agnostic — any adapter that
// drives an SDK with a streaming input queue can reuse it.
//
// PERFORMANCE: `push()` is the input backpressure point and MUST stay O(1) — it
// only appends and wakes a parked consumer; it never aggregates or serializes.
export function makeQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          // `shift()` is `T | undefined`, but the `items.length` guard above proves
          // an element is present — narrow to `T`.
          yield items.shift() as T;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
