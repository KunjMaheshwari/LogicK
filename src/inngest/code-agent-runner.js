import {
  gemini,
  createAgent,
  createTool,
  createNetwork,
  createState,
} from "@inngest/agent-kit";
import { Sandbox, waitForPort } from "@e2b/code-interpreter";
import z from "zod";
import { MessageRole, MessageType } from "@prisma/client";
import { lastAssistantTextMessageContent } from "./utils.js";
import db from "../lib/db.js";
import geminiWithRetry from "../lib/geminiWithRetry.js";

const SANDBOX_TEMPLATE = "kunjmaheshwari2021/logick-v2";
const SANDBOX_PROJECT_ROOT = "/home/user";
const PREVIEW_PORT = 3000;
const NETWORK_MAX_ITER = 1;
const MAX_AGENT_ITERATIONS = 3;
const GEMINI_REQUEST_DELAY_MS = 8000;
const NETWORK_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 120_000);
const AGENT_EXECUTION_TIMEOUT_MS = Math.min(NETWORK_TIMEOUT_MS, 90_000);
const TERMINAL_COMMAND_TIMEOUT_MS = 20_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;
const SHADCN_UTILS_PATH = "src/lib/utils.ts";
const SHADCN_UTILS_CONTENT = `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;
const CODE_AGENT_SYSTEM_PROMPT = `You are a senior software engineer in a sandboxed Next.js app.

