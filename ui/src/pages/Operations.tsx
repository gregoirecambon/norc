import { useState } from 'react';
import { PageHeader, Tabs, Section } from '../components/ui.js';
import {
  TriageAgentPanel, StrategicContextPanel, SchedulePanel, ProposalsPanel, HeartbeatPanel,
} from '../components/panels/ConfigPanels.js';
import { ProposalsList, ScheduledTasksList } from '../components/panels/TaskViews.js';
import { AgentHealth } from '../components/panels/AgentHealth.js';

type Tab = 'triage' | 'schedule' | 'proposals' | 'health';

const TABS: { id: Tab; label: string }[] = [
  { id: 'triage', label: 'Triage Agent' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'health', label: 'Agent health' },
];

export default function OperationsPage() {
  const [tab, setTab] = useState<Tab>('triage');

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <PageHeader title="Operations" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'triage' && (
        <>
          <Section
            title="NORC Triage Agent (co-CEO)"
            description="When a task or comment arrives with no agent assigned, the Triage Agent triages it: auto-routes to the best agent above the confidence threshold, otherwise suggests one. Use Anthropic directly or any OpenAI-compatible endpoint (e.g. a LiteLLM proxy)."
          >
            <TriageAgentPanel />
          </Section>
          <Section
            title="Strategic Context"
            description="Adds a Company database (Vision / Values / Strategy) so strategic agents see company context. Safe to click — it's a no-op if the DB already exists."
          >
            <StrategicContextPanel />
          </Section>
        </>
      )}

      {tab === 'schedule' && (
        <>
          <Section
            title="Scheduling"
            description="Tasks with a 'Scheduled For' date run when due; recurring tasks spawn a fresh instance each period. Add the scheduling fields to the Tasks DB, then enable the poller."
          >
            <SchedulePanel />
          </Section>
          <Section title="Upcoming">
            <ScheduledTasksList />
          </Section>
        </>
      )}

      {tab === 'proposals' && (
        <>
          <Section
            title="Co-CEO proposals"
            description="On a schedule, the Triage Agent reviews your company context and proposes new tasks (created as 'Proposed', never auto-run). Approve to route them to an agent, or dismiss to archive."
          >
            <ProposalsPanel />
          </Section>
          <Section title="Pending validation">
            <ProposalsList />
          </Section>
        </>
      )}

      {tab === 'health' && (
        <>
          <Section
            title="Heartbeat"
            description="Keeps agent Status accurate: NORC pings each agent on a schedule and reflects reachable → Available, unreachable → Offline on the Org DB. Deep checks additionally send a real test prompt through each agent's AI; after repeated failures the agent's Owner is @mentioned on its Org DB page. Agents mid-task are never disturbed."
          >
            <HeartbeatPanel />
          </Section>
          <Section title="Agents">
            <AgentHealth />
          </Section>
        </>
      )}
    </div>
  );
}
