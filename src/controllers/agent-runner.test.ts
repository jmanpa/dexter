import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { AgentRunnerController } from './agent-runner.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import type { AgentConfig, AgentEvent } from '../agent/types.js';

/**
 * Helper to create an AgentRunnerController with a change counter
 */
function createController(onChange?: () => void) {
  let changeCount = 0;
  const controller = new AgentRunnerController(
    { model: 'gpt-5.5', modelProvider: 'openai', maxIterations: 10 },
    new InMemoryChatHistory('gpt-5.5'),
    () => {
      changeCount++;
      onChange?.();
    },
  );
  return { controller, getChangeCount: () => changeCount };
}

describe('AgentRunnerController', () => {
  let mockAgentRunYielded: AgentEvent[] = [];

  beforeEach(() => {
    mockAgentRunYielded = [];

    mock.module('../agent/agent.js', () => ({
      Agent: class MockAgent {
        static async create(config: AgentConfig) {
          return new MockAgent(config);
        }

        constructor(private config: AgentConfig) {}

        async *run(): AsyncGenerator<AgentEvent> {
          // Capture the approval request function from config
          const requestApproval = this.config.requestToolApproval;
          if (requestApproval) {
            const promise = requestApproval({ tool: 'write_file', args: { path: '.dexter/RULES.md', content: 'test' } });
            await promise;
          }

          // Yield any configured events
          for (const event of mockAgentRunYielded) {
            yield event;
          }

          yield { type: 'done', answer: 'done', toolCalls: [], iterations: 1, totalTime: 100 };
        }
      },
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test('updates the active agent config for subsequent runs', () => {
    const controller = new AgentRunnerController(
      { model: 'gpt-5.5', modelProvider: 'openai', maxIterations: 10 },
      new InMemoryChatHistory('gpt-5.5'),
    );

    controller.updateAgentConfig({
      model: 'ollama:llama3.1',
      modelProvider: 'ollama',
    });

    expect(controller.currentConfig).toMatchObject({
      model: 'ollama:llama3.1',
      modelProvider: 'ollama',
      maxIterations: 10,
    });
  });

  describe('approval state', () => {
    test('shows the requested approval and notifies the UI', async () => {
      let sawApprovalChange = false;
      let controller: AgentRunnerController;
      ({ controller } = createController(() => {
        if (controller.pendingApproval?.tool === 'write_file') sawApprovalChange = true;
      }));

      expect(controller.pendingApproval).toBeNull();

      const runPromise = controller.runQuery('test query');

      // Wait a tick for the async agent.run() to start
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(controller.pendingApproval).not.toBeNull();
      expect(controller.pendingApproval?.tool).toBe('write_file');
      expect(controller.workingState.status).toBe('approval');
      expect(sawApprovalChange).toBe(true);
      expect(controller.pendingApproval?.args).toMatchObject({
        path: '.dexter/RULES.md',
        content: 'test',
      });

      // Clean up: deny to complete the run
      controller.respondToApproval('deny');
      await runPromise;
    });

    test('allow-once clears approval, notifies the UI and completes idle', async () => {
      const { controller, getChangeCount } = createController();

      const runPromise = controller.runQuery('test query');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(controller.pendingApproval).not.toBeNull();
      const countAfterEnter = getChangeCount();

      controller.respondToApproval('allow-once');
      expect(controller.pendingApproval).toBeNull();
      expect(controller.workingState.status).toBe('thinking');
      expect(getChangeCount()).toBeGreaterThan(countAfterEnter);
      await runPromise;
      expect(controller.workingState.status).toBe('idle');
    });

    test('deny clears approval, notifies the UI and completes idle', async () => {
      const { controller, getChangeCount } = createController();

      const runPromise = controller.runQuery('test query');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(controller.pendingApproval).not.toBeNull();

      const countAfterEnter = getChangeCount();
      controller.respondToApproval('deny');
      expect(controller.pendingApproval).toBeNull();
      expect(getChangeCount()).toBeGreaterThan(countAfterEnter);
      await runPromise;
      expect(controller.workingState.status).toBe('idle');
    });
  });

  describe('cancelExecution', () => {
    test('clears approval, notifies the UI and returns idle', async () => {
      const { controller, getChangeCount } = createController();

      const runPromise = controller.runQuery('test query');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(controller.pendingApproval).not.toBeNull();
      expect(controller.workingState.status).toBe('approval');
      const countBeforeCancel = getChangeCount();

      controller.cancelExecution();
      expect(controller.pendingApproval).toBeNull();
      expect(controller.workingState.status).toBe('idle');
      expect(getChangeCount()).toBeGreaterThan(countBeforeCancel);
      await runPromise;
    });
  });

  describe('respondToApproval edge cases', () => {
    test('does nothing when no approval is pending', () => {
      const { controller, getChangeCount } = createController();
      const countBefore = getChangeCount();

      // Should not throw and should not fire onChange
      controller.respondToApproval('allow-once');

      expect(getChangeCount()).toBe(countBefore);
    });
  });

  describe('query-scoped bash session grants', () => {
    test('prunes bash: keys at the start of a new query, keeps file:write', async () => {
      const { controller } = createController();
      const grants: Set<string> = (controller as unknown as { sessionApprovedTools: Set<string> }).sessionApprovedTools;
      grants.add('bash:Bash(ls:*)');
      grants.add('file:write');

      const runPromise = controller.runQuery('test query');
      await new Promise(resolve => setTimeout(resolve, 10));

      // bash grant pruned at query start; file:write preserved.
      expect(grants.has('bash:Bash(ls:*)')).toBe(false);
      expect(grants.has('file:write')).toBe(true);

      controller.respondToApproval('deny');
      await runPromise;
    });
  });
});
