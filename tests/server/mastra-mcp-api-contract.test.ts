import { describe, expect, it } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve } from '@mastra/core/tools';
import { z } from 'zod';

type Counter = { calls: number };

const context = {
  requestContext: new RequestContext(),
  observe: noopObserve,
};

function toolForContract(
  id: string,
  counter: Counter,
  requireApproval: boolean,
) {
  return createTool({
    id,
    description: 'Phase A contract fixture tool',
    inputSchema: z.object({ value: z.string() }),
    requireApproval,
    execute: async ({ value }) => {
      counter.calls += 1;
      return `${id}:${value}`;
    },
  });
}

describe('Mastra MCP approval API contract', () => {
  it('executes a safe tool directly and returns its result', async () => {
    const counter = { calls: 0 };
    const tool = toolForContract('safe', counter, false);

    const result = await tool.execute!({ value: 'ok' }, context);

    expect(result).toBe('safe:ok');
    expect(counter.calls).toBe(1);
  });

  it('does not turn direct execute into approval: requireApproval is bypassed', async () => {
    const counter = { calls: 0 };
    const tool = toolForContract('approval', counter, true);

    expect(tool.requireApproval).toBe(true);
    const result = await tool.execute!({ value: 'still-runs' }, context);

    // This is the intentional Phase A blocker: direct execution has no
    // pending/approve/resume transition and reaches the executor immediately.
    expect(result).toBe('approval:still-runs');
    expect(counter.calls).toBe(1);
  });
});