Execution constraints:
- Complete this task in one concise pass.
- Prefer createOrUpdateFiles for code changes.
- Use terminal only when necessary and avoid long-running commands.
- Never run dev servers (npm run dev, next dev, next start, npm run start, next build, npm run build).
- Use relative paths only. If the app uses src-dir, write to src/app/*; otherwise app/*.
- Return a clear task summary when done.
`;

export const CODE_AGENT_STEP_IDS = {
  CREATE_SANDBOX: "create-sandbox",
  LOAD_MESSAGES: "load-messages",
  GENERATE_NETWORK_ID: "generate-network-id",
  GENERATE_AGENT_IDS: "generate-agent-ids",
  CODE_AGENT: "code-agent",
  SAVE_RESULT: "save-result",
};

const isSandboxRuntime = Boolean(
  process.env.CODESPACE ||
    process.env.GITHUB_ACTIONS ||
    process.env.VERCEL ||
    process.env.INNGEST_RUNTIME
);

const isAbsolutePath = (filePath) =>
  filePath.startsWith("/") || /^[A-Za-z]:\\/.test(filePath);

const toRelativeSandboxPath = (filePath) => {
  if (typeof filePath !== "string") {
    throw new Error(`Invalid file path type: ${typeof filePath}`);
  }

  const normalized = filePath
    .trim()
    .replace(/^\/home\/user\//, "")
    .replace(/^\.\//, "");

  if (!normalized || isAbsolutePath(normalized) || normalized.startsWith("..")) {
    throw new Error(`Invalid file path "${filePath}". Use relative paths only.`);
  }

  return normalized;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isForbiddenTerminalCommand = (command) =>
  /\b(npm\s+run\s+dev|next\s+dev|next\s+start|npm\s+run\s+start|next\s+build|npm\s+run\s+build)\b/i.test(
    command
  );

const runSandboxCommand = async (sandbox, command) => {
  const buffers = { stdout: "", stderr: "" };

  try {
    const result = await sandbox.commands.run(command, {
      cwd: SANDBOX_PROJECT_ROOT,
      onStdout: (data) => {
        buffers.stdout += data;
      },
      onStderr: (data) => {
        buffers.stderr += data;
      },
    });

    return {
      ok: true,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? buffers.stdout,
      stderr: result.stderr ?? buffers.stderr,
      command,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: buffers.stdout,
      stderr: buffers.stderr,
      command,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const detectSrcDirLayout = async (sandbox) => {
  try {
    await sandbox.files.read("src/app/page.tsx");
    return true;
  } catch {
    return false;
  }
};

const toRuntimeProjectPath = (relativePath, usesSrcDir) => {
  if (!usesSrcDir || relativePath.startsWith("src/")) return relativePath;

  // Next.js src-dir projects keep app/components/lib/hooks/types under src/.
  if (/^(app|components|lib|hooks|types|utils)\//.test(relativePath)) {
    return `src/${relativePath}`;
  }

  return relativePath;
};

const runSandboxCommandWithTimeout = async (
  sandbox,
  command,
  timeoutMs,
  { cwd = SANDBOX_PROJECT_ROOT } = {}
) => {
  const buffers = { stdout: "", stderr: "" };
  let timer = null;

  const commandPromise = sandbox.commands.run(command, {
    cwd,
    onStdout: (data) => {
      buffers.stdout += data;
    },
    onStderr: (data) => {
      buffers.stderr += data;
    },
  });

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command}\nstdout: ${buffers.stdout}\nstderr: ${buffers.stderr}`
        )
      );
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([commandPromise, timeoutPromise]);
    return {
      ok: true,
      exitCode: result?.exitCode ?? 0,
      stdout: result?.stdout ?? buffers.stdout,
      stderr: result?.stderr ?? buffers.stderr,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: buffers.stdout,
      stderr: buffers.stderr,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const readPackageJson = async (sandbox) => {
  try {
    await sandbox.files.read("package.json");
    return true;
  } catch {
    return false;
  }
};

const DEV_SERVER_LOG_PATH = "/tmp/dev.log";

const safeWriteSandboxFile = async (sandbox, path, content, logger = console) => {
  try {
    await sandbox.files.write(path, content);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const needsParentDir = /does not exist|ENOENT/i.test(errorMessage);

    if (needsParentDir) {
      const parentDir = path.split("/").slice(0, -1).join("/");
      if (parentDir) {
        await runSandboxCommandWithTimeout(
          sandbox,
          `mkdir -p "${parentDir}"`,
          10_000
        );
        try {
          await sandbox.files.write(path, content);
          return true;
        } catch (retryError) {
          logger.warn("File operation skipped due to sandbox restrictions", {
            path,
            error:
              retryError instanceof Error ? retryError.message : String(retryError),
          });
          return false;
        }
      }
    }

    logger.warn("File operation skipped due to sandbox restrictions", {
      path,
      error: errorMessage,
    });
    return false;
  }
};

const syncGeneratedFilesToSandbox = async (sandbox, files, logger = console) => {
  const entries = Object.entries(files || {});
  for (const [path, content] of entries) {
    if (typeof content !== "string") continue;
    await safeWriteSandboxFile(sandbox, path, content, logger);
  }
};

const safeReadSandboxFile = async (sandbox, path, logger = console) => {
  try {
    return await sandbox.files.read(path);
  } catch (error) {
    logger.warn("File operation skipped due to sandbox restrictions", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const startDevServer = async (sandbox, { disableTurbopack = false } = {}) => {
  const turboFlag = disableTurbopack ? "--no-turbo " : "";
  await sandbox.commands.run(
    `bash -lc 'cd /home/user && nohup npm run dev -- ${turboFlag}-p 3000 > /tmp/dev.log 2>&1 &'`,
    { cwd: SANDBOX_PROJECT_ROOT }
  );
};

const readDevLog = async (sandbox) => {
  const result = await runSandboxCommandWithTimeout(
    sandbox,
    `bash -lc 'if [ -f ${DEV_SERVER_LOG_PATH} ]; then cat ${DEV_SERVER_LOG_PATH}; else echo "__DEV_LOG_MISSING__"; fi'`,
    10_000
  );

  if (!result.ok) {
    return `Unable to read /tmp/dev.log. stdout: ${result.stdout}\nstderr: ${result.stderr}\nerror: ${result.error}`;
  }

  const content = (result.stdout || "").trim();
  if (!content || content.includes("__DEV_LOG_MISSING__")) {
    return "Unable to read /tmp/dev.log";
  }

  return content;
};

const waitForPreviewHttpReady = async (url, timeoutMs = 60000) => {
  const started = Date.now();
  let lastStatus = "unknown";

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET", redirect: "follow" });
      lastStatus = String(response.status);
      if (response.status === 200) {
        return;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    `Preview URL health check failed for ${url}. Last status: ${lastStatus}`
  );
};

const ensurePreviewServer = async (sandbox, logger = console) => {
  const packageJsonExists = await readPackageJson(sandbox);
  if (!packageJsonExists) {
    throw new Error("Missing package.json in /home/user before npm install.");
  }
  const host = sandbox.getHost(PREVIEW_PORT);
  const previewUrl = `https://${host}`;

  try {
    await waitForPort(sandbox, PREVIEW_PORT, { timeoutMs: 8_000 });
    await waitForPreviewHttpReady(previewUrl, 15_000);
    logger.info("Reusing existing preview server on port 3000");
    return previewUrl;
  } catch {
    logger.info("No healthy existing preview server detected. Starting a new one.");
  }

  try {
    const cleanupNextResult = await runSandboxCommandWithTimeout(
      sandbox,
      "bash -lc 'if [ -d /home/user/.next ]; then rm -rf /home/user/.next >/dev/null 2>&1 || true; fi'",
      30_000,
      { cwd: SANDBOX_PROJECT_ROOT }
    );

    if (!cleanupNextResult.ok) {
      logger.warn("Skipping .next cleanup in sandbox environment", {
        stdout: cleanupNextResult.stdout,
        stderr: cleanupNextResult.stderr,
        error: cleanupNextResult.error,
      });
    }

    const installResult = await runSandboxCommandWithTimeout(
      sandbox,
      "npm install --no-audit --no-fund",
      NPM_INSTALL_TIMEOUT_MS
    );

    if (!installResult.ok) {
      throw new Error(
        `npm install failed. stdout: ${installResult.stdout}\nstderr: ${installResult.stderr}\nerror: ${installResult.error}`
      );
    }
  } catch (error) {
    logger.error("npm install failed", {
      error,
      isSandboxRuntime,
    });
    throw error;
  }

  try {
    await startDevServer(sandbox, { disableTurbopack: false });
    await waitForPort(sandbox, PREVIEW_PORT, { timeoutMs: 45_000 });
  } catch (error) {
    const devLog = await readDevLog(sandbox);
    const hasTurbopackError = /turbopack|permission|EACCES|EPERM/i.test(devLog);
    const hasAddressInUse = /EADDRINUSE|address already in use/i.test(devLog);

    logger.error("Failed to start dev server or wait for port 3000", {
      error,
      devLog,
      hasTurbopackError,
      hasAddressInUse,
    });

    if (hasAddressInUse) {
      logger.warn("Port 3000 already in use. Reusing existing preview process.");
      await waitForPreviewHttpReady(previewUrl, 60_000);
    } else if (hasTurbopackError) {
      logger.warn("Retrying dev server with turbopack disabled");
      await runSandboxCommandWithTimeout(
        sandbox,
        "bash -lc \"pkill -f 'next dev' >/dev/null 2>&1 || true\"",
        10_000
      );
      await startDevServer(sandbox, { disableTurbopack: true });
      await waitForPort(sandbox, PREVIEW_PORT, { timeoutMs: 60_000 });
    } else {
      throw new Error(`Sandbox dev server failed to start. /tmp/dev.log:\n${devLog}`);
    }
  }

  try {
    await waitForPreviewHttpReady(previewUrl, 60000);
    return previewUrl;
  } catch (error) {
    const devLog = await readDevLog(sandbox);
    logger.error("Preview URL did not become healthy after port opened", {
      error,
      previewUrl,
      devLog,
    });
    throw new Error(
      `Preview URL is unhealthy. /tmp/dev.log:\n${devLog}`
    );
  }
};

const normalizeToolFiles = (filesInput) => {
  if (Array.isArray(filesInput)) return filesInput;

  if (filesInput && typeof filesInput === "object") {
    return Object.entries(filesInput).map(([path, content]) => ({ path, content }));
  }

  throw new Error("Invalid files payload. Expected an array or object map.");
};

export const AGENT_TIMEOUT_MS = NETWORK_TIMEOUT_MS;

export async function createSandboxPhase() {
  return Sandbox.create(SANDBOX_TEMPLATE);
}

export async function loadMessagesPhase(projectId) {
  const messages = await db.message.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });

  return messages.map((message) => ({
    type: "text",
    role: message.role === MessageRole.ASSISTANT ? "assistant" : "user",
    content: message.content,
  }));
}

export async function createAgentRunContext({ sandbox, previousMessages, logger = console }) {
  const fileReadCache = new Map();
  let agentIteration = 0;
  const usesSrcDir = await detectSrcDirLayout(sandbox);

  const state = createState(
    {
      summary: "",
      files: {},
    },
    {
      messages: previousMessages,
    }
  );

  const codeAgent = createAgent({
    name: `code-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: "An expert coding agent",
    system: CODE_AGENT_SYSTEM_PROMPT,
    model: gemini({ model: "gemini-2.5-flash" }),
    tools: [
      createTool({
        name: "terminal",
        description:
          "Use the terminal to run commands. Return a strict JSON function call with arguments object only.",
        parameters: z
          .object({
            command: z.string().optional(),
            cmd: z.string().optional(),
          })
          .refine((value) => Boolean(value.command || value.cmd), {
            message: "Provide command or cmd",
          }),
        handler: async ({ command, cmd }) => {
          const resolvedCommand = command ?? cmd;
          if (!resolvedCommand || typeof resolvedCommand !== "string") {
            return {
              ok: false,
              error: "Invalid terminal command payload",
            };
          }
          if (isForbiddenTerminalCommand(resolvedCommand)) {
            return {
              ok: false,
              command: resolvedCommand,
              error: "Command blocked to avoid long-running execution in agent runtime.",
            };
          }
          const result = await runSandboxCommandWithTimeout(
            sandbox,
            resolvedCommand,
            TERMINAL_COMMAND_TIMEOUT_MS
          );

          if (!result.ok) {
            return {
              ok: false,
              command: resolvedCommand,
              error: result.error,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          }

          const response = {
            ok: true,
            command: resolvedCommand,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
          logger.info("[tool:terminal] success", {
            command: resolvedCommand,
            exitCode: result.exitCode,
          });
          return response;
        },
      }),
      createTool({
        name: "createOrUpdateFiles",
        description:
          "Create or update files in the sandbox. Return a strict JSON function call: {\"tool_name\":\"createOrUpdateFiles\",\"arguments\":{\"files\":[{\"path\":\"...\",\"content\":\"...\"}]}}",
        parameters: z.object({
          files: z.union([
            z.array(
              z.object({
                path: z.string().min(1),
                content: z.string(),
              })
            ),
            z.record(z.string(), z.string()),
          ]),
        }),
        handler: async ({ files }, { network }) => {
          try {
            const normalizedFiles = normalizeToolFiles(files);
            const updatedFiles = { ...(network?.state?.data?.files ?? {}) };
            const dedupedFiles = new Map();

            for (const file of normalizedFiles) {
              const relativePath = toRuntimeProjectPath(
                toRelativeSandboxPath(file.path),
                usesSrcDir
              );
              dedupedFiles.set(relativePath, file.content);
            }

            let changedFilesCount = 0;

            for (const [relativePath, content] of dedupedFiles.entries()) {
              const cachedContent = fileReadCache.get(relativePath);
              const knownContent = updatedFiles[relativePath] ?? cachedContent;

              if (knownContent === content) {
                continue;
              }

              const didWrite = await safeWriteSandboxFile(
                sandbox,
                relativePath,
                content,
                logger
              );
              if (!didWrite) {
                continue;
              }
              updatedFiles[relativePath] = content;
              fileReadCache.set(relativePath, content);
              changedFilesCount += 1;
            }

            if (!updatedFiles[SHADCN_UTILS_PATH]) {
              const wroteUtils = await safeWriteSandboxFile(
                sandbox,
                SHADCN_UTILS_PATH,
                SHADCN_UTILS_CONTENT,
                logger
              );
              if (wroteUtils) {
                updatedFiles[SHADCN_UTILS_PATH] = SHADCN_UTILS_CONTENT;
                fileReadCache.set(SHADCN_UTILS_PATH, SHADCN_UTILS_CONTENT);
                changedFilesCount += 1;
              }
            }

            if (network) {
              network.state.data.files = updatedFiles;
            }

            const response = {
              ok: true,
              changedFilesCount,
              files: Object.keys(updatedFiles),
            };
            logger.info("[tool:createOrUpdateFiles] success", {
              changedFilesCount,
              totalFiles: response.files.length,
            });
            return response;
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
      createTool({
        name: "readFiles",
        description: "Read files in the sandbox",
        parameters: z.object({
          files: z.array(z.string()).optional(),
          paths: z.array(z.string()).optional(),
        }),
        handler: async ({ files, paths }) => {
          try {
            const requestedPaths = files ?? paths ?? [];
            if (!requestedPaths.length) {
              return { ok: false, error: "No file paths provided" };
            }

            const contents = [];
            for (const file of requestedPaths) {
              const relativePath = toRuntimeProjectPath(
                toRelativeSandboxPath(file),
                usesSrcDir
              );
              let content = fileReadCache.get(relativePath);

              if (typeof content !== "string") {
                content = await safeReadSandboxFile(sandbox, relativePath, logger);
                if (typeof content !== "string") {
                  continue;
                }
                fileReadCache.set(relativePath, content);
              }

              contents.push({ path: relativePath, content });
            }

            const response = {
              ok: true,
              files: contents,
            };
            logger.info("[tool:readFiles] success", {
              requestedCount: requestedPaths.length,
              returnedCount: contents.length,
            });
            return response;
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    ],
    lifecycle: {
      onResponse: async ({ result, network }) => {
        agentIteration += 1;
        logger.info(`[code-agent] iteration=${agentIteration}`);

        const lastAssistantMessageText = lastAssistantTextMessageContent(result);
        if (
          lastAssistantMessageText &&
          network &&
          lastAssistantMessageText.includes("<task_summary>")
        ) {
          network.state.data.summary = lastAssistantMessageText;
        }

        return result;
      },
    },
  });

  const network = createNetwork({
    name: "coding-agent-network",
    agents: [codeAgent],
    maxIter: NETWORK_MAX_ITER,
    router: async ({ network }) => {
      const summary = network.state.data.summary;
      if (summary) return;
      return codeAgent;
    },
  });

  return {
    network,
    state,
    usesSrcDir,
    finalize: async (result) => {
      const generatedFiles = result.state.data.files || {};

      if (!generatedFiles[SHADCN_UTILS_PATH]) {
        const wroteUtils = await safeWriteSandboxFile(
          sandbox,
          SHADCN_UTILS_PATH,
          SHADCN_UTILS_CONTENT,
          logger
        );
        if (wroteUtils) {
          generatedFiles[SHADCN_UTILS_PATH] = SHADCN_UTILS_CONTENT;
        }
      }

      return {
        summary:
          result.state.data.summary || lastAssistantTextMessageContent(result) || "",
        files: generatedFiles,
      };
    },
  };
}

export async function runAgentPhase({ sandbox, prompt, previousMessages, logger = console }) {
  const context = await createAgentRunContext({
    sandbox,
    previousMessages,
    logger,
  });

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
    let timer = null;

    try {
      const result = await geminiWithRetry(
        () =>
          Promise.race([
            context.network.run(prompt, { state: context.state }),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`Agent timed out after ${AGENT_EXECUTION_TIMEOUT_MS}ms`));
              }, AGENT_EXECUTION_TIMEOUT_MS);
            }),
          ]),
        {
          retries: 1,
          iteration: iteration + 1,
          logger,
          label: "code-agent",
        }
      );

      const finalized = await context.finalize(result);
      const taskCompleted =
        Boolean(finalized.summary?.trim()) ||
        Object.keys(finalized.files || {}).length > 0;

      if (taskCompleted || iteration === MAX_AGENT_ITERATIONS - 1) {
        return finalized;
      }

      await sleep(GEMINI_REQUEST_DELAY_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out/i.test(message)) {
        logger.warn("Agent timeout reached. Returning fallback output.", {
          timeoutMs: AGENT_EXECUTION_TIMEOUT_MS,
        });
        const fallbackPath = context.usesSrcDir ? "src/app/page.tsx" : "app/page.tsx";
        return {
          summary:
            "<task_summary>Generated a minimal fallback page because the agent exceeded time limits.</task_summary>",
          files: {
            [fallbackPath]: `export default function Page() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-2xl font-semibold">Generated App</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The full generation timed out, so a minimal fallback page was produced.
      </p>
    </main>
  );
}
`,
          },
        };
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new Error("Agent execution failed after iteration limit.");
}

export async function prepareRuntimePhase({ sandbox, files, logger = console }) {
  const hasAppFiles = Object.keys(files || {}).some(
    (filePath) => filePath !== SHADCN_UTILS_PATH
  );

  if (!hasAppFiles) {
    return {
      isError: true,
      sandboxUrl: null,
      files,
    };
  }

  const packageJsonExists = await readPackageJson(sandbox);

  if (!packageJsonExists) {
    throw new Error("Missing package.json in sandbox root. Generated files are incomplete.");
  }

  await syncGeneratedFilesToSandbox(sandbox, files, logger);

  const sandboxUrl = await ensurePreviewServer(sandbox, logger);

  return {
    isError: false,
    sandboxUrl,
    files,
  };
}

export async function generateMetaPhase(summaryText, isError, logger = console) {
  if (isError) {
    return {
      fragmentTitle: "Untitled",
      responseText: "Something went wrong. Please try again",
    };
  }

  try {
    const trimmedSummary = String(summaryText || "").trim();
    const firstLine = trimmedSummary.split("\n").find((line) => line.trim()) || "";
    const words = firstLine
      .replace(/<[^>]+>/g, " ")
      .replace(/[^\w\s-]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    const fragmentTitle = words.length
      ? words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ")
      : "Generated App";
    const responseText = trimmedSummary
      ? "Implemented the requested application updates and prepared a working preview."
      : "Generated the requested application update.";

    return {
      fragmentTitle,
      responseText,
    };
  } catch (error) {
    logger.error("Failed to generate metadata from summary", error);
    return {
      fragmentTitle: "Untitled",
      responseText: "Here you go",
    };
  }
}

export async function saveResultPhase({
  projectId,
  isError,
  responseText,
  fragmentTitle,
  sandboxUrl,
  files,
}) {
  if (isError) {
    return db.message.create({
      data: {
        projectId,
        content: responseText || "Something went wrong. Please try again",
        role: MessageRole.ASSISTANT,
        type: MessageType.ERROR,
      },
    });
  }

  return db.message.create({
    data: {
      projectId,
      content: responseText,
      role: MessageRole.ASSISTANT,
      type: MessageType.RESULT,
      fragments: {
        create: {
          sandboxUrl,
          title: fragmentTitle,
          files,
        },
      },
    },
  });
}

export async function executeCodeAgentRun({ projectId, prompt, logger = console }) {
  try {
    const sandbox = await createSandboxPhase();
    const previousMessages = await loadMessagesPhase(projectId);
    const runResult = await runAgentPhase({
      sandbox,
      prompt,
      previousMessages,
      logger,
    });
    const runtimeResult = await prepareRuntimePhase({
      sandbox,
      files: runResult.files,
      logger,
    });
    const metaResult = await generateMetaPhase(
      runResult.summary,
      runtimeResult.isError,
      logger
    );

    await saveResultPhase({
      projectId,
      isError: runtimeResult.isError,
      responseText: metaResult.responseText,
      fragmentTitle: metaResult.fragmentTitle,
      sandboxUrl: runtimeResult.sandboxUrl,
      files: runtimeResult.files,
    });

    return {
      ok: !runtimeResult.isError,
      url: runtimeResult.sandboxUrl,
      title: metaResult.fragmentTitle,
      files: runtimeResult.files,
      summary: runResult.summary,
    };
  } catch (error) {
    logger.error("code-agent failure", error);

    if (projectId) {
      await saveResultPhase({
        projectId,
        isError: true,
        responseText: "Something went wrong. Please try again",
        fragmentTitle: "Untitled",
        sandboxUrl: null,
        files: {},
      });
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      url: null,
      title: "Untitled",
      files: {},
      summary: "",
    };
  }
}
