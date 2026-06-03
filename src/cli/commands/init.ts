import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { config as dotenvConfig } from 'dotenv';
import {
  readConfig,
  writeConfig,
  setConfigValue,
} from '../lib/config.js';
import { readInitState, markStepComplete, isStepComplete } from '../lib/init-state.js';
import { createNorcDatabases } from '../lib/notion-setup.js';
import { writeEnvVar } from '../lib/env-file.js';

// NOTE: readline is NOT created at module level.
// execSync with stdio:'inherit' (or sharing stdin) corrupts a module-level readline.
// Each step creates its own rl instance and closes it before any subprocess runs.

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

// Poll GET /api/init/verify-token every 2s until Notion delivers the verification token.
async function pollForVerificationToken(timeoutMs = 5 * 60 * 1000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://localhost:3001/api/init/verify-token');
      if (res.ok) {
        const data = await res.json() as { token: string | null };
        if (data.token) return data.token;
      }
    } catch { /* engine not ready yet — keep polling */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

export async function runInit(): Promise<void> {
  // Load .env so NORC_PUBLIC_URL is available even when resuming mid-wizard
  dotenvConfig();

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

    const rl2 = createInterface({ input, output });
    const ask2 = (q: string) => rl2.question(chalk.cyan('? ') + q + ' ');

    const publicUrl = process.env.NORC_PUBLIC_URL;
    if (!publicUrl) {
      warn('NORC_PUBLIC_URL is not set in .env.');
      hint('Add it now, then re-run `norc init`.');
      hint('Examples:');
      hint('  Cloudflare Tunnel: cloudflared tunnel --url http://localhost:3001');
      hint('  ngrok:             ngrok http 3001');
      const manual = await ask2('Or enter your public URL now (leave empty to skip):');
      if (manual.startsWith('http')) {
        process.env.NORC_PUBLIC_URL = manual;
        await writeEnvVar('NORC_PUBLIC_URL', manual);
        ok('URL saved to .env: ' + manual);
      } else {
        warn('Skipping. Webhooks will not work until NORC_PUBLIC_URL is set.');
      }
    } else {
      ok('Public URL: ' + publicUrl);
    }

    rl2.close();
    await markStepComplete(2);
  } else {
    ok('Step 2 complete (network)');
  }

  // ── Step 3: Notion API key + Databases ──────────────────────────────────
  // Webhook registration happens in Step 5 (after Docker starts in Step 4).
  if (!await isStepComplete(3)) {
    step(3, 'Notion');

    const rl3 = createInterface({ input, output });
    const ask3 = (q: string) => rl3.question(chalk.cyan('? ') + q + ' ');

    console.log(chalk.dim('\n  3a. Create a Notion integration'));
    console.log(chalk.dim('  Opening notion.so/my-integrations...'));
    try { execSync('open https://www.notion.so/my-integrations', { stdio: 'ignore' }); }
    catch { hint('Open https://www.notion.so/my-integrations'); }
    hint('Click "New integration" → give it a name → copy the secret.');

    const apiKey = await ask3('\n  Paste your Notion API key (secret_... or ntn_...):');
    if (!apiKey.startsWith('secret_') && !apiKey.startsWith('ntn_')) {
      fail('Key should start with secret_ or ntn_. Try again.');
      rl3.close();
      return;
    }

    console.log(chalk.dim('\n  3b. Share a Notion page with your integration'));
    hint('In Notion: open any page → ··· → Connections → add your integration');
    hint('Then copy that page\'s URL');
    const parentUrl = await ask3('\n  Paste the URL of the shared page:');
    const pageIdMatch = parentUrl.match(/([a-f0-9]{32})/i) ?? parentUrl.match(/([a-f0-9-]{36})/i);
    if (!pageIdMatch) {
      fail('Could not extract a page ID from that URL.');
      rl3.close();
      return;
    }
    const parentPageId = pageIdMatch[1].replace(/-/g, '');

    rl3.close();

    const spinner = ora('Creating NORC databases in your Notion workspace...').start();
    try {
      const dbs = await createNorcDatabases(apiKey, parentPageId);
      spinner.succeed('Databases created');
      ok('Org DB');
      ok('Tasks');
      ok('Projects');
      ok('Pipeline Config');

      // Save API key + DB IDs now. Webhook secret is saved in Step 5 after Docker is running.
      await writeConfig({
        notionApiKey: apiKey,
        notionOrgDbId: dbs.orgDbId,
        notionTasksDbId: dbs.tasksDbId,
        notionProjectsDbId: dbs.projectsDbId,
        notionPipelineConfigDbId: dbs.pipelineConfigDbId,
        notionParentPageId: parentPageId,
      });

      await markStepComplete(3);
    } catch (err: any) {
      spinner.fail('Failed: ' + err.message);
      hint('Check that you shared the page with your integration and the API key is correct.');
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
      // Use ['ignore', 'inherit', 'inherit'] — NOT 'inherit'.
      // Passing stdin to Docker corrupts the readline state in subsequent steps.
      execSync('docker compose up -d', { stdio: ['ignore', 'inherit', 'inherit'] });
      spinner.succeed('Services started');

      await new Promise(r => setTimeout(r, 3000));
      try {
        execSync('curl -sf http://localhost:3001/health', { stdio: 'ignore' });
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

  // ── Step 5: Webhook verification + First agent ───────────────────────────
  // Resuming at Step 5 is safe:
  //   - Webhook verification: user clicks "Verify" again in Notion (idempotent)
  //   - Agent registration: appendAgent() overwrites by name (idempotent)
  if (!await isStepComplete(5)) {
    step(5, 'Connect Notion webhooks + Register your first agent');

    const webhookUrl = `${process.env.NORC_PUBLIC_URL ?? 'YOUR_PUBLIC_URL'}/webhooks/notion`;

    // ── 5a: Webhook verification ─────────────────────────────────────────
    console.log('\n  ' + chalk.bold('5a. Set up the Notion webhook'));
    console.log(chalk.dim('  The NORC engine is running and ready to receive Notion\'s verification ping.\n'));

    hint('1. Go to: notion.so/my-integrations → your integration → Webhooks tab');
    hint('2. Click "Add webhook"');
    hint('3. Enter this URL:');
    console.log('     ' + chalk.cyan(webhookUrl));
    hint('4. Click "Verify" — Notion will POST a verification token to NORC');
    console.log();

    const verifySpinner = ora('Waiting for Notion to send the verification token (up to 5 min)...').start();
    const token = await pollForVerificationToken(5 * 60 * 1000);

    if (!token) {
      verifySpinner.fail('Timed out waiting for Notion verification token.');
      hint('Make sure the URL is correct and reachable from the internet (`curl ' + webhookUrl.replace('/webhooks/notion', '/health') + '`).');
      hint('Re-run `norc init` to try again — Docker will still be running.');
      return;
    }

    verifySpinner.succeed('Verification token received from Notion!');

    console.log('\n  ' + chalk.bold('Paste this token back into Notion to complete verification:'));
    console.log('\n  ' + chalk.cyan.bold(token) + '\n');
    hint('(This is also your webhook signing secret — NORC stores it automatically)');

    await setConfigValue('notionWebhookSecret', token);
    ok('Webhook secret saved to ~/.norc/config.json');

    // Restart the NORC container so it loads the new webhook secret via loadConfigIntoEnv().
    // Without this, HMAC validation would fail on the first real Notion event.
    console.log(chalk.dim('\n  Restarting NORC engine to load webhook secret...'));
    try {
      execSync('docker compose restart norc', { stdio: ['ignore', 'inherit', 'inherit'] });
      ok('NORC engine restarted');
    } catch {
      warn('Could not restart automatically — run `docker compose restart norc` manually');
    }

    // ── 5b: First agent ─────────────────────────────────────────────────
    // Create readline AFTER all execSync calls — stdin is clean at this point.
    const rl5 = createInterface({ input, output });
    const ask5 = (q: string) => rl5.question(chalk.cyan('? ') + q + ' ');

    console.log('\n  ' + chalk.bold('5b. Confirm token + Register your first agent'));
    await ask5('Press Enter once you have pasted the token into Notion and clicked Save:');

    const name    = await ask5('Agent name (e.g. claude-code):');
    const tech    = await ask5('Technology (Claude Code / Codex / Cursor / OpenClaw):');
    const authEnv = await ask5('API key env var (e.g. ANTHROPIC_API_KEY):');

    rl5.close();

    const { addAgent } = await import('./agent.js');
    await addAgent(name, tech, authEnv);

    ok(`Agent "${name}" registered`);
    console.log(chalk.dim('\n  Add this line to your project\'s CLAUDE.md:'));
    console.log(chalk.cyan(`  Skill: ~/.norc/skills/${name}.md\n`));

    await markStepComplete(5);
  } else {
    ok('Step 5 complete (webhook connected + first agent registered)');
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('\n' + chalk.bold.green('NORC is ready!'));
  console.log(chalk.dim('  Mention @[your-agent] anywhere in Notion to start a task.'));
  console.log(chalk.dim('  Dashboard: ') + chalk.cyan('http://localhost:3000'));
  console.log(chalk.dim('  Logs:      ') + chalk.cyan('norc logs'));
  console.log(chalk.dim('  Status:    ') + chalk.cyan('norc status\n'));

  try { execSync('open http://localhost:3000', { stdio: 'ignore' }); } catch {}
}
