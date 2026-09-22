export function kstDate(date = new Date()): string {
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
export function kstIso(date = new Date()): string {
  return (
    new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 23) +
    "+09:00"
  );
}
export function weekStart(date = new Date()): string {
  const shifted = new Date(date.getTime() + 9 * 3600_000);
  shifted.setUTCDate(shifted.getUTCDate() - ((shifted.getUTCDay() + 6) % 7));
  return shifted.toISOString().slice(0, 10);
}
