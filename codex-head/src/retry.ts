export function computeRetryBackoffMs(attempt: number): number {
  const base = 15_000;
  const cap = 10 * 60 * 1000;
  return Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), cap);
}
