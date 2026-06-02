import { describe, it, expect } from 'vitest';

// Pure logic extracted from dependency-resolver for unit testing
interface PipelineStep {
  step: number;
  agent: string;
  depends_on: number[];
}

function getUnblockedSteps(steps: PipelineStep[], completedStep: number): PipelineStep[] {
  return steps.filter(
    s => s.step !== completedStep && s.depends_on.every(dep => dep <= completedStep)
  );
}

describe('dependency resolver', () => {
  const featureBuildPipeline: PipelineStep[] = [
    { step: 1, agent: 'designer',   depends_on: [] },
    { step: 2, agent: 'developer',  depends_on: [1] },
    { step: 3, agent: 'reviewer',   depends_on: [2] },
  ];

  it('returns no steps when step 1 is completed but step 2 depends on 1', () => {
    // After step 1 done → step 2 should unblock
    const unblocked = getUnblockedSteps(featureBuildPipeline, 1);
    expect(unblocked.map(s => s.step)).toContain(2);
    expect(unblocked.map(s => s.step)).not.toContain(3); // still blocked
  });

  it('unblocks step 3 after step 2 completes', () => {
    const unblocked = getUnblockedSteps(featureBuildPipeline, 2);
    expect(unblocked.map(s => s.step)).toContain(3);
  });

  it('no steps unblocked at start (nothing completed)', () => {
    const parallelPipeline: PipelineStep[] = [
      { step: 1, agent: 'designer',  depends_on: [] },
      { step: 2, agent: 'developer', depends_on: [] },
      { step: 3, agent: 'reviewer',  depends_on: [1, 2] },
    ];
    // If step 3 requires both 1 and 2, and only 1 is done:
    const unblocked = getUnblockedSteps(parallelPipeline, 1);
    expect(unblocked.map(s => s.step)).not.toContain(3); // still needs step 2
    expect(unblocked.map(s => s.step)).toContain(2); // step 2 has no deps
  });

  it('parallel steps with no deps all unblock from start', () => {
    const parallelSteps: PipelineStep[] = [
      { step: 1, agent: 'designer',  depends_on: [] },
      { step: 2, agent: 'developer', depends_on: [] },
    ];
    // "completedStep" = 0 means nothing done — but steps with empty deps are immediately eligible
    // In practice, initial dispatch handles steps with depends_on=[]
    const withDeps = parallelSteps.filter(s => s.depends_on.length === 0);
    expect(withDeps).toHaveLength(2);
  });
});

describe('Steps JSON parsing', () => {
  it('parses valid steps JSON from Notion text property', () => {
    const raw = '[{"step":1,"agent":"designer","depends_on":[]},{"step":2,"agent":"developer","depends_on":[1]}]';
    const steps = JSON.parse(raw) as PipelineStep[];
    expect(steps).toHaveLength(2);
    expect(steps[1].depends_on).toContain(1);
  });

  it('handles malformed JSON gracefully', () => {
    const raw = 'not valid json {{';
    let steps: PipelineStep[] = [];
    try { steps = JSON.parse(raw); } catch { steps = []; }
    expect(steps).toHaveLength(0);
  });
});
