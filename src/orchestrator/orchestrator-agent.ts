import Anthropic from '@anthropic-ai/sdk';
import { findAgentByName } from '../notion/org-cache.js';
import type { OrchestratorDecision } from '../types/index.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ClassifyInput {
  taskId: string;
  taskName: string;
  taskStatus: string;
  assignedAgent: string;
  mentionContext: string;
}

export async function classifyEvent(input: ClassifyInput): Promise<OrchestratorDecision> {
  const agent = await findAgentByName(input.assignedAgent);

  if (!agent) {
    return {
      taskId: input.taskId,
      projectId: null,
      assignedAgent: input.assignedAgent,
      urgency: 'anomalous',
      anomalyReason: `Agent "${input.assignedAgent}" not found in Org DB`,
      action: 'notify_human',
    };
  }

  // Use haiku for fast, cheap classification
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `Classify this NORC orchestration event. Return valid JSON only, no markdown.

Task: "${input.taskName}"
Status: "${input.taskStatus}"
Agent: "${input.assignedAgent}"
Context: "${input.mentionContext}"

Return:
{
  "urgency": "normal" | "urgent" | "anomalous",
  "anomaly_reason": null | "short explanation",
  "action": "execute" | "hold" | "notify_human"
}

Rules:
- action=execute if task is actionable and agent is appropriate
- action=hold if task has no KPIs or context is ambiguous
- action=notify_human if anomaly detected or agent cannot handle this
- anomalous only for genuinely unusual situations`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fallback if haiku returns malformed JSON
    parsed = { urgency: 'normal', anomaly_reason: null, action: 'execute' };
  }

  return {
    taskId: input.taskId,
    projectId: null,
    assignedAgent: input.assignedAgent,
    urgency: parsed.urgency ?? 'normal',
    anomalyReason: parsed.anomaly_reason ?? null,
    action: parsed.action ?? 'execute',
  };
}
