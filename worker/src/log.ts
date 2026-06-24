/** Minimal timestamped stdout logger — the worker runs as a long-lived service. */
export function log(msg: string): void {
  console.log(`[norc-claude-worker ${new Date().toISOString()}] ${msg}`);
}
