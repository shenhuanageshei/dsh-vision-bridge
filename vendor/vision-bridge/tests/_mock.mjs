/** Minimal zero-dependency stand-in for vitest's vi.fn. */
export function mockFn(impl) {
  const fn = (...args) => {
    fn.mock.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.mock = { calls: [] };
  return fn;
}
