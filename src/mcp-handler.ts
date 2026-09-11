import { trackMCP, createConfig } from "agnost";
import { z } from "zod";

// Import tool implementations
import { registerWebSearchTool } from "./tools/webSearch.js";
import { registerCompanyResearchTool } from "./tools/companyResearch.js";
import { registerWebFetchTool } from "./tools/webFetch.js";
import { registerPeopleSearchTool } from "./tools/peopleSearch.js";
import { registerLinkedInSearchTool } from "./tools/linkedInSearch.js";
import { registerDeepResearchStartTool } from "./tools/deepResearchStart.js";
import { registerDeepResearchCheckTool } from "./tools/deepResearchCheck.js";
import { registerExaCodeTool } from "./tools/exaCode.js";
import { registerWebSearchAdvancedTool } from "./tools/webSearchAdvanced.js";
import { registerDeepSearchTool } from "./tools/deepSearch.js";
import { registerAgentRunTool, resolveAgentCallWindowMs } from "./tools/agentRun.js";
import { agentSchemaTemplates } from "./tools/agentSchemaTemplates.js";
import {
  TOOL_REGISTRY,
  isAgentTool,
  listToolMetadata,
  requiresUserProvidedApiKey,
  type ToolId,
} from "./toolRegistry.js";
import { log } from "./utils/logger.js";
import { loadAgentSkillContent } from "./utils/agentSkill.js";

export interface McpConfig {
  exaApiKey?: string;
  enabledTools?: string[];
  debug?: boolean;
  userProvidedApiKey?: boolean;
  exaSource?: string;
  mcpSessionId?: string;
  mcpClient?: unknown;
  defaultSearchType?: "auto" | "fast" | "instant";
  oauthAccessToken?: string;
  agentCallWindowMs?: number;
  mcpMaxDurationSeconds?: number;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildCanRegisterTool(config: McpConfig) {
  const shouldRegister = (toolId: ToolId): boolean => {
    if (config.enabledTools && config.enabledTools.length > 0) {
      return config.enabledTools.includes(toolId);
    }
    return TOOL_REGISTRY[toolId]?.enabled ?? false;
  };

  return (toolId: ToolId): boolean => {
    if (!shouldRegister(toolId)) return false;
    if (requiresUserProvidedApiKey(toolId) && !config.userProvidedApiKey) return false;
    return true;
  };
}

function registerTools(
  server: any,
  config: McpConfig,
  canRegister: (id: ToolId) => boolean,
): string[] {
  const registered: string[] = [];

  const reg = (toolId: ToolId, fn: () => void) => {
    if (canRegister(toolId)) {
      fn();
      registered.push(toolId);
    }
  };

  reg("web_search_exa", () => registerWebSearchTool(server, config));
  reg("web_search_advanced_exa", () => registerWebSearchAdvancedTool(server, config));
  reg("company_research_exa", () => registerCompanyResearchTool(server, config));
  reg("web_fetch_exa", () => registerWebFetchTool(server, config));
  // Deprecated: crawling_exa — kept for backwards compatibility, points to web_fetch_exa
  reg("crawling_exa", () => registerWebFetchTool(server, config, "crawling_exa"));
  reg("people_search_exa", () => registerPeopleSearchTool(server, config));
  // Deprecated: linkedin_search_exa — kept for backwards compatibility
  reg("linkedin_search_exa", () => registerLinkedInSearchTool(server, config));
  reg("deep_researcher_start", () => registerDeepResearchStartTool(server, config));
  reg("deep_researcher_check", () => registerDeepResearchCheckTool(server, config));
  reg("get_code_context_exa", () => registerExaCodeTool(server, config));
  reg("deep_search_exa", () => registerDeepSearchTool(server, config));
  reg("agent_run", () =>
    registerAgentRunTool(server, config, {
      callWindowMs: resolveAgentCallWindowMs({
        agentCallWindowMs: config.agentCallWindowMs,
        mcpMaxDurationSeconds: config.mcpMaxDurationSeconds,
      }),
    }),
  );

  return registered;
}

function registerPromptsAndResources(
  server: any,
  registeredTools: string[],
) {
  server.prompt("web_search_help", "Get help with web search using Exa", {}, async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "I want to search the web for current information. Can you help me search for recent news about artificial intelligence breakthroughs?",
        },
      },
    ],
  }));

  // Registrado ANTES do bloco opcional de agentes: nao depende dele, e a ordem de
  // resources/list e contrato coberto por teste.
  server.resource(
    "tools_list",
    "exa://tools/list",
    { mimeType: "application/json", description: "List of available Exa tools and their descriptions" },
    async () => ({
      contents: [{ uri: "exa://tools/list", text: JSON.stringify(listToolMetadata(registeredTools), null, 2), mimeType: "application/json" }],
    }),
  );

  const agentTools = registeredTools.filter((id) => isAgentTool(id as ToolId));

  if (agentTools.length > 0) {
    const agentSkillContent = loadAgentSkillContent();

    server.prompt(
      "agent_research_help",
      "Get help structuring a multi-step Exa Agent research run.",
      {
        task: z.string().optional().describe("The research task to turn into an Exa Agent run"),
      },
      async (args?: { task?: string }) => {
        const task = args?.task?.trim();
        const taskLine = task
          ? `My research task:\n\n${task}`
          : "Help me turn my research task into an Exa Agent run with a clear objective, bounded output schema, coverage plan, and follow-up strategy.";
        return {
          messages: [
            { role: "user", content: { type: "text", text: `${taskLine}\n\nFollow the Exa Agent research guide below.` } },
            { role: "user", content: { type: "resource", resource: { uri: "exa://agent/skill", mimeType: "text/markdown", text: agentSkillContent } } },
          ],
        };
      },
    );

    server.resource(
      "agent_research_guide",
      "exa://agent/skill",
      { mimeType: "text/markdown", description: "Exa Agent research workflow, schema rules, and coverage guidance" },
      async () => ({
        contents: [{ uri: "exa://agent/skill", text: agentSkillContent, mimeType: "text/markdown" }],
      }),
    );

    server.resource(
      "agent_schema_templates",
      "exa://agent/schema-templates",
      { mimeType: "application/json", description: "Starter JSON Schema templates for common Agent workflows" },
      async () => ({
        contents: [{ uri: "exa://agent/schema-templates", text: JSON.stringify(agentSchemaTemplates, null, 2), mimeType: "application/json" }],
      }),
    );
  }
}

