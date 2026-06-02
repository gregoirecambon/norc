import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import {
  readConfig,
  writeConfig,
  setConfigValue,
  generateWebhookSecret,
} from '../lib/config.js';
import { readInitState, markStepComplete, isStepComplete } from '../lib/init-state.js';
import { createNorcDatabases, registerWebhook } from '../lib/notion-setup.js';
import { Client } from '@notionhq/client';

const rl = createInterface({ input, output });
const ask = (q: string) => rl.question(chalk.cyan('? ') + q + ' ');

function cmd(c: string): boolean {
  try { execSync(`which ${c}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function ok(msg: string)   { console.log(chalk.green('  ✓ ') + msg); }
function warn(msg: string) { console.log(chalk.yellow('  ! ') + msg); }
function fail(msg: string) { console.log(chalk.red('  ✗ ') + msg); }
function hint(msg: string) { console.log(chalk.dim('    ' + msg)); }
function step(n: number, label: string) {
  console.log('\n' + chalk.bold.white(`Step ${n}/5 — ${label}`));
}

export async function runInit(): Promise<void> {
  console.log('\n' + chalk.bold('NORC Setup'));
  console.log(chalk.dim('Press Ctrl+C at any time to pause. Re-run `norc init` to resume.\n'));

  const state = await readInitState();
  if (state.completedSteps.length > 0) {
    console.log(chalk.dim(`Resuming from step ${Math.max(...state.completedSteps) + 1}...\n`));
  }

  // ── Step 1: Dependencies ─────────────────────────────────────────────────
  if (!await isStepComplete(1)) {
    step(1, 'Dependencies');

    const hasDocker = cmd('docker');
    const hasCompose = hasDocker && (() => {
      try { execSync('docker compose version', { stdio: 'ignore' }); return true; }
      catch { return false; }
    })();

    if (!hasDocker) {
      fail('Docker not found.');
      hint('Install: https://docs.docker.com/get-docker/');
      process.exit(1);
    }
    ok('Docker');

    if (!hasCompose) {
      fail('`docker compose` not found. Update Docker Desktop to v4+.');
      process.exit(1);
    }
    ok('Docker Compose');

    if (!cmd('claude')) {
      warn('Claude Code CLI not found (optional for ClaudeCodeAdapter).');
      hint('npm install -g @anthropic-ai/claude-code');
    } else {
      ok('Claude Code CLI');
    }

    await markStepComplete(1);
  } else {
    ok('Step 1 complete (dependencies)');
  }

  // ── Step 2: Network ──────────────────────────────────────────────────────
  if (!await isStepComplete(2)) {
    step(2, 'Network');
    console.log(chalk.dim('  Notion needs a public HTTPS URL to deliver webhooks.'));
    console.log(chalk.dim('  Set NORC_PUBLIC_URL in your .env file before starting Docker.\n'));

    const publicUrl = process.env.NORC_PUBLIC_URL;
    if (!publicUrl) {
      warn('NORC_PUBLIC_URL is not set in .env.');
      hint('Add it now, then re-run `norc init`.');
      hint('Examples:');
      hint('  Cloudflare Tunnel: cloudflared tunnel --url http://localhost:3001');
      hint('  ngrok:             ngrok http 3001');
      const manual = await ask('Or enter your public URL now (leave empty to skip):');
      if (manual.startsWith('http')) {
        process.env.NORC_PUBLIC_URL = manual;
        ok('URL set for this session (add it to .env to persist)');
      } else {
        warn('Skipping. Webhooks will not work until NORC_PUBLIC_URL is set.');
      }
    } else {
      ok('Public URL: ' + publicUrl);
    }

    await markStepComplete(2);
  } else {
    ok('Step 2 complete (network)');
  }

  // ── Step 3: Notion ───────────────────────────────────────────────────────
  if (!await isStepComplete(3)) {
    step(3, 'Notion');

    // 3a — API key
    console.log(chalk.dim('\n  3a. Create a Notion integration'));
    console.log(chalk.dim('  Opening notion.so/my-integrations...'));
    try { execSync('open https://www.notion.so/my-integrations', { stdio: 'ignore' }); }
    catch { hint('Open https://www.notion.so/my-integrations'); }
    hint('Click "New integration" → give it a name → copy the secret.');

    const apiKey = await ask('\n  Paste your Notion API key (secret_... or ntn_...):');
    if (!apiKey.startsWith('secret_') && !apiKey.startsWith('ntn_')) {
      fail('Key should start with secret_ or ntn_. Try again.');
      rl.close();
      return;
    }

    // 3b — Generate webhook secret (NORC-owned)
    const webhookSecret = generateWebhookSecret();
    console.log('\n  ' + chalk.bold('Your NORC webhook secret (generated):'));
    console.log('  ' + chalk.cyan(webhookSecret));
    console.log(chalk.dim('  You will enter this in Notion when registering the webhook (step 5).'));
    console.log(chalk.dim('  NORC stores it automatically — you never need to add it to .env.\n'));

    // 3c — Parent page for databases
    console.log(chalk.dim('  3b. Share a Notion page with your integration'));
    hint('In Notion: open any page → ··· → Connections → add your integration');
    hint('Then copy that page\'s URL');
    const parentUrl = await ask('\n  Paste the URL of the shared page:');
    const pageIdMatch = parentUrl.match(/([a-f0-9]{32})/i) ?? parentUrl.match(/([a-f0-9-]{36})/i);
    if (!pageIdMatch) {
      fail('Could not extract a page ID from that URL.');
      rl.close();
      return;
    }
    const parentPageId = pageIdMatch[1].replace(/-/g, '');

    // 3d — Create all 4 databases
    const spinner = ora('Creating NORC databases in your Notion workspace...').start();
    try {
      const dbs = await createNorcDatabases(apiKey, parentPageId);
      spinner.succeed('Databases created');
      ok('Org DB');
      ok('Tasks');
      ok('Projects');
      ok('Pipeline Config');

      // Attempt auto-register webhook
      const publicUrl = process.env.NORC_PUBLIC_URL;
      let webhookRegistered = false;
      if (publicUrl) {
        const webhookSpinner = ora('Registering Notion webhook...').start();
        const webhookId = await registerWebhook(apiKey, dbs.tasksDbId, publicUrl, webhookSecret);
        if (webhookId) {
          webhookSpinner.succeed('Webhook registered automatically');
          webhookRegistered = true;
        } else {
          webhookSpinner.warn('Auto-registration failed — you will register manually (step 5)');
        }
      }

      // Save everything to config.json — no env vars needed by the user
      await writeConfig({
        notionApiKey: apiKey,
        notionWebhookSecret: webhookSecret,
        notionOrgDbId: dbs.orgDbId,
        notionTasksDbId: dbs.tasksDbId,
        notionProjectsDbId: dbs.projectsDbId,
        notionPipelineConfigDbId: dbs.pipelineConfigDbId,
        notionParentPageId: parentPageId,
      });

      if (!webhookRegistered) {
        console.log('\n  ' + chalk.bold('Manual webhook setup required:'));
        hint('Go to notion.so/my-integrations → your integration → Webhooks');
        hint('URL:    ' + (publicUrl ?? 'NORC_PUBLIC_URL') + '/webhooks/notion');
        hint('Secret: ' + webhookSecret);
        hint('Events: page updated, comment created');
        hint('Scope:  Tasks database');
      }

      await markStepComplete(3);
    } catch (err: any) {
      spinner.fail('Failed: ' + err.message);
      hint('Check that you shared the page with your integration and the API key is correct.');
      rl.close();
      return;
    }
  } else {
    ok('Step 3 complete (Notion + databases)');
  }

  // ── Step 4: Start the stack ──────────────────────────────────────────────
  if (!await isStepComplete(4)) {
    step(4, 'Start NORC');

    const spinner = ora('Starting Docker services (Redis + engine + dashboard)...').start();
    try {
      execSync('docker compose up -d', { stdio: 'inherit' });
      spinner.succeed('Services started');

      // Wait briefly for the engine to boot
      await new Promise(r => setTimeout(r, 3000));
      const { execSync: ex } = await import('child_process');
      try {
        ex('curl -sf http://localhost:3001/health > /dev/null');
        ok('Engine health check passed');
        await markStepComplete(4);
      } catch {
        warn('Engine not responding yet — check `docker compose logs norc`');
      }
    } catch (err: any) {
      spinner.fail(err.message);
      hint('Run `docker compose logs` to diagnose.');
    }
  } else {
    ok('Step 4 complete (stack running)');
  }

  // ── Step 5: First agent ──────────────────────────────────────────────────
  if (!await isStepComplete(5)) {
    step(5, 'Register your first agent');

    const name     = await ask('Agent name (e.g. claude-code):');
    const tech     = await ask('Technology (Claude Code / Codex / Cursor / OpenClaw):');
    const authEnv  = await ask('API key env var (e.g. ANTHROPIC_API_KEY):');

    const { addAgent } = await import('./agent.js');
    await addAgent(name, tech, authEnv);

    ok(`Agent "${name}" registered`);
    console.log(chalk.dim('\n  Add this line to your project\'s CLAUDE.md:'));
    console.log(chalk.cyan(`  Skill: ~/.norc/skills/${name}.md\n`));

    await markStepComplete(5);
  } else {
    ok('Step 5 complete (first agent registered)');
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('\n' + chalk.bold.green('NORC is ready!'));
  console.log(chalk.dim('  Mention @[your-agent] anywhere in Notion to start a task.'));
  console.log(chalk.dim('  Dashboard: ') + chalk.cyan('http://localhost:3000'));
  console.log(chalk.dim('  Logs:      ') + chalk.cyan('norc logs'));
  console.log(chalk.dim('  Status:    ') + chalk.cyan('norc status\n'));

  try { execSync('open http://localhost:3000', { stdio: 'ignore' }); } catch {}
  rl.close();
}
