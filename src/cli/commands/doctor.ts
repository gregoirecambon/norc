import { execSync } from 'child_process';
import chalk from 'chalk';
import { readEnvVar } from '../lib/env-file.js';

function check(label: string, pass: boolean, detail?: string) {
  const icon = pass ? chalk.green('  ✓') : chalk.red('  ✗');
  console.log(icon + ' ' + label + (detail ? chalk.dim(' · ' + detail) : ''));
}

function command(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function urlReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

export async function runDoctor(): Promise<void> {
  console.log('\n' + chalk.bold('NORC Doctor\n'));

  // Dependencies
  console.log(chalk.dim('Dependencies:'));
  check('Docker', command('docker'));
  check('docker compose', (() => { try { execSync('docker compose version', { stdio: 'ignore' }); return true; } catch { return false; } })());
  check('Claude Code CLI (claude)', command('claude'), command('claude') ? '' : 'optional — install with npm i -g @anthropic-ai/claude-code');

  // Environment
  console.log('\n' + chalk.dim('Environment:'));
  const apiKey = await readEnvVar('NOTION_API_KEY');
  const webhookSecret = await readEnvVar('NOTION_WEBHOOK_SECRET');
  const orgDbId = await readEnvVar('NOTION_ORG_DB_ID');
  const tasksDbId = await readEnvVar('NOTION_TASKS_DB_ID');
  const publicUrl = await readEnvVar('NORC_PUBLIC_URL');
  const anthropicKey = await readEnvVar('ANTHROPIC_API_KEY');

  check('NOTION_API_KEY', !!apiKey, apiKey ? 'set' : 'missing — run norc init');
  check('NOTION_WEBHOOK_SECRET', !!webhookSecret, webhookSecret ? 'set' : 'missing');
  check('NOTION_ORG_DB_ID', !!orgDbId, orgDbId ? orgDbId.slice(0, 8) + '...' : 'missing');
  check('NOTION_TASKS_DB_ID', !!tasksDbId, tasksDbId ? tasksDbId.slice(0, 8) + '...' : 'missing');
  check('NORC_PUBLIC_URL', !!publicUrl, publicUrl ?? 'missing — Notion webhooks will not work');
  check('ANTHROPIC_API_KEY', !!anthropicKey, anthropicKey ? 'set' : 'missing — required for haiku orchestrator');

  // Services
  console.log('\n' + chalk.dim('Services:'));
  const engineUp = await urlReachable('http://localhost:3001/health');
  const dashboardUp = await urlReachable('http://localhost:3000');

  check('NORC engine (:3001)', engineUp, engineUp ? 'healthy' : 'offline — run: docker compose up -d');
  check('Dashboard (:3000)', dashboardUp, dashboardUp ? 'healthy' : 'offline — run: docker compose up -d');

  // Redis (via engine)
  if (engineUp) {
    try {
      const res = await fetch('http://localhost:3001/health');
      const data = await res.json() as any;
      check('Redis', data.redis === 'ok', data.redis === 'ok' ? 'connected' : 'connection issue');
    } catch {
      check('Redis', false, 'could not verify');
    }
  }

  const issues = [
    !apiKey, !webhookSecret, !orgDbId, !tasksDbId, !anthropicKey, !engineUp
  ].filter(Boolean).length;

  console.log('\n' + (issues === 0
    ? chalk.green('All checks passed.')
    : chalk.yellow(`${issues} issue${issues > 1 ? 's' : ''} found. Run \`norc init\` to resolve.`)) + '\n');
}
