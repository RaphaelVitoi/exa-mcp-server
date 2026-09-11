import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_CONFIG, createExaClient, integrationHeaders } from "./config.js";
import { ExaDeepSearchRequest, ExaDeepSearchResponse } from "../types.js";
import { createRequestLogger } from "../utils/logger.js";
import { retryWithBackoff, formatToolError } from "../utils/errorHandler.js";
import { sanitizeDeepSearchStructuredResponse } from "../utils/exaResponseSanitizer.js";
import {
  lenientString,
  lenientOptionalNumber,
  lenientOptionalPositiveNumber,
  lenientOptionalBoolean,
} from "./validation.js";
import { checkpoint } from "agnost";

const deepSearchInputShape = {
      objective: lenientString().describe(
        "Natural language description of what the web search is looking for. Try to make the search query atomic - looking for a specific piece of information.",
      ),
      search_queries: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of keyword search queries related to the objective. Limited to 5 entries of up to 5 words each (~200 characters).",
        ),
      type: z
        .enum(["deep", "deep-reasoning"])
        .optional()
        .describe(
          "Search depth - 'deep': fast deep search (4-12s, default), 'deep-reasoning': thorough with reasoning (12-50s)",
        ),
      numResults: lenientOptionalNumber().describe(
        "Number of search results to return (default: 8)",
      ),
      highlightMaxCharacters: lenientOptionalPositiveNumber().describe(
        "Maximum characters for highlights per result (default: 4000)",
      ),
      outputSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "JSON schema for structured output. Must include a 'type' field set to 'object' or 'text'. For 'object' type, optionally include 'properties' and 'required'. Max 10 total properties, max nesting depth 2. When provided, automatically enables structured output mode.",
        ),
      systemPrompt: z
        .string()
        .max(32000)
        .optional()
        .describe("Instructions for how the deep search agent should process and format results."),
      structuredOutput: lenientOptionalBoolean().describe(
        "When true, returns a structured JSON response instead of markdown. The API will determine the appropriate structure based on the query. Prefer using outputSchema for more control over the response shape.",
      ),
};

type DeepSearchConfig = { exaApiKey?: string; userProvidedApiKey?: boolean };
type DeepSearchLogger = ReturnType<typeof createRequestLogger>;
type DeepSearchResult = ExaDeepSearchResponse["results"][number];
type DeepSearchGrounding = NonNullable<NonNullable<ExaDeepSearchResponse["output"]>["grounding"]>;

type DeepSearchArgs = {
  objective: string;
  search_queries?: string[];
  type?: "deep" | "deep-reasoning";
  numResults?: number;
  highlightMaxCharacters?: number;
  outputSchema?: Record<string, unknown>;
  systemPrompt?: string;
  structuredOutput?: boolean;
};

// outputSchema explicito vence o flag structuredOutput: quem declarou a forma
// esperada nao deve receber o objeto generico no lugar dela.
function resolveOutputSchema(
  args: DeepSearchArgs,
  logger: DeepSearchLogger,
): Record<string, unknown> | undefined {
  if (args.outputSchema) {
    logger.log("Using custom output schema");
    return args.outputSchema;
  }
  if (args.structuredOutput) {
    logger.log("Using default structured output");
    return { type: "object" };
  }
  return undefined;
}

function resolveAdditionalQueries(
  searchQueries: string[] | undefined,
  logger: DeepSearchLogger,
): string[] | undefined {
  if (searchQueries && searchQueries.length > 0) {
    logger.log(`Using ${searchQueries.length} additional queries`);
    return searchQueries;
  }
  logger.log("Using automatic query expansion");
  return undefined;
}

function buildDeepSearchRequest(
  args: DeepSearchArgs,
  logger: DeepSearchLogger,
): ExaDeepSearchRequest {
  const outputSchema = resolveOutputSchema(args, logger);
  const additionalQueries = resolveAdditionalQueries(args.search_queries, logger);
  if (args.systemPrompt) logger.log("Using system prompt");

  return {
    query: args.objective,
    type: args.type || "deep",
    numResults: args.numResults || API_CONFIG.DEFAULT_NUM_RESULTS,
    contents: {
      highlights: {
        maxCharacters: args.highlightMaxCharacters || 4000,
      },
    },
    ...(outputSchema ? { outputSchema } : {}),
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    ...(additionalQueries ? { additionalQueries } : {}),
  };
}

