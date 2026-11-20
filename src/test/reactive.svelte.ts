/** A deeply reactive object for tests that stand in for a module's `$state` store. */
export function reactive<T extends object>(value: T): T {
  const s = $state(value);
  return s;
}
