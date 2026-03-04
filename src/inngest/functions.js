import { inngest } from "./client";
import {
  gemini,
  createAgent,
  createTool,
  createNetwork,
  createState,
} from "@inngest/agent-kit";
import Sandbox from "@e2b/code-interpreter";
import z from "zod";
import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "../../prompt";
import { lastAssistantTextMessageContent } from "./utils";
import db from "@/lib/db";
import { MessageRole, MessageType } from "@prisma/client";

const SHADCN_UTILS_PATH = "src/lib/utils.ts";
const SHADCN_UTILS_CONTENT = `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

const isAbsolutePath = (filePath) =>
  filePath.startsWith("/") || /^[A-Za-z]:\\/.test(filePath);

const toRelativeSandboxPath = (filePath) => {
  const normalized = filePath.replace(/^\/home\/user\//, "").replace(/^\.?\//, "");
  if (!normalized || isAbsolutePath(normalized) || normalized.startsWith("..")) {
    throw new Error(`Invalid file path "${filePath}". Use relative paths only.`);
  }
  return normalized;
};

const extractTextOutput = (output, fallbackValue) => {
  const first = output?.[0];
  if (!first || first.type !== "text") return fallbackValue;
  if (Array.isArray(first.content)) {
    return first.content
      .map((item) => (typeof item === "string" ? item : item?.text ?? ""))
      .join("")
      .trim() || fallbackValue;
  }
  return String(first.content || fallbackValue).trim();
};

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },

  async ({ event, step }) => {
    try {
      // Step-1
      const sandboxId = await step.run("get-sandbox-id", async () => {
        console.log("🔵 Creating sandbox...");
        const sandbox = await Sandbox.create("kunjmaheshwari2021/logick-v2");
        console.log("🟢 Sandbox created with ID:", sandbox.sandboxId);
        return sandbox.sandboxId;
      });

    const previousMessages = await step.run(
      "get-previous-messages",
      async()=>{
        const formattedMessages = [];

        const messages = await db.message.findMany({
          where:{
            projectId:event.data.projectId
          },
          orderBy:{
            createdAt:"asc"
          }
        })

        for(const message of messages){
          formattedMessages.push({
            type:"text",
            role:message.role === "ASSISTANT" ? "assistant" : "user",
            content:message.content
          })
        }

        return formattedMessages
      }
    )

    const state = createState({
      summary:"",
      files:{}
    }
  ,
  {
    messages:previousMessages
  }
)

    const codeAgent = createAgent({
      name: "code-agent",
      description: "An expert coding agent",
      system: PROMPT,
      model: gemini({ model: "gemini-2.5-flash" }),
      tools: [
        // 1. Terminal
        createTool({
          name: "terminal",
          description: "Use the terminal to run commands",
          parameters: z.object({
            command: z.string(),
          }),
          handler: async ({ command }) => {
            const buffers = { stdout: "", stderr: "" };

            try {
              const sandbox = await Sandbox.connect(sandboxId);

              const result = await sandbox.commands.run(command, {
                onStdout: (data) => {
                  buffers.stdout += data;
                },

                onStderr: (data) => {
                  buffers.stderr += data;
                },
              });

              return result.stdout || result.stderr || "Command executed.";
            } catch (error) {
              console.log(
                `Command failed: ${error} \n stdout: ${buffers.stdout}\n stderr: ${buffers.stderr}`
              );

              return `Command failed: ${error} \n stdout: ${buffers.stdout}\n stderr: ${buffers.stderr}`;
            }
          },
        }),

        // 2. createOrUpdateFiles
        createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in the sanbox",
          parameters: z.object({
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
              })
            ),
          }),

          handler: async ({ files }, { network }) => {
            try {
              const updatedFiles = network?.state?.data.files || {};
              const sandbox = await Sandbox.connect(sandboxId);

              for (const file of files) {
                const relativePath = toRelativeSandboxPath(file.path);
                await sandbox.files.write(relativePath, file.content);
                updatedFiles[relativePath] = file.content;
              }

              if (!updatedFiles[SHADCN_UTILS_PATH]) {
                await sandbox.files.write(SHADCN_UTILS_PATH, SHADCN_UTILS_CONTENT);
                updatedFiles[SHADCN_UTILS_PATH] = SHADCN_UTILS_CONTENT;
              }

              if (network) {
                network.state.data.files = updatedFiles;
              }
              return updatedFiles;
            } catch (error) {
              return "Error: " + error;
            }

          },
        }),
        // 3. readFiles
        createTool({
          name: "readFiles",
          description: "Read files in the sandbox",

          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }) => {
            try {
              const sandbox = await Sandbox.connect(sandboxId);
              const contents = [];

              for (const file of files) {
                const content = await sandbox.files.read(file);
                contents.push({ path: file, content });
              }
              return JSON.stringify(contents);
            } catch (error) {
              return "Error: " + error;
            }
          },
        }),
      ],

      lifecycle: {
        onResponse: async ({ result, network }) => {
          const lastAssistantMessageText =
            lastAssistantTextMessageContent(result);

          if (lastAssistantMessageText && network) {
            if (lastAssistantMessageText.includes("<task_summary>")) {
              network.state.data.summary = lastAssistantMessageText;
            }
          }

          return result;
        },
      },
    });

    const network = createNetwork({
      name: "coding-agent-network",
      agents: [codeAgent],
      maxIter: 5,

      router: async ({ network }) => {
        const summary = network.state.data.summary;

        if (summary) {
          return;
        }

        return codeAgent;
      },
    });

    const result = await network.run(event.data.value , {state});
    console.log("🟡 Network run completed");
    console.log("🟡 Summary:", result.state.data.summary);
    console.log("🟡 Files generated:", Object.keys(result.state.data.files || {}));

    const summaryText =
      result.state.data.summary || lastAssistantTextMessageContent(result) || "";

    const generatedFiles = result.state.data.files || {};
    const hasAppFiles = Object.keys(generatedFiles).some(
      (filePath) => filePath !== SHADCN_UTILS_PATH
    );
    const isError = !hasAppFiles;

    if (!isError && !generatedFiles[SHADCN_UTILS_PATH]) {
      const sandbox = await Sandbox.connect(sandboxId);
      await sandbox.files.write(SHADCN_UTILS_PATH, SHADCN_UTILS_CONTENT);
      generatedFiles[SHADCN_UTILS_PATH] = SHADCN_UTILS_CONTENT;
      result.state.data.files = generatedFiles;
    }

    let fragmentTitle = "Untitled";
    let responseText = "Here you go";

    if (!isError) {
      const fragmentTitleGenerator = createAgent({
        name: "fragment-title-generator",
        description: "Generate a title for the fragment",
        system: FRAGMENT_TITLE_PROMPT,
        model: gemini({ model: "gemini-2.5-flash" }),
      });

      const responseGenerator = createAgent({
        name: "response-generator",
        description: "Generate a response for the fragment",
        system: RESPONSE_PROMPT,
        model: gemini({ model: "gemini-2.5-flash" }),
      });

      try {
        const { output: fragmentTitleOutput } =
          await fragmentTitleGenerator.run(summaryText);
        const { output: responseOutput } =
          await responseGenerator.run(summaryText);

        fragmentTitle = extractTextOutput(fragmentTitleOutput, "Untitled");
        responseText = extractTextOutput(responseOutput, "Here you go");
      } catch (error) {
        console.error("Failed to generate title/response", error);
      }
    }

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      console.log("🔵 Connecting to sandbox for URL...");
      const sandbox = await Sandbox.connect(sandboxId);
      const host = sandbox.getHost(3000);
      const url = `http://${host}`;
      console.log("🟢 Sandbox URL generated:", url);
      return url;
    });

    await step.run("save-result" , async()=>{
      if(isError){
        console.log("🔴 Error detected. Saving ERROR message to DB");
        return await db.message.create({
          data:{
            projectId:event.data.projectId,
            content:"Something went wrong. Please try again",
            role:MessageRole.ASSISTANT,
            type:MessageType.ERROR
          }
        })
      }

      console.log("🟣 Saving RESULT message to DB");
      return await db.message.create({
        data:{
          projectId:event.data.projectId,
          content:responseText,
          role:MessageRole.ASSISTANT,
          type:MessageType.RESULT,
          fragments:{
            create:{
              sandboxUrl:sandboxUrl,
              title:fragmentTitle,
              files:result.state.data.files
            }
          }
        }
      })
    })

   

      return {
        url: sandboxUrl,
        title: fragmentTitle,
        files: result.state.data.files,
        summary: summaryText,
      };
    } catch (error) {
      console.error("code-agent failure", error);
      await step.run("save-unhandled-error", async () => {
        return db.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong. Please try again",
            role: MessageRole.ASSISTANT,
            type: MessageType.ERROR,
          },
        });
      });
      throw error;
    }
  }
);
