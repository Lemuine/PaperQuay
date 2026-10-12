/** Keep disk-backed setting patches in user-edit order without blocking typing. */
export function createSerialSettingsWrites<Patch, Result>(save: (patch: Patch) => Promise<Result>) {
  let tail: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<Result>>();

  return {
    update(patch: Patch): Promise<Result> {
      const operation = tail.then(() => save(patch));
      tail = operation.then(() => {}, () => {});
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    async flush(): Promise<void> {
      while (pending.size > 0) await Promise.all(Array.from(pending));
    },
  };
}
