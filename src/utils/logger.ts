import { randomUUID } from "node:crypto";

/**
 * Simple logging utility for MCP server
 */
export const log = (message: string): void => {
  console.error(`[EXA-MCP-DEBUG] ${message}`);
};

export const createRequestLogger = (toolName: string) => {
  const requestId = `${toolName}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    log: (message: string): void => {
      log(`[${requestId}] [${toolName}] ${message}`);
    },
    start: (query: string): void => {
      log(`[${requestId}] [${toolName}] Starting search for query: "${query}"`);
    },
    error: (error: unknown): void => {
      log(
        `[${requestId}] [${toolName}] Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    complete: (): void => {
      log(`[${requestId}] [${toolName}] Successfully completed request`);
    },
  };
};
