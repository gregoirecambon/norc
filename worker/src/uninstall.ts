import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerConfig } from './config.js';
import { log } from './log.js';

/** systemd-run lets us launch the teardown in a SEPARATE transient scope (its own
 * cgroup) so stopping the worker's own `norc-worker` service doesn't also kill the
 * teardown mid-run. Only relevant on Linux/systemd. */
function systemdRunAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemd-run', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tear this worker down from the inside: stop+disable its background service, delete
 * its files, then exit. Triggered by NORC's `norc_uninstall` (the dashboard's one-click
 * Remove). The teardown runs in a DETACHED process — and, under systemd, in its own
 * scope — so it survives the worker/service it is stopping. Deleting worker.mjs +
 * credentials.json guarantees the worker can't run or re-register even if a service
 * unit lingers.
 */
export function startSelfUninstall(config: WorkerConfig): void {
  const workerMjs = path.join(config.workDir, 'worker.mjs');
  const selfEntry = process.argv[1] && process.argv[1].endsWith('worker.mjs') ? process.argv[1] : '';
  const scriptPath = path.join(config.workDir, 'uninstall-run.sh');
  const q = (s: string) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;

  const script = [
    '#!/bin/bash',
    'set +e',
    'sleep 2', // let the worker flush its 202 response and start exiting
    '# systemd user service (the conventional name from the install prompt)',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl --user stop norc-worker 2>/dev/null',
    '  systemctl --user disable norc-worker 2>/dev/null',
    '  rm -f "$HOME/.config/systemd/user/norc-worker.service"',
    '  systemctl --user daemon-reload 2>/dev/null',
    'fi',
    '# macOS launchd: unload + remove any norc LaunchAgent',
    'if command -v launchctl >/dev/null 2>&1; then',
    '  for p in "$HOME/Library/LaunchAgents/"*norc*; do',
    '    [ -e "$p" ] || continue',
    '    launchctl unload "$p" 2>/dev/null',
    '    rm -f "$p"',
    '  done',
    'fi',
    '# kill any stray worker process (match its actual entry path)',
    `pkill -f ${q(workerMjs)} 2>/dev/null`,
    selfEntry && selfEntry !== workerMjs ? `pkill -f ${q(selfEntry)} 2>/dev/null` : '',
    '# remove worker files (leave ~/.claude — that is Claude Code\'s own data)',
    `rm -f ${q(workerMjs)} ${q(config.credentialsFile)} ${q(config.sessionsFile)}`,
    selfEntry ? `rm -f ${q(selfEntry)}` : '',
    `rm -f ${q(scriptPath)}`,
    '',
  ].filter(Boolean).join('\n');

  try {
    writeFileSync(scriptPath, script, { mode: 0o700 });
  } catch (err) {
    log(`uninstall: failed to write teardown script: ${err instanceof Error ? err.message : 'unknown'}`);
    return;
  }

  const useSystemdRun = systemdRunAvailable();
  let cmd: string;
  let args: string[];
  if (useSystemdRun) {
    cmd = 'systemd-run';
    args = ['--user', '--scope', '--quiet', '--collect', '/bin/bash', scriptPath];
  } else {
    cmd = '/bin/bash';
    args = [scriptPath];
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env } });
    child.unref();
    log(`uninstall: launched teardown (${useSystemdRun ? 'systemd-run scope' : 'detached'}) — exiting shortly`);
  } catch (err) {
    log(`uninstall: failed to launch teardown: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // Exit so the service can be stopped cleanly; the detached teardown finishes the job.
  setTimeout(() => process.exit(0), 4000);
}
