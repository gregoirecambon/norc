import Anthropic from '@anthropic-ai/sdk';
import { getTask, getProject } from './client.js';
import { getCachedAgents } from './org-cache.js';
import type { ContextAssembly } from '../types/index.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function summarizeIfNeeded(text: string, maxTokens: number): Promise<string> {
  if (estimateTokens(text) <= maxTokens) return text;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: `Summarize this document in under 800 words. Preserve all KPIs, objectives, and actionable details.\n\n${text}`,
      },
    ],
  });

  return response.content[0].type === 'text' ? response.content[0].text : text.slice(0, maxTokens * 4);
}

async function getCompanyContext(): Promise<{ vision: string | null; objectives: string | null }> {
  const pageId = process.env.NORC_COMPANY_PAGE_ID;
  if (!pageId) return { vision: null, objectives: null };

  try {
    const { Client } = await import('@notionhq/client');
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    const page = await notion.pages.retrieve({ page_id: pageId }) as any;
    const content = page.properties?.Content?.rich_text?.[0]?.plain_text ?? '';
    const lines = content.split('\n');
    return {
      vision: lines[0] ?? null,
      objectives: lines.slice(1).join('\n') || null,
    };
  } catch {
    return { vision: null, objectives: null };
  }
}

// Extract prior agent outputs from the same task (comments tagged "@[Agent] said:")
async function getPriorAgentOutputs(taskId: string): Promise<string[]> {
  try {
    const { Client } = await import('@notionhq/client');
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    const comments = await notion.comments.list({ block_id: taskId }) as any;

    return (comments.results ?? [])
      .filter((c: any) => {
        const text = c.rich_text?.[0]?.plain_text ?? '';
        return text.includes('said:') || text.includes('completed') || text.includes('checkpoint');
      })
      .map((c: any) => c.rich_text?.[0]?.plain_text ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function assembleContext(
  taskId: string,
  agentName: string,
  contextLevel: 'task' | 'project' | 'strategic'
): Promise<ContextAssembly> {
  const task = await getTask(taskId);

  const [priorOutputs, allAgents] = await Promise.all([
    getPriorAgentOutputs(taskId),
    getCachedAgents(),
  ]);

  let project = null;
  if (task.projectId && contextLevel !== 'task') {
    project = await getProject(task.projectId);
    // Summarize large project docs to stay under 150k tokens total
    if (project.docs) {
      project.docs = await summarizeIfNeeded(project.docs, 30000);
    }
  }

  let companyVision = null;
  let companyObjectives = null;
  if (contextLevel === 'strategic') {
    const company = await getCompanyContext();
    companyVision = company.vision;
    companyObjectives = company.objectives;
  }

  const agentRecord = allAgents.find(a => a.name.toLowerCase().includes(agentName.toLowerCase()));

  return {
    taskId,
    taskName: task.name,
    taskKpis: task.kpis,
    project,
    priorAgentOutputs: priorOutputs,
    agentPersona: agentRecord?.specialty ?? '',
    availableAgents: allAgents.map(a => ({ name: a.name, specialty: a.specialty })),
    companyVision,
    companyObjectives,
    contextLevel,
  };
}

export function buildPrompt(ctx: ContextAssembly, contract: object): string {
  const sections: string[] = [];

  if (ctx.agentPersona) {
    sections.push(`You are: ${ctx.agentPersona}`);
  }

  if (ctx.companyVision) {
    sections.push(`[COMPANY VISION]\n${ctx.companyVision}`);
  }

  if (ctx.companyObjectives) {
    sections.push(`[COMPANY OBJECTIVES]\n${ctx.companyObjectives}`);
  }

  if (ctx.project) {
    sections.push(`[PROJECT: ${ctx.project.name}]\nObjective: ${ctx.project.objective}\nKPIs: ${ctx.project.kpis}`);
    if (ctx.project.docs) {
      sections.push(`[PROJECT DOCUMENTATION]\n${ctx.project.docs}`);
    }
  }

  if (ctx.priorAgentOutputs.length > 0) {
    sections.push(`[PRIOR WORK ON THIS TASK]\n${ctx.priorAgentOutputs.join('\n\n')}`);
  }

  sections.push(`[YOUR TASK]\n${ctx.taskName}`);

  if (ctx.taskKpis) {
    sections.push(`[SUCCESS CRITERIA — this task succeeds when ALL of the following are true]\n${ctx.taskKpis}`);
  }

  if (ctx.availableAgents.length > 1) {
    const others = ctx.availableAgents.filter(a => !a.name.toLowerCase().includes(ctx.agentPersona.toLowerCase()));
    if (others.length > 0) {
      sections.push(`[AVAILABLE AGENTS — mention them in your output to delegate]\n${others.map(a => `- ${a.name}: ${a.specialty}`).join('\n')}`);
    }
  }

  sections.push(`[NORC ORCHESTRATION PROTOCOL]\n${JSON.stringify(contract, null, 2)}`);

  sections.push(`[REQUIRED OUTPUT FORMAT]
When your task is complete, you MUST emit this sentinel as the last line of your output:
NORC_OUTPUT: {"status":"done","summary":"<1-2 sentence summary>","next_agent":null}

If you need to delegate to another agent, set next_agent to their name:
NORC_OUTPUT: {"status":"done","summary":"<summary>","next_agent":"<agent-name>"}

If the task failed:
NORC_OUTPUT: {"status":"failed","summary":"<reason>","next_agent":null}

This sentinel line is machine-parsed. Do not omit it, wrap it in markdown, or add text after it.`);

  return sections.join('\n\n---\n\n');
}
