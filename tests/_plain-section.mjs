/**
 * Fixture helper: the plain settings section a pre-0.1.7 kernel hands over.
 *
 * The plugin's schema marks its editable nodes with `.volatile()` behind a
 * capability probe, and the schemastery this checkout resolves (through the
 * host profile, 3.18.4) implements that mark by wrapping the resolved value
 * into a reference object (`{ get() }`). The pre-volatile generation the 0.1.6
 * face belongs to shipped schemastery 3.18.2, which has no `.volatile()` at all
 * — there the probe returns the untouched schema and every resolved value is
 * plain, which is what `ctx.settings.register(...).get()` yields on a 0.1.6
 * host.
 *
 * Fixtures that stand in for that kernel resolve the marked schema with the
 * newer resolver, so they must unwrap the references this environment produces;
 * without that they would exercise a combination (legacy settings face + a
 * reference-producing resolver) no released 0.1.6 install can form.
 *
 * The walk is written independently of the plugin's own reader on purpose: a
 * fixture that reused production code to build its inputs would hide a
 * regression in exactly that code.
 */

const isRef = (node) => typeof node?.get === 'function';

/**
 * Replace every reference in a resolved settings section by its value.
 *
 * @param value - resolved settings value (possibly reference-bearing).
 * @returns the same shape with all references unwrapped.
 */
export function plainSection(value) {
  if (isRef(value)) return plainSection(value.get());
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plainSection);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainSection(item)]));
}
