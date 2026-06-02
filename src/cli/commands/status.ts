import chalk from 'chalk';
import { readAgentsJson } from '../lib/env-file.js';

export async function showStatus(): Promise<void> {
  console.log('\n' + chalk.bold('NORC Status\n'));

  // Engine health
  try {
    const res = await fetch('http://localhost:3001/health');
    if (res.ok) {
      const data = await res.json() as any;
      console.log(chalk.green('  ● ') + chalk.bold('Engine') + chalk.dim(` running · ${data.ts}`));
    } else {
      console.log(chalk.red('  ● ') + chalk.bold('Engine') + chalk.dim(' unreachable'));
    }
  } catch {
    console.log(chalk.red('  ○ ') + chalk.bold('Engine') + chalk.dim(' offline'));
  }

  // Registered agents
  const agents = await readAgentsJson();
  if (agents.length > 0) {
    console.log('\n' + chalk.dim('  Agents:'));
    for (const a of agents) {
      console.log(chalk.dim(`    · ${a.name} [${a.contextLevel}]`));
    }
  }

  console.log('\n' + chalk.dim('  Dashboard: http://localhost:3000'));
  console.log(chalk.dim('  Logs:      norc logs'));
  console.log();
}

export async function tailLogs(agent?: string): Promise<void> {
  const filter = agent ? `[${agent}]` : null;

  try {
    const { EventSource } = await import('eventsource' as any);
    const url = 'http://localhost:3001/api/logs/stream' + (agent ? `?agent=${encodeURIComponent(agent)}` : '');
    const es = new EventSource(url);

    es.onmessage = (event: any) => {
      const line = event.data;
      if (filter && !line.includes(filter)) return;

      // Colour-code by status keyword
      if (line.includes('failed') || line.includes('error')) {
        console.log(chalk.red(line));
      } else if (line.includes('completed') || line.includes('done')) {
        console.log(chalk.green(line));
      } else if (line.includes('started') || line.includes('running')) {
        console.log(chalk.yellow(line));
      } else {
        console.log(chalk.dim(line));
      }
    };

    es.onerror = () => {
      console.error(chalk.red('Log stream disconnected. Is NORC running?'));
    };

    console.log(chalk.dim('Tailing logs' + (agent ? ` for ${agent}` : '') + ' (Ctrl+C to stop)...\n'));
  } catch {
    // Fallback: docker compose logs
    const { execSync } = await import('child_process');
    try {
      execSync('docker compose logs -f norc', { stdio: 'inherit' });
    } catch {
      console.error(chalk.red('Cannot stream logs. Start NORC with: docker compose up -d'));
    }
  }
}
