import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import ora from 'ora';
import { readInitState, markStepComplete, isStepComplete } from '../lib/init-state.js';
import { writeEnvVar, readEnvVar } from '../lib/env-file.js';
import { discoverNotionDatabases } from '../lib/notion-discovery.js';

const execAsync = promisify(exec);

const rl = createInterface({ input, output });
const ask = (q: string) => rl.question(chalk.cyan('? ') + q + ' ');

function check(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function step(n: number, label: string) {
  console.log('\n' + chalk.bold.white(`Step ${n}/6 — ${label}`));
}

function ok(msg: string) { console.log(chalk.green('  ✓ ') + msg); }
function warn(msg: string) { console.log(chalk.yellow('  ! ') + msg); }
function fail(msg: string) { console.log(chalk.red('  ✗ ') + msg); }
function hint(msg: string) { console.log(chalk.dim('    ' + msg)); }

export async function runInit(): Promise<void> {
  console.log('\n' + chalk.bold('NORC Setup') + chalk.dim(' — AI agent orchestration for Notion'));
  console.log(chalk.dim('Press Ctrl+C to pause. Re-run `norc init` to resume.\n'));

  const state = await readInitState();
  if (state.completedSteps.length > 0) {
    console.log(chalk.dim(`Resuming from step ${Math.max(...state.completedSteps) + 1}...\n`));
  }

  // ── Step 1: Dependencies ──────────────────────────────────────────────────
  if (!await isStepComplete(1)) {
    step(1, 'Dependencies');
    const hasDocker = check('docker');
    const hasDockerCompose = check('docker') && (() => { try { execSync('docker compose version', { stdio: 'ignore' }); return true; } catch { return false; } })();
    const hasClaude = check('claude');

    if (!hasDocker) {
      fail('Docker not found. Install at https://docker.com/get-started then re-run.');
      process.exit(1);
    }
    ok('Docker');

    if (!hasDockerCompose) {
      fail('`docker compose` not found. Update Docker Desktop or install Docker Compose v2.');
      process.exit(1);
    }
    ok('Docker Compose');

    if (!hasClaude) {
      warn('Claude Code CLI not found. Install it to use the ClaudeCodeAdapter.');
      hint('npm install -g @anthropic-ai/claude-code');
    } else {
      ok('Claude Code CLI');
    }

    await markStepComplete(1);
  } else {
    ok('Step 1 complete (dependencies)');
  }

  // ── Step 2: Network setup ─────────────────────────────────────────────────
  if (!await isStepComplete(2)) {
    step(2, 'Network setup');
    console.log(chalk.dim('  Notion needs a public HTTPS endpoint to deliver webhooks.\n'));
    console.log('  A) Cloudflare Tunnel ' + chalk.green('(recommended)') + ' — persistent, free');
    console.log('  B) ngrok — quick for dev, session expires');
    console.log('  C) I have a public domain already\n');

    const choice = await ask('Choose (A/B/C):');

    let publicUrl = '';
    if (choice.toUpperCase() === 'A') {
      const spinner = ora('Starting Cloudflare Tunnel...').start();
      try {
        if (!check('cloudflared')) {
          spinner.stop();
          warn('cloudflared not installed.');
          hint('brew install cloudflare/cloudflare/cloudflared  OR  visit cloudflare.com/products/tunnel');
          publicUrl = await ask('Enter your Cloudflare Tunnel URL (or press Enter to skip):');
        } else {
          const { stdout } = await execAsync('cloudflared tunnel --url http://localhost:3001 &');
          const match = stdout.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
          publicUrl = match?.[0] ?? '';
          spinner.succeed('Cloudflare Tunnel started: ' + publicUrl);
        }
      } catch { spinner.stop(); }
    } else if (choice.toUpperCase() === 'B') {
      publicUrl = await ask('Paste your ngrok URL (e.g. https://xxxx.ngrok.io):');
    } else {
      publicUrl = await ask('Enter your public domain (e.g. https://norc.example.com):');
    }

    if (publicUrl) {
      await writeEnvVar('NORC_PUBLIC_URL', publicUrl);
      ok('Public URL set: ' + publicUrl);
      await markStepComplete(2);
    } else {
      warn('No URL set. Webhook delivery will not work until NORC_PUBLIC_URL is configured.');
    }
  } else {
    const url = await readEnvVar('NORC_PUBLIC_URL');
    ok('Step 2 complete — ' + (url ?? 'URL configured'));
  }

  // ── Step 3: Notion OAuth app ──────────────────────────────────────────────
  if (!await isStepComplete(3)) {
    step(3, 'Notion OAuth app');
    console.log(chalk.dim('  Opening Notion developer console...\n'));

    try { execSync('open https://www.notion.so/my-integrations', { stdio: 'ignore' }); }
    catch { hint('Open https://www.notion.so/my-integrations in your browser'); }

    console.log(chalk.dim('  1. Click "New integration"'));
    console.log(chalk.dim('  2. Name it "NORC"'));
    console.log(chalk.dim('  3. Copy the Internal Integration Secret\n'));

    const apiKey = await ask('Paste your Notion API key (secret_...):');
    const webhookSecret = await ask('Paste a webhook secret (any random string, min 16 chars):');

    if (apiKey.startsWith('secret_') || apiKey.startsWith('ntn_')) {
      await writeEnvVar('NOTION_API_KEY', apiKey);
      await writeEnvVar('NOTION_WEBHOOK_SECRET', webhookSecret);
      ok('Notion credentials saved');
      await markStepComplete(3);
    } else {
      fail('API key should start with "secret_" or "ntn_". Please try again.');
      warn('Re-run `norc init` to retry this step.');
    }
  } else {
    ok('Step 3 complete (Notion OAuth)');
  }

  // ── Step 4: Notion template ───────────────────────────────────────────────
  if (!await isStepComplete(4)) {
    step(4, 'Notion workspace setup');
    console.log(chalk.dim('  Opening NORC Notion template...\n'));

    try { execSync('open https://notion.so/templates/norc-workspace', { stdio: 'ignore' }); }
    catch { hint('Open https://notion.so/templates/norc-workspace in your browser'); }

    console.log(chalk.dim('  1. Click "Duplicate" in Notion'));
    console.log(chalk.dim('  2. Open the duplicated workspace'));
    console.log(chalk.dim('  3. Copy the URL of the workspace\n'));

    await ask('Press Enter when you have duplicated the template...');

    const apiKey = await readEnvVar('NOTION_API_KEY');
    if (!apiKey) {
      warn('No API key found. Skipping auto-discovery — set database IDs manually in .env');
    } else {
      const spinner = ora('Discovering databases in your Notion workspace...').start();
      try {
        const dbs = await discoverNotionDatabases(apiKey);
        spinner.stop();

        if (dbs.orgDbId) { await writeEnvVar('NOTION_ORG_DB_ID', dbs.orgDbId); ok('Org DB found'); }
        else warn('Org DB not found — set NOTION_ORG_DB_ID manually');

        if (dbs.tasksDbId) { await writeEnvVar('NOTION_TASKS_DB_ID', dbs.tasksDbId); ok('Tasks DB found'); }
        else warn('Tasks DB not found — set NOTION_TASKS_DB_ID manually');

        if (dbs.projectsDbId) { await writeEnvVar('NOTION_PROJECTS_DB_ID', dbs.projectsDbId); ok('Projects DB found'); }
        else warn('Projects DB not found — set NOTION_PROJECTS_DB_ID manually');

        if (dbs.pipelineConfigDbId) { await writeEnvVar('NOTION_PIPELINE_CONFIG_DB_ID', dbs.pipelineConfigDbId); ok('Pipeline Config DB found'); }
        else warn('Pipeline Config DB not found — set NOTION_PIPELINE_CONFIG_DB_ID manually');

        await markStepComplete(4);
      } catch (err: any) {
        spinner.stop();
        fail('Discovery failed: ' + err.message);
        hint('Set NOTION_*_DB_ID values manually in .env');
      }
    }
  } else {
    ok('Step 4 complete (Notion template)');
  }

  // ── Step 5: Start the stack ───────────────────────────────────────────────
  if (!await isStepComplete(5)) {
    step(5, 'Start NORC');

    const spinner = ora('Starting Docker services...').start();
    try {
      execSync('docker compose up -d', { stdio: 'inherit' });
      spinner.succeed('NORC is running');

      await new Promise(r => setTimeout(r, 2000));
      const { stdout } = await execAsync('curl -sf http://localhost:3001/health || echo FAIL');
      if (stdout.includes('"status":"ok"')) {
        ok('Engine health check passed');
        await markStepComplete(5);
      } else {
        warn('Engine not responding yet. Check `docker compose logs norc`');
      }
    } catch (err: any) {
      spinner.stop();
      fail('Failed to start: ' + err.message);
      hint('Run `docker compose logs` to see what went wrong');
    }
  } else {
    ok('Step 5 complete (stack running)');
  }

  // ── Step 6: First agent ───────────────────────────────────────────────────
  if (!await isStepComplete(6)) {
    step(6, 'Register your first agent');

    const name = await ask('Agent name (e.g. claude-code):');
    const technology = await ask('Technology (Claude Code / Codex / Cursor / OpenClaw):');
    const authEnv = await ask('API key environment variable (e.g. ANTHROPIC_API_KEY):');

    // Import and run the agent add command
    const { addAgent } = await import('./agent.js');
    await addAgent(name, technology, authEnv);

    ok(`Agent "${name}" registered`);
    console.log(chalk.dim('\n  Add this to your project\'s CLAUDE.md:'));
    console.log(chalk.cyan(`  Skill: ~/.norc/skills/${name}.md\n`));

    await markStepComplete(6);
  } else {
    ok('Step 6 complete (first agent registered)');
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  const publicUrl = await readEnvVar('NORC_PUBLIC_URL') ?? 'http://localhost:3000';
  console.log('\n' + chalk.bold.green('NORC is ready!'));
  console.log(chalk.dim('  Mention @[your-agent] anywhere in Notion to trigger a task.'));
  console.log(chalk.dim('  Dashboard: ') + chalk.cyan('http://localhost:3000'));
  console.log(chalk.dim('  Logs:      ') + chalk.cyan('norc logs'));
  console.log(chalk.dim('  Status:    ') + chalk.cyan('norc status\n'));

  try { execSync(`open http://localhost:3000`, { stdio: 'ignore' }); } catch {}
  rl.close();
}
