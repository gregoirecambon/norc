#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('norc')
  .description('Notion Orchestration for AI Agents')
  .version('0.1.0');

// norc init
program
  .command('init')
  .description('Set up NORC — interactive 6-step wizard')
  .option('--reset', 'Start from scratch, ignoring saved progress')
  .action(async (opts) => {
    if (opts.reset) {
      const { resetInitState } = await import('./lib/init-state.js');
      await resetInitState();
    }
    const { runInit } = await import('./commands/init.js');
    await runInit();
  });

// norc agent
const agentCmd = program.command('agent').description('Manage AI agents');

agentCmd
  .command('add <name>')
  .description('Register a new agent (interactive)')
  .option('-t, --technology <tech>', 'Agent technology (e.g. "Claude Code")')
  .option('-a, --auth-env <env>', 'API key environment variable (e.g. ANTHROPIC_API_KEY)')
  .option('-c, --context-level <level>', 'Context level: task | project | strategic', 'project')
  .action(async (name, opts) => {
    const { createInterface } = await import('readline/promises');
    const { stdin: input, stdout: output } = await import('process');
    const rl = createInterface({ input, output });
    const ask = (q: string) => rl.question(chalk.cyan('? ') + q + ' ');

    const technology = opts.technology ?? await ask('Technology (e.g. Claude Code, Codex, Cursor):');
    const authEnv = opts.authEnv ?? await ask('API key environment variable (e.g. ANTHROPIC_API_KEY):');
    rl.close();

    const { addAgent } = await import('./commands/agent.js');
    await addAgent(name, technology, authEnv, opts.contextLevel);

    console.log(chalk.green(`\n✓ Agent "${name}" registered`));
    console.log(chalk.dim(`  Skill file: ~/.norc/skills/${name}.md`));
    console.log(chalk.dim(`  Add to CLAUDE.md: Skill: ~/.norc/skills/${name}.md\n`));
  });

agentCmd
  .command('list')
  .description('List all registered agents')
  .action(async () => {
    const { listAgents } = await import('./commands/agent.js');
    await listAgents();
  });

agentCmd
  .command('test <name>')
  .description('Send a test task to an agent')
  .action(async (name) => {
    const { testAgent } = await import('./commands/agent.js');
    await testAgent(name);
  });

agentCmd
  .command('update <name>')
  .description('Regenerate the skill file for an agent')
  .action(async (name) => {
    const { updateAgentSkill } = await import('./commands/agent.js');
    await updateAgentSkill(name);
  });

// norc run
program
  .command('run <notion-url>')
  .description('Manually trigger an agent on a Notion page (bypass @mention)')
  .option('-a, --agent <name>', 'Agent name to dispatch')
  .action(async (notionUrl, opts) => {
    const pageIdMatch = notionUrl.match(/([a-f0-9]{32}|[a-f0-9-]{36})/i);
    if (!pageIdMatch) {
      console.error(chalk.red('Could not extract a page ID from the URL'));
      process.exit(1);
    }
    const pageId = pageIdMatch[1].replace(/-/g, '');
    console.log(chalk.dim(`Dispatching to page ${pageId}...`));

    try {
      const res = await fetch(`http://localhost:3001/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId, agentName: opts.agent }),
      });
      if (res.ok) {
        console.log(chalk.green('✓ Dispatch queued. Run `norc logs` to follow.'));
      } else {
        const body = await res.text();
        console.error(chalk.red(`Server error ${res.status}: ${body}`));
      }
    } catch (err: any) {
      console.error(chalk.red('NORC not reachable: ' + err.message));
      console.log(chalk.dim('Start NORC with: docker compose up -d'));
    }
  });

// norc logs
program
  .command('logs')
  .description('Tail the NORC log stream')
  .option('-a, --agent <name>', 'Filter by agent name')
  .action(async (opts) => {
    const { tailLogs } = await import('./commands/status.js');
    await tailLogs(opts.agent);
  });

// norc status
program
  .command('status')
  .description('Show running jobs, queued callbacks, and agent statuses')
  .action(async () => {
    const { showStatus } = await import('./commands/status.js');
    await showStatus();
  });

// norc doctor
program
  .command('doctor')
  .description('Check configuration, Notion auth, Redis, and callback endpoint')
  .action(async () => {
    const { runDoctor } = await import('./commands/doctor.js');
    await runDoctor();
  });

program.parse();
