export function taskRequestKey(teamId: string, offset: number, limit: number): string {
  return JSON.stringify([teamId, offset, limit]);
}
