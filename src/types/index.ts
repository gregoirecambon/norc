export interface AgentInput {
  systemPrompt: string;
  task: string;
  timeoutMs: number;
  env: Record<string, string>;
  contract: ExecutionContract;
}

export interface AgentOutput {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts?: string[];
  summary: string;
  nextAgent?: string;
}

export interface ExecutionContract {
  norcVersion: string;
  runId: string;
  step: number;
  callbackUrl: string;
  callbackToken: string;
  checkpointUrl: string;
  availableAgents: string[];
  contextRef: string;
}

export interface OrchestratorDecision {
  taskId: string;
  projectId: string | null;
  assignedAgent: string;
  urgency: 'normal' | 'urgent' | 'anomalous';
  anomalyReason: string | null;
  action: 'execute' | 'hold' | 'notify_human';
}

export interface AgentConfig {
  orgDbPageId: string;
  adapter: 'ClaudeCodeAdapter';
  authEnv: string;
  timeoutMin: number;
  workDir?: string;
  contextLevel: 'task' | 'project' | 'strategic';
}

export interface NotionTask {
  id: string;
  name: string;
  status: string;
  projectId: string | null;
  assignedAgent: string | null;
  kpis: string;
  agentOutput: string;
  pipelineRunId: string | null;
  retryCount: number;
  lastCheckpoint: string | null;
}

export interface NotionProject {
  id: string;
  name: string;
  docs: string;
  kpis: string;
  objective: string;
}

export interface ContextAssembly {
  taskId: string;
  taskName: string;
  taskKpis: string;
  project: NotionProject | null;
  priorAgentOutputs: string[];
  agentPersona: string;
  availableAgents: Array<{ name: string; specialty: string }>;
  companyVision: string | null;
  companyObjectives: string | null;
  contextLevel: 'task' | 'project' | 'strategic';
}
