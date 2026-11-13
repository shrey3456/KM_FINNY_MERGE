// A login PIN is exactly 4 digits, and no digit may appear more than twice:
// 2244 and 1212 are fine, 2221 and 7777 are not.
export const PIN_MAX_SAME_DIGIT = 2;

// Returns why the PIN is not allowed, or null when it is fine.
export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "PIN must be exactly 4 digits";
  const counts = new Map<string, number>();
  for (const d of pin) counts.set(d, (counts.get(d) ?? 0) + 1);
  for (const [digit, n] of Array.from(counts)) {
    if (n > PIN_MAX_SAME_DIGIT) return `PIN can't use the digit ${digit} more than ${PIN_MAX_SAME_DIGIT} times`;
  }
  return null;
}