function formatResultEntry(result: DeepSearchResult, index: number): string {
  return [
    `### ${index + 1}. ${result.title || "Untitled"}`,
    `**URL:** ${result.url}`,
    ...(result.publishedDate ? [`**Published:** ${result.publishedDate}`] : []),
    ...(result.image ? [`**Image:** ${result.image}`] : []),
    ...(result.highlights && result.highlights.length > 0
      ? [`\n${result.highlights.join("\n\n")}`]
      : []),
  ].join("\n");
}

function formatCitations(grounding: DeepSearchGrounding): string | undefined {
  const citations = grounding.flatMap((entry) =>
    (entry.citations ?? []).map((citation) => `- [${citation.title}](${citation.url})`),
  );
  return citations.length > 0 ? `## Citations\n\n${citations.join("\n")}` : undefined;
}

function buildMarkdownSections(data: ExaDeepSearchResponse): string[] {
  // O original exigia content truthy ALEM de string: uma answer vazia nao vira
  // secao "## Answer" sem corpo.
  const content = data.output?.content;
  const answer =
    typeof content === "string" && content.length > 0 ? `## Answer\n\n${content}` : undefined;
  const citations = data.output?.grounding ? formatCitations(data.output.grounding) : undefined;
  const results =
    data.results && data.results.length > 0
      ? `## Results\n\n${data.results.map(formatResultEntry).join("\n\n---\n\n")}`
      : undefined;

  return [answer, citations, results].filter((section): section is string => section !== undefined);
}

function textContent(text: string, meta?: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text,
        ...(meta ? { _meta: meta } : {}),
      },
    ],
  };
}

export function registerDeepSearchTool(server: McpServer, config?: DeepSearchConfig): void {
  server.registerTool(
    "deep_search_exa",
    {
      description: `[Deprecated: Use web_search_advanced_exa instead] Deep search with automatic query expansion for thorough research. Generates multiple search variations to find results from multiple angles, then synthesizes a short answer with citations.

Best for: Complex questions needing information from multiple angles.
Returns: A synthesized answer with citations, plus individual search results with highlights. When structuredOutput is enabled, returns structured JSON instead of markdown.
Note: Requires an Exa API key. 'deep' mode takes 4-12s, 'deep-reasoning' takes 12-50s.`,
      inputSchema: deepSearchInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      const logger = createRequestLogger("deep_search_exa");
      logger.start(args.objective);

      try {
        const exa = createExaClient(config);
        const searchRequest = buildDeepSearchRequest(args as DeepSearchArgs, logger);

        checkpoint("deep_search_request_prepared");
        logger.log("Sending deep search request to Exa API");

        const response = await retryWithBackoff(() =>
          exa.request<ExaDeepSearchResponse>(
            API_CONFIG.ENDPOINTS.SEARCH,
            "POST",
            searchRequest,
            undefined,
            integrationHeaders("deep-search-mcp", config),
          ),
        );

        checkpoint("deep_search_response_received");
        logger.log("Received response from Exa API");

        if (!response) {
          logger.log("Warning: Empty response from Exa API");
          checkpoint("deep_search_complete");
          return textContent("No search results found. Please try a different query.");
        }

        if (args.outputSchema || args.structuredOutput) {
          const text = JSON.stringify(sanitizeDeepSearchStructuredResponse(response), null, 2);
          logger.log(`Structured response prepared with ${text.length} characters`);
          checkpoint("deep_search_complete");
          logger.complete();
          return textContent(text);
        }

        const sections = buildMarkdownSections(response);
        const text =
          sections.length > 0
            ? sections.join("\n\n---\n\n")
            : "No results found. Please try a different query.";
        logger.log(`Response prepared with ${text.length} characters`);

        checkpoint("deep_search_complete");
        logger.complete();
        return textContent(text, {
          searchTime: typeof response.searchTime === "number" ? response.searchTime : undefined,
        });
      } catch (error) {
        checkpoint("deep_search_complete");
        logger.error(error);
        return formatToolError(error, "deep_search_exa", config?.userProvidedApiKey);
      }
    },
  );
}
