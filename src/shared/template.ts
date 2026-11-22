/**
 * Minimal JSON templating used by listeners and workflows.
 *
 * Walks any JSON value and fills `{{dotted.path}}` placeholders in strings from `vars`.
 *   - A string that is exactly one placeholder is replaced by the raw value (keeps numbers/objects).
 *   - Otherwise placeholders are interpolated as strings.
 *   - Unknown placeholders are left as-is.
 */
export function renderTemplate(template: unknown, vars: Record<string, unknown>): unknown {
  const lookup = (path: string): unknown =>
    path.split(".").reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), vars);

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\{\{([\w.]+)\}\}$/.exec(v);
      if (whole) {
        const value = lookup(whole[1]!);
        return value === undefined ? v : value;
      }
      return v.replace(/\{\{([\w.]+)\}\}/g, (m, k: string) => {
        const value = lookup(k);
        return value === undefined ? m : typeof value === "string" ? value : JSON.stringify(value);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(template);
}
