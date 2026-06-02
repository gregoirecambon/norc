import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { appendAgent, readAgentsJson } from '../lib/env-file.js';

const NORC_DIR = join(homedir(), '.norc');
const SKILLS_DIR = join(NORC_DIR, 'skills');

const EXECUTION_PROTOCOL = `
## NORC Orchestration Protocol

You are registered as an agent in a NORC orchestration system.

When you receive a task that contains [NORC EXECUTION CONTRACT], follow these rules:

1. REPORT COMPLETION: When done, POST to the callback_url in the contract with:
   - status: "done" or "failed"
   - output: your full output text
   - summary: 1-2 sentence summary of what you did
   - next_agent: (optional) name of another agent to delegate to

   Example:
   curl -X POST {callback_url} \\
     -H "Authorization: Bearer {callback_token}" \\
     -H "Content-Type: application/json" \\
     -d '{"status":"done","output":"...","summary":"...", "next_agent": null}'

2. REPORT FAILURE: If you cannot complete, POST with status="failed" and a clear reason.
   Never silently stop.

3. DELEGATE WORK: If you need another agent, include their name in next_agent.
   NORC will dispatch them and pass your output as context.

4. CHECKPOINT: For long tasks (>5 min), POST to checkpoint_url after each major step:
   curl -X POST {checkpoint_url} \\
     -H "Authorization: Bearer {callback_token}" \\
     -H "Content-Type: application/json" \\
     -d '{"taskId":"{context_ref}","completedStep":1,"summary":"step complete"}'

5. STAY IN SCOPE: Only take actions relevant to the described task.
`;

export async function addAgent(
  name: string,
  technology: string,
  authEnv: string,
  contextLevel: 'task' | 'project' | 'strategic' = 'project'
): Promise<void> {
  await mkdir(SKILLS_DIR, { recursive: true });

  // Generate skill file
  const skillContent = `# NORC Agent Skill: ${name}

Technology: ${technology}
Specialty: ${name.replace(/-/g, ' ')} agent

${EXECUTION_PROTOCOL.trim()}
`;

  const skillPath = join(SKILLS_DIR, `${name}.md`);
  await writeFile(skillPath, skillContent);

  // Register in agents.json
  await appendAgent({
    name,
    orgDbPageId: '',
    adapter: 'ClaudeCodeAdapter',
    authEnv,
    timeoutMin: 30,
    contextLevel,
  });
}

export async function listAgents(): Promise<void> {
  const agents = await readAgentsJson();

  if (agents.length === 0) {
    console.log(chalk.dim('No agents registered. Run `norc agent add <name>`.'));
    return;
  }

  console.log('\n' + chalk.bold('Registered agents:\n'));
  for (const a of agents) {
    const skillPath = join(SKILLS_DIR, `${a.name}.md`);
    const hasSkill = existsSync(skillPath);
    console.log(
      chalk.green('  ◈ ') +
      chalk.bold(a.name) +
      chalk.dim(` [${a.adapter}]`) +
      (hasSkill ? chalk.dim(' · skill ✓') : chalk.yellow(' · skill missing'))
    );
    console.log(chalk.dim(`    Context: ${a.contextLevel} · Timeout: ${a.timeoutMin}min · Auth: ${a.authEnv}`));
  }
  console.log();
}

export async function testAgent(name: string): Promise<void> {
  const spinner = ora(`Sending test task to ${name}...`).start();

  try {
    const response = await fetch('http://localhost:3001/webhooks/notion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notion-signature': 'test-bypass',
      },
      body: JSON.stringify({
        type: 'page_updated',
        test_mode: true,
        properties: {
          Status: { select: { name: 'Ready' } },
          'Assigned Agent': { select: { name: name } },
        },
        entity: { id: 'test-task-id' },
      }),
    });

    if (response.ok) {
      spinner.succeed(`Test dispatch sent to ${name}`);
      console.log(chalk.dim('  Check `norc logs` to see the agent response.'));
    } else {
      spinner.fail(`Server returned ${response.status}. Is NORC running? Try: docker compose up -d`);
    }
  } catch (err: any) {
    spinner.fail('NORC not reachable: ' + err.message);
    console.log(chalk.dim('  Start NORC with: docker compose up -d'));
  }
}

export async function updateAgentSkill(name: string): Promise<void> {
  const agents = await readAgentsJson();
  const agent = agents.find(a => a.name === name);
  if (!agent) {
    console.error(chalk.red(`Agent "${name}" not found. Run \`norc agent list\` to see registered agents.`));
    return;
  }
  await addAgent(name, agent.adapter, agent.authEnv, agent.contextLevel);
  console.log(chalk.green(`✓ Skill file updated: ~/.norc/skills/${name}.md`));
}
