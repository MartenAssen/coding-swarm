import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { traceAgent } from "./lib/tracing.js";
import type { RoleConfig } from "./roles/index.js";

function extractText(message: any): string {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

export async function invokeAgent(
  prompt: string,
  role: RoleConfig,
): Promise<string> {
  return traceAgent(
    `${role.name}-invoke`,
    prompt,
    { role: role.name, displayName: role.displayName },
    async () => {
      let resultText = "";

      const toolServer = createSdkMcpServer({
        name: `${role.name}-tools`,
        version: "1.0.0",
        tools: role.tools,
      });

      const agents: Record<string, any> = {};
      if (role.hasDevAgent) {
        agents["dev-agent"] = {
          description:
            "Autonomous coding agent with full file system and shell access. " +
            "Use for implementing features, fixing bugs, refactoring code, " +
            "running tests, and any task that requires reading/writing files or executing commands.",
          prompt:
            "You are an autonomous dev agent working in Steyn's homelab repo. " +
            "Implement tasks fully. Commit your work with descriptive messages. " +
            "Do not ask questions — make reasonable decisions and proceed.",
          model: role.devAgentModel ?? "opus",
        };
      }

      const session = query({
        prompt,
        options: {
          model: role.model,
          cwd: process.env.REPO_DIR || "/data/repo",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: role.maxTurns,
          systemPrompt: role.systemPrompt,
          stderr: (data: string) => process.stderr.write(data),
          mcpServers: {
            [`${role.name}-tools`]: toolServer,
          },
          agents,
        },
      });

      try {
        for await (const message of session) {
          console.log(
            `[sdk] message type=${message.type}${"subtype" in message ? ` subtype=${message.subtype}` : ""}`,
          );
          if (message.type === "result") {
            const msg = message as any;
            if (msg.subtype === "success") {
              resultText = msg.result;
            } else {
              resultText = `Error: ${msg.errors?.join("; ") ?? msg.subtype}`;
              console.error(
                `[sdk] result error:`,
                JSON.stringify(msg).slice(0, 500),
              );
            }
          }
        }
      } catch (err) {
        // The SDK throws if the Claude Code process exits with non-zero,
        // even after sending a success result. If we already got a result, use it.
        if (resultText) {
          console.warn(
            `[sdk] Process exited with error after success result, ignoring:`,
            err instanceof Error ? err.message : String(err),
          );
        } else {
          throw err;
        }
      }

      return resultText || "No response";
    },
  );
}
