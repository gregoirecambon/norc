import { Client } from '@notionhq/client';
import { enqueueDispatch } from './dispatcher.js';
import type { OrchestratorDecision } from '../types/index.js';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

interface PipelineStep {
  step: number;
  agent: string;
  depends_on: number[];
}

interface Pipeline {
  name: string;
  triggerStatus: string;
  steps: PipelineStep[];
}

// Load pipelines from the Notion Pipeline Config database
export async function loadPipelines(): Promise<Pipeline[]> {
  const dbId = process.env.NOTION_PIPELINE_CONFIG_DB_ID;
  if (!dbId) return [];

  try {
    const response = await (notion as any).request({
      path: `databases/${dbId}/query`,
      method: 'POST',
      body: {},
    }) as any;

    return (response.results ?? []).map((page: any) => {
      const props = page.properties;
      const stepsRaw = props.Steps?.rich_text?.[0]?.plain_text ?? '[]';
      let steps: PipelineStep[] = [];
      try {
        steps = JSON.parse(stepsRaw);
      } catch {
        console.warn(`[pipeline] invalid Steps JSON on page ${page.id}`);
      }
      return {
        name: props.Name?.title?.[0]?.plain_text ?? '',
        triggerStatus: props['Trigger Status']?.select?.name ?? 'Ready',
        steps,
      };
    });
  } catch (err) {
    console.error('[pipeline] failed to load pipelines:', err);
    return [];
  }
}

// When an agent completes a step, check if any downstream steps are unblocked
export async function resolveNextSteps(
  taskId: string,
  completedStep: number,
  pipelineName: string,
  nextAgentHint?: string
): Promise<void> {
  // Handle explicit next_agent delegation from the agent's callback body
  if (nextAgentHint) {
    await enqueueDispatch({
      taskId,
      projectId: null,
      assignedAgent: nextAgentHint,
      urgency: 'normal',
      anomalyReason: null,
      action: 'execute',
    } satisfies OrchestratorDecision);
    return;
  }

  // Otherwise resolve from pipeline config
  const pipelines = await loadPipelines();
  const pipeline = pipelines.find(p => p.name === pipelineName);
  if (!pipeline) return;

  const unblocked = pipeline.steps.filter(
    step =>
      step.step !== completedStep &&
      step.depends_on.every(dep => dep <= completedStep)
  );

  for (const step of unblocked) {
    await enqueueDispatch({
      taskId,
      projectId: null,
      assignedAgent: step.agent,
      urgency: 'normal',
      anomalyReason: null,
      action: 'execute',
    } satisfies OrchestratorDecision);
  }
}
