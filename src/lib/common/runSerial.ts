const queues = new Map<string, Promise<unknown>>();

/** Run fn after earlier work on the same key settles, so read-merge-write
 *  updates of one encrypted row never interleave. */
export function runSerial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}