function attachAnalytics(server: any, debug: boolean) {
  const underlyingServer = (server as any).server ?? server;
  try {
    trackMCP(
      underlyingServer,
      "f0df908b-3703-40a0-a905-05c907da1ca3",
      createConfig({
        endpoint: "https://api.agnost.ai",
        disableLogs: true,
        disableInput: true,
        disableOutput: true,
        disableError: true,
      }),
    );
    if (debug) log("Agnost analytics tracking enabled");
  } catch (analyticsError) {
    // Log but don't fail if analytics setup fails
    if (debug) log(`Analytics tracking setup failed (non-critical): ${analyticsError}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize and configure the MCP server with all tools, prompts, and resources.
 * Called by both the Vercel Function (api/mcp.ts) and the stdio entry (src/stdio.ts).
 *
 * @param server - The MCP server instance (can be from McpServer or mcp-handler)
 * @param config - Configuration object with API key and tool settings
 */
export function initializeMcpServer(server: any, config: McpConfig = {}) {
  try {
    if (config.debug) {
      log("Initializing Exa MCP Server in debug mode");
      if (config.enabledTools) {
        log(`Enabled tools from config: ${config.enabledTools.join(", ")}`);
      }
    }

    const canRegister = buildCanRegisterTool(config);
    const registeredTools = registerTools(server, config, canRegister);

    if (config.debug) {
      log(`Registered ${registeredTools.length} tools: ${registeredTools.join(", ")}`);
    }

    registerPromptsAndResources(server, registeredTools);
    attachAnalytics(server, config.debug ?? false);

    if (config.debug) {
      log("MCP server initialization complete");
    }
  } catch (error) {
    log(`Server initialization error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
