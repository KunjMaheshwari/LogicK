import { inngest } from "./client";
import {
  CODE_AGENT_STEP_IDS,
  createSandboxPhase,
  loadMessagesPhase,
  runAgentPhase,
  prepareRuntimePhase,
  generateMetaPhase,
  saveResultPhase,
} from "./code-agent-runner";

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    const projectId = event?.data?.projectId;
    const prompt = event?.data?.value;

    let didSaveResult = false;
    const eventStepKey = event?.id || Date.now().toString();
    let stepCounter = 0;
    const runStep = (name, handler) => {
      stepCounter += 1;
      return step.run(`${name}-${eventStepKey}-${stepCounter}`, handler);
    };

    try {
      if (!projectId) {
        throw new Error("Missing projectId in event payload.");
      }
      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        throw new Error("Missing prompt in event payload.");
      }

      const sandbox = await createSandboxPhase();
      await runStep(CODE_AGENT_STEP_IDS.CREATE_SANDBOX, async () => {
        return { sandboxId: sandbox.sandboxId };
      });

      const previousMessages = await runStep(CODE_AGENT_STEP_IDS.LOAD_MESSAGES, async () => {
        return loadMessagesPhase(projectId);
      });

      await runStep(CODE_AGENT_STEP_IDS.GENERATE_NETWORK_ID, async () => {
        return { networkId: `network-${eventStepKey}` };
      });

      await runStep(CODE_AGENT_STEP_IDS.GENERATE_AGENT_IDS, async () => {
        return { agentId: `code-agent-${eventStepKey}` };
      });

      const runResult = await runStep(CODE_AGENT_STEP_IDS.CODE_AGENT, async () =>
        runAgentPhase({
          sandbox,
          prompt,
          previousMessages,
          logger: console,
        })
      );

      const runtimeResult = await prepareRuntimePhase({
        sandbox,
        files: runResult.files,
        logger: console,
      });

      const metaResult = await generateMetaPhase(
        runResult.summary,
        runtimeResult.isError,
        console
      );

      await runStep(`${CODE_AGENT_STEP_IDS.SAVE_RESULT}-success`, async () => {
        didSaveResult = true;
        return saveResultPhase({
          projectId,
          isError: runtimeResult.isError,
          responseText: metaResult.responseText,
          fragmentTitle: metaResult.fragmentTitle,
          sandboxUrl: runtimeResult.sandboxUrl,
          files: runtimeResult.files,
        });
      });

      return {
        ok: !runtimeResult.isError,
        url: runtimeResult.sandboxUrl,
        title: metaResult.fragmentTitle,
        files: runtimeResult.files,
        summary: runResult.summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn("code-agent failure", errorMessage);

      if (!didSaveResult && projectId) {
        await runStep(`${CODE_AGENT_STEP_IDS.SAVE_RESULT}-error`, async () => {
          didSaveResult = true;
          return saveResultPhase({
            projectId,
            isError: true,
            responseText: "Something went wrong. Please try again",
            fragmentTitle: "Untitled",
            sandboxUrl: null,
            files: {},
          });
        });
      }

      return {
        ok: false,
        error: errorMessage,
        url: null,
        title: "Untitled",
        files: {},
        summary: "",
      };
    }
  }
);
