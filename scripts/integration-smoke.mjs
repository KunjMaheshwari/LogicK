import "dotenv/config";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { PrismaClient, MessageRole, MessageType } from "@prisma/client";
import { inngest } from "../src/inngest/client.js";
import { executeCodeAgentRun } from "../src/inngest/code-agent-runner.js";

const prisma = new PrismaClient();
const SMOKE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 5 * 60 * 1000);
const POLL_MS = Number(process.env.SMOKE_POLL_MS || 4000);

const args = new Set(process.argv.slice(2));
const requestedMode =
  [...args].find((arg) => arg.startsWith("--mode="))?.split("=")[1] || "event";
const cleanup = !args.has("--no-cleanup");

const testPrompt =
  "Build a minimal task board page with add/remove task interactions using local React state and Tailwind. Keep it production-safe and concise.";

const stage = (name, details = "") => {
  const stamp = new Date().toISOString();
  const suffix = details ? ` | ${details}` : "";
  console.log(`[${stamp}] ${name}${suffix}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForAssistantResult(projectId) {
  const started = Date.now();

  while (Date.now() - started < SMOKE_TIMEOUT_MS) {
    const latest = await prisma.message.findFirst({
      where: {
        projectId,
        role: MessageRole.ASSISTANT,
      },
      include: {
        fragments: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (latest) {
      return latest;
    }

    await sleep(POLL_MS);
  }

  throw new Error(`Timed out waiting for assistant result after ${SMOKE_TIMEOUT_MS}ms`);
}

async function waitForPreview(previewUrl) {
  const started = Date.now();
  let lastStatus = "unreachable";

  while (Date.now() - started < SMOKE_TIMEOUT_MS) {
    try {
      const response = await fetch(previewUrl, {
        method: "GET",
        redirect: "follow",
      });

      lastStatus = String(response.status);
      if (response.ok) {
        return response.status;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    await sleep(POLL_MS);
  }

  throw new Error(`Preview URL did not become ready in time. Last status: ${lastStatus}`);
}

async function createSmokeProject() {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      clerkId: `smoke-clerk-${suffix}`,
      email: `smoke-${suffix}@example.com`,
      name: "Smoke Test",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: `smoke-${suffix}`,
      userId: user.id,
    },
  });

  await prisma.message.create({
    data: {
      projectId: project.id,
      content: testPrompt,
      role: MessageRole.User,
      type: MessageType.RESULT,
    },
  });

  return { user, project };
}

async function cleanupSmokeData(projectId, userId) {
  await prisma.fragment.deleteMany({
    where: {
      message: { projectId },
    },
  });

  await prisma.message.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function runViaEvent(projectId) {
  stage("stage.dispatch_event.start", "code-agent/run");
  await inngest.send({
    name: "code-agent/run",
    data: {
      value: testPrompt,
      projectId,
    },
  });
  stage("stage.dispatch_event.done");
}

async function runViaDirect(projectId) {
  stage("stage.direct_runner.start");
  const result = await executeCodeAgentRun({
    projectId,
    prompt: testPrompt,
    runStage: async (id, handler) => {
      const started = Date.now();
      stage(`stage.${id}.start`);
      try {
        const value = await handler();
        stage(`stage.${id}.done`, `${Date.now() - started}ms`);
        return value;
      } catch (error) {
        stage(`stage.${id}.error`, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    logger: console,
  });
  if (!result?.ok) {
    throw new Error(`Direct workflow run failed: ${result?.error || "Unknown error"}`);
  }
  stage("stage.direct_runner.done");
}

async function main() {
  let smokeUserId = null;
  let smokeProjectId = null;

  stage("smoke.start", `mode=${requestedMode}`);

  try {
    stage("stage.db.healthcheck.start");
    await prisma.$queryRaw`SELECT 1`;
    stage("stage.db.healthcheck.done");

    stage("stage.seed.start");
    const { user, project } = await createSmokeProject();
    smokeUserId = user.id;
    smokeProjectId = project.id;
    stage("stage.seed.done", `projectId=${project.id}`);

    let mode = requestedMode;
    if (mode !== "event" && mode !== "direct") {
      throw new Error(`Unsupported mode: ${mode}. Use --mode=event or --mode=direct`);
    }

    if (mode === "event") {
      try {
        await runViaEvent(project.id);
      } catch (error) {
        stage(
          "stage.dispatch_event.fallback",
          `event dispatch failed, falling back to direct mode: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        mode = "direct";
        await runViaDirect(project.id);
      }
    } else {
      await runViaDirect(project.id);
    }

    stage("stage.result.poll.start");
    const assistantMessage = await waitForAssistantResult(project.id);
    stage(
      "stage.result.poll.done",
      `messageType=${assistantMessage.type}, hasFragment=${Boolean(assistantMessage.fragments)}`
    );

    if (assistantMessage.type !== MessageType.RESULT) {
      throw new Error(`Assistant returned non-result message type: ${assistantMessage.type}`);
    }

    if (!assistantMessage.fragments) {
      throw new Error("Assistant result has no fragment attached.");
    }

    const fragment = assistantMessage.fragments;
    const fileCount = fragment.files && typeof fragment.files === "object"
      ? Object.keys(fragment.files).length
      : 0;

    if (!fragment.sandboxUrl || !fragment.sandboxUrl.startsWith("https://")) {
      throw new Error(`Invalid sandbox URL: ${fragment.sandboxUrl || "<empty>"}`);
    }

    if (fileCount === 0) {
      throw new Error("Fragment has no generated files.");
    }

    stage("stage.preview.healthcheck.start", fragment.sandboxUrl);
    const status = await waitForPreview(fragment.sandboxUrl);
    stage("stage.preview.healthcheck.done", `status=${status}`);

    stage("smoke.success", `projectId=${project.id}, files=${fileCount}, mode=${mode}`);
  } catch (error) {
    stage("smoke.failed", error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (cleanup && smokeProjectId && smokeUserId) {
      try {
        stage("stage.cleanup.start");
        await cleanupSmokeData(smokeProjectId, smokeUserId);
        stage("stage.cleanup.done");
      } catch (error) {
        stage("stage.cleanup.error", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }

    await prisma.$disconnect();
    stage("smoke.end");
  }
}

await main();
