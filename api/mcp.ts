process.env.AGNOST_LOG_LEVEL = "error";

import { randomUUID } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { initializeMcpServer, type McpConfig } from "../src/mcp-handler.js";
import { DEFAULT_MCP_MAX_DURATION_SECONDS, parsePositiveInteger } from "../src/tools/agentRun.js";
import type { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { isJwtToken, verifyOAuthToken } from "../src/utils/auth.js";
import {
  expandToolSelection,
  requiresUserProvidedApiKey,
  type ToolId,
} from "../src/toolRegistry.js";
import {
  buildMcpClientMetadata,
  extractInitializeClientInfo,
  MCP_CLIENT_SESSION_TTL_SECONDS,
  sanitizeMcpClientMetadata,
  type McpClientMetadata,
} from "../src/utils/mcpClientMetadata.js";

// Origin: '*' is safe — auth is per-request via headers/query, never cookies.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Accept, Content-Type, Authorization, x-api-key, x-exa-source, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * IP-based rate limiting configuration for free MCP users.
 * Users who provide their own API key via ?exaApiKey= bypass rate limiting.
 *
 * Rate limiting only applies to actual tool calls (tools/call method), not to
 * basic MCP protocol methods like tools/list, initialize, ping, etc.
 *
 * Environment variables (supports both Vercel KV and Upstash naming):
 * - KV_REST_API_URL or UPSTASH_REDIS_REST_URL: Redis connection URL
 * - KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN: Redis auth token
 * - RATE_LIMIT_QPS: Queries per second limit (default: 2)
 * - RATE_LIMIT_DAILY: Daily request quota (default: 50)
 */

// Lazy-initialize rate limiters only when Upstash is configured
let qpsLimiter: Ratelimit | null = null;
let dailyLimiter: Ratelimit | null = null;
let rateLimitersInitialization: Promise<boolean> | undefined;
let redisClient: Redis | null = null;

function getMcpClientSessionKey(sessionId: string): string {
  return `exa-mcp:client:${sessionId}`;
}

async function saveMcpClientMetadata(
  sessionId: string | undefined,
  metadata: McpClientMetadata | undefined,
  debug: boolean,
): Promise<void> {
  if (!sessionId || !metadata?.clientInfo) {
    return;
  }

  await initializeRateLimiters();

  if (!redisClient) {
    return;
  }

  try {
    await redisClient.set(getMcpClientSessionKey(sessionId), JSON.stringify(metadata), {
      ex: MCP_CLIENT_SESSION_TTL_SECONDS,
    });
  } catch (error) {
    if (debug) {
      console.error("[EXA-MCP] Failed to save MCP client metadata:", error);
    }
  }
}

async function loadMcpClientMetadata(
  sessionId: string | undefined,
  debug: boolean,
): Promise<McpClientMetadata | undefined> {
  if (!sessionId) {
    return undefined;
  }

  await initializeRateLimiters();

  if (!redisClient) {
    return undefined;
  }

  try {
    const value = await redisClient.get(getMcpClientSessionKey(sessionId));
    if (value === null || value === undefined) {
      return undefined;
    }

    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return sanitizeMcpClientMetadata(parsed);
  } catch (error) {
    if (debug) {
      console.error("[EXA-MCP] Failed to load MCP client metadata:", error);
    }
    return undefined;
  }
}

function initializeRateLimiters(): Promise<boolean> {
  if (rateLimitersInitialization) {
    return rateLimitersInitialization;
  }

  rateLimitersInitialization = (async () => {
    // Support both Vercel KV naming (KV_REST_API_*) and Upstash naming (UPSTASH_REDIS_REST_*)
    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
      console.log(
        "[EXA-MCP] Rate limiting disabled: KV_REST_API_URL/UPSTASH_REDIS_REST_URL or KV_REST_API_TOKEN/UPSTASH_REDIS_REST_TOKEN not configured",
      );
      return false;
    }

    try {
      const [{ Ratelimit }, { Redis }] = await Promise.all([
        import("@upstash/ratelimit"),
        import("@upstash/redis"),
      ]);

      redisClient = new Redis({
        url: redisUrl,
        token: redisToken,
      });

      const qpsLimit = Number.parseInt(process.env.RATE_LIMIT_QPS || "2", 10);
      const dailyLimit = Number.parseInt(process.env.RATE_LIMIT_DAILY || "50", 10);
      qpsLimiter = new Ratelimit({
        redis: redisClient,
        limiter: Ratelimit.slidingWindow(qpsLimit, "1 s"),
        prefix: "exa-mcp:qps",
      });
      dailyLimiter = new Ratelimit({
        redis: redisClient,
        limiter: Ratelimit.fixedWindow(dailyLimit, "1 d"),
        prefix: "exa-mcp:daily",
      });

      console.log(`[EXA-MCP] Rate limiting enabled: ${qpsLimit} QPS, ${dailyLimit}/day`);
      return true;
    } catch (error) {
      console.error("[EXA-MCP] Failed to initialize rate limiters:", error);
      return false;
    }
  })();

  return rateLimitersInitialization;
}

function getClientIp(request: Request): string | null {
  const vercelForwarded = request.headers.get("x-vercel-forwarded-for");
  const vercelForwardedFirst = vercelForwarded?.split(",")[0]?.trim();

  return vercelForwardedFirst || null;
}

const RATE_LIMIT_ERROR_MESSAGE = `You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.

Fix: Create API key at https://dashboard.exa.ai/api-keys , then either:
- Set the header: Authorization: Bearer YOUR_EXA_API_KEY
- Or use the URL: https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY`;

/**
 * Create a JSON-RPC 2.0 error response for rate limiting.
 * MCP uses JSON-RPC 2.0, so we need to return errors in the proper format.
 * Note: We intentionally hide rate limit dimension info (limit set to 0) to prevent
 * users from inferring which limit they hit (QPS vs daily).
 */
function createRateLimitResponse(retryAfterSeconds: number, reset: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: RATE_LIMIT_ERROR_MESSAGE,
      },
      id: null,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": "0",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(reset),
        ...CORS_HEADERS,
      },
    },
  );
}

function countRateLimitedCalls(body: string): number {
  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.filter(
      (message) => message && typeof message === "object" && message.method === "tools/call",
    ).length;
  } catch {
    return 0;
  }
}

function declaresJsonBody(request: Request): boolean {
  return (request.headers.get("content-type") || "").includes("application/json");
}

function isParsableJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function createParseErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    },
  );
}

function isInitializeMethod(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return parsed.method === "initialize";
  } catch {
    return false;
  }
}

/** 7-day TTL for ~10-minute bypass tracking buckets. */
const BYPASS_BUCKET_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Save IP and user agent for bypass requests to Redis for tracking.
 * Uses ~15-min-bucketed sorted sets (e.g. exa-mcp:bypass:2026-03-24T14:00, exa-mcp:bypass:2026-03-24T14:15)
 * to prevent unbounded growth that would hit Upstash's 100MB single-record limit.
 */
async function saveBypassRequestInfo(ip: string, userAgent: string, debug: boolean): Promise<void> {
  await initializeRateLimiters();

  if (!redisClient) {
    if (debug) {
      console.log("[EXA-MCP] Cannot save bypass info: Redis not configured");
    }
    return;
  }

  try {
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const minutes = date.getUTCMinutes();
    const bucket = Math.floor(minutes / 15) * 15;
    const bucketStr = `${date.toISOString().slice(0, 13)}:${String(bucket).padStart(2, "0")}`;
    const bucketKey = `exa-mcp:bypass:${bucketStr}`;
    const entry = JSON.stringify({ ip, userAgent, timestamp });

    await Promise.all([
      redisClient.zadd(bucketKey, { score: timestamp, member: entry }),
      redisClient.expire(bucketKey, BYPASS_BUCKET_TTL_SECONDS),
    ]);

    if (debug) {
      console.log(`[EXA-MCP] Saved bypass request info for IP: ${ip}`);
    }
  } catch (error) {
    console.error("[EXA-MCP] Failed to save bypass request info:", error);
  }
}

/**
 * Check rate limits for a given IP.
 * Returns null if within limits, or a Response if rate limited.
 */
async function checkRateLimits(
  ip: string | null,
  count: number,
  debug: boolean,
): Promise<Response | null> {
  if (!ip) {
    if (debug) {
      console.log("[EXA-MCP] Skipping rate limit: trusted client IP unavailable");
    }
    return null;
  }

  if (!qpsLimiter || !dailyLimiter) {
    return null; // Rate limiting not configured
  }

  try {
    // Check QPS limit first (more likely to be hit)
    const qpsResult = await qpsLimiter.limit(ip, { rate: count });
    if (!qpsResult.success) {
      if (debug) {
        console.log(`[EXA-MCP] QPS rate limit exceeded for IP: ${ip}`);
      }
      const retryAfter = Math.ceil((qpsResult.reset - Date.now()) / 1000);
      return createRateLimitResponse(retryAfter, qpsResult.reset);
    }

    // Check daily limit
    const dailyResult = await dailyLimiter.limit(ip, { rate: count });
    if (!dailyResult.success) {
      if (debug) {
        console.log(`[EXA-MCP] Daily rate limit exceeded for IP: ${ip}`);
      }
      const retryAfter = Math.ceil((dailyResult.reset - Date.now()) / 1000);
      return createRateLimitResponse(retryAfter, dailyResult.reset);
    }

    return null; // Within limits
  } catch (error) {
    // If rate limiting fails, allow the request through (fail open)
    console.error(
      "[EXA-MCP][ALERT][RATE_LIMIT_FAIL_OPEN] Rate limit check failed; allowing anonymous tools/call request:",
      error,
    );
    return null;
  }
}

/**
 * Vercel Function entry point for MCP server
 *
 * This handler is automatically deployed as a Vercel Function and provides
 * Streamable HTTP transport for the MCP protocol.
 *
 * Supports API key via header (recommended) or URL query parameter:
 * - x-api-key: YOUR_KEY - Pass API key via header (recommended)
 * - Authorization: Bearer YOUR_KEY - Pass API key via header (alternative)
 * - ?exaApiKey=YOUR_KEY - Pass API key via URL (backwards compatible)
 *
 * Other URL query parameters:
 * - ?tools=web_search_exa,web_fetch_exa - Enable specific tools
 * - ?debug=true - Enable debug logging
 * - ?agentCallWindowMs=45000 - Set the agent_run call window in milliseconds
 *
 * Also supports environment variables:
 * - EXA_API_KEY: Your Exa AI API key
 * - DEBUG: Enable debug logging (true/false)
 * - ENABLED_TOOLS: Comma-separated list of tools to enable
 *
 * Priority: x-api-key header > Authorization header > URL query parameter > environment variable.
 *
 * ARCHITECTURE NOTE:
 * The mcp-handler library creates a single server instance and doesn't pass
 * the request to the initializeServer callback. To support per-request
 * configuration via URL params (like ?tools=... and ?exaApiKey=...), we
 * create a fresh handler for each request. This ensures:
 * 1. Each request gets its own configuration (no API key leakage between users)
 * 2. Users can specify different tools and API keys per request
 */

/** Extract bearer token from Authorization header. */
function getBearerToken(request: Request): string | undefined {
  // (\S.*) em vez de (.+): \s+ e .+ se sobrepoem em espaco, e essa ambiguidade
  // e o backtracking super-linear. Exigir nao-branco no primeiro caractere da
  // captura fixa a fronteira. Efeito colateral desejado: "Bearer    " deixa de
  // devolver um token composto so de espaco, que o teste antigo aceitava.
  const match = /^Bearer\s+(\S.*)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

/**
 * Extract configuration from request headers, URL, or environment variables.
 * Priority: header > query parameter > environment variable.
 */

interface RequestConfig {
  exaApiKey?: string;
  enabledTools?: ToolId[];
  debug: boolean;
  userProvidedApiKey: boolean;
  authMethod: "oauth" | "api_key" | "free_tier";
  exaSource?: string;
  mcpSessionId?: string;
  mcpClient?: McpClientMetadata;
  defaultSearchType?: "auto" | "fast" | "instant";
  oauthAccessToken?: string;
  /** True when a Bearer token was a JWT but failed OAuth verification (expired, bad sig, wrong issuer/audience). */
  invalidOAuthJwt: boolean;
  agentCallWindowMs?: number;
  mcpMaxDurationSeconds?: number;
}

type SearchType = "auto" | "fast" | "instant";

type AuthResolution = {
  exaApiKey?: string;
  userProvidedApiKey: boolean;
  authMethod: "oauth" | "api_key" | "free_tier";
  oauthAccessToken?: string;
  invalidOAuthJwt: boolean;
  /** Nenhuma credencial veio em header -- unica situacao que libera a chave por query string. */
  headerCredentialAbsent: boolean;
};

/**
 * Resolve a credencial apresentada em header.
 * Prioridade: x-api-key > JWT OAuth > API key simples no Bearer.
 * Cada ramo e terminal, por isso sao retornos e nao atribuicoes sobre um acumulador.
 */
async function resolveHeaderAuth(request: Request): Promise<AuthResolution> {
  const envKey = process.env.EXA_API_KEY;

  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return {
      exaApiKey: xApiKey,
      userProvidedApiKey: true,
      authMethod: "api_key",
      invalidOAuthJwt: false,
      headerCredentialAbsent: false,
    };
  }

  const bearerToken = getBearerToken(request);
  if (!bearerToken) {
    return {
      exaApiKey: envKey,
      userProvidedApiKey: false,
      authMethod: "free_tier",
      invalidOAuthJwt: false,
      headerCredentialAbsent: true,
    };
  }

  if (!isJwtToken(bearerToken)) {
    return {
      exaApiKey: bearerToken,
      userProvidedApiKey: true,
      authMethod: "api_key",
      invalidOAuthJwt: false,
      headerCredentialAbsent: false,
    };
  }

  if (await verifyOAuthToken(bearerToken)) {
    return {
      exaApiKey: undefined,
      userProvidedApiKey: true,
      authMethod: "oauth",
      oauthAccessToken: bearerToken,
      invalidOAuthJwt: false,
      headerCredentialAbsent: false,
    };
  }

  // JWT que nao verifica NAO cai em silencio para a env key nem para o free tier:
  // a flag existe para o chamador devolver 401 com WWW-Authenticate.
  console.error("[EXA-MCP] Invalid OAuth JWT token");
  return {
    exaApiKey: envKey,
    userProvidedApiKey: false,
    authMethod: "free_tier",
    invalidOAuthJwt: true,
    headerCredentialAbsent: false,
  };
}

function parseToolSelection(raw: string | null | undefined): ToolId[] | undefined {
  if (!raw) return undefined;
  return expandToolSelection(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function asSearchType(value: string | null | undefined): SearchType | undefined {
  return value === "auto" || value === "fast" || value === "instant" ? value : undefined;
}

type UrlOverrides = {
  exaApiKey?: string;
  enabledTools?: ToolId[];
  debug?: boolean;
  defaultSearchType?: SearchType;
  agentCallWindowMs?: number;
};

function readUrlOverrides(request: Request, debug: boolean): UrlOverrides {
  try {
    const params = new URL(request.url).searchParams;
    return {
      exaApiKey: params.get("exaApiKey") || undefined,
      enabledTools: parseToolSelection(params.get("tools")),
      debug: params.has("debug") ? params.get("debug") === "true" : undefined,
      defaultSearchType: asSearchType(params.get("defaultSearchType")),
      agentCallWindowMs: parsePositiveInteger(params.get("agentCallWindowMs") ?? undefined),
    };
  } catch (error) {
    // URL invalida nao e fatal: o restante da configuracao vem de header e env.
    if (debug) console.error("Failed to parse request URL:", error);
    return {};
  }
}

/**
 * Extract configuration from request headers, URL, or environment variables.
 * Priority: x-api-key header > OAuth JWT > plain Bearer API key > query parameter > environment variable.
 */
async function getConfigFromRequest(request: Request): Promise<RequestConfig> {
  const auth = await resolveHeaderAuth(request);
  const envDebug = process.env.DEBUG === "true";
  const url = readUrlOverrides(request, envDebug);

  const urlKeyApplies = auth.headerCredentialAbsent && url.exaApiKey !== undefined;

  return {
    exaApiKey: urlKeyApplies ? url.exaApiKey : auth.exaApiKey,
    enabledTools: url.enabledTools ?? parseToolSelection(process.env.ENABLED_TOOLS),
    debug: url.debug ?? envDebug,
    userProvidedApiKey: urlKeyApplies || auth.userProvidedApiKey,
    authMethod: urlKeyApplies ? "api_key" : auth.authMethod,
    exaSource: request.headers.get("x-exa-source") || undefined,
    mcpSessionId: request.headers.get("MCP-Session-Id") || undefined,
    defaultSearchType: url.defaultSearchType ?? asSearchType(process.env.DEFAULT_SEARCH_TYPE),
    oauthAccessToken: auth.oauthAccessToken,
    invalidOAuthJwt: auth.invalidOAuthJwt,
    mcpMaxDurationSeconds: parsePositiveInteger(process.env.MCP_MAX_DURATION_SECONDS),
    agentCallWindowMs:
      url.agentCallWindowMs ?? parsePositiveInteger(process.env.AGENT_CALL_WINDOW_MS),
  };
}

/**
 * Create a fresh handler for the given configuration
 * We create a new handler per request to ensure each request gets its own
 * configuration (tools and API key). This prevents API key leakage between
 * different users who might pass different keys via URL.
 */
function createHandler(config: McpConfig) {
  const maxDuration = config.mcpMaxDurationSeconds ?? DEFAULT_MCP_MAX_DURATION_SECONDS;

  return createMcpHandler(
    (server: any) => {
      initializeMcpServer(server, config);
    },
    {
      serverInfo: {
        name: "exa-search-server",
        title: "Exa",
        version: "3.4.1",
        websiteUrl: "https://exa.ai",
        icons: [
          {
            src: "https://exa.ai/images/favicon-32x32.png",
            mimeType: "image/png",
            sizes: ["32x32"],
          },
        ],
      } satisfies Implementation as { name: string; version: string },
    },
    { basePath: "/api", maxDuration },
  );
}

function hasAuth(request: Request): boolean {
  if (request.headers.get("x-api-key")) return true;
  if (getBearerToken(request)) return true;
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("exaApiKey")) return true;
  } catch {
    // URL parsing failed — no auth
  }
  return false;
}

/**
 * Build a 401 Unauthorized response with an OAuth `Bearer` challenge.
 *
 * `reason` controls the `WWW-Authenticate` parameters per RFC 6750 §3:
 * - 'missing'        — no credentials were presented; advertise the resource so the client can start a flow.
 * - 'invalid_token'  — a token was presented but failed verification; include `error="invalid_token"` so the
 *                      client can distinguish "refresh/re-auth" from "start over from scratch" and trigger its
 *                      refresh-token exchange against the authorization server.
 */
function create401Response(
  reason: "missing" | "invalid_token" = "missing",
  resourcePath: string = "mcp",
): Response {
  const params: string[] = [
    ...(reason === "invalid_token"
      ? ['error="invalid_token"', 'error_description="The access token is invalid or expired"']
      : []),
    // RFC 9728: metadata lives at /.well-known/oauth-protected-resource/<resource path>,
    // and its `resource` field must exactly match the URL the client connected to.
    `resource_metadata="https://mcp.exa.ai/.well-known/oauth-protected-resource/${resourcePath}"`,
  ];

  const message =
    reason === "invalid_token"
      ? "The access token is invalid or expired. Refresh or re-authenticate."
      : "Authentication required. Use OAuth or provide an API key.";

  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer ${params.join(", ")}`,
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    },
  );
}

// Wrap so uncaught throws still return CORS headers — otherwise browsers see an opaque CORS error masking the real failure.
async function handleRequest(
  request: Request,
  options?: { forceOAuth?: boolean; resourcePath?: string },
): Promise<Response> {
  try {
    return await processRequest(request, options);
  } catch (error) {
    console.error("[EXA-MCP] Unhandled error in handleRequest:", error);
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
}

type RequestOptions = { forceOAuth?: boolean; resourcePath?: string };
type InitializeClientInfo = ReturnType<typeof extractInitializeClientInfo>;

type RequestGate = {
  bypassRateLimit: boolean;
  bypassApiKey?: string;
  requireOAuth: boolean;
  resourcePath: string;
};

// Caminhos que o rewrite da Vercel entrega e que o mcp-handler so reconhece
// como /api/mcp, que ele compara por url.pathname.
const NORMALIZED_PATHS = new Set(["/mcp", "/", "/mcp/oauth", "/mcp-oauth", "/api/mcp-oauth"]);

/**
 * Decide se a requisicao exige OAuth e se ela passa pelo bypass por user-agent.
 * O bypass e avaliado ANTES do portao de 401 para que clientes de bypass nunca
 * vejam prompt de autenticacao.
 */
function evaluateAuthGate(
  request: Request,
  userAgent: string,
  options?: RequestOptions,
): RequestGate {
  const bypassPrefix = process.env.RATE_LIMIT_BYPASS;
  const bypassApiKey = process.env.EXA_API_KEY_BYPASS;
  const bypassRateLimit = Boolean(
    bypassPrefix && bypassApiKey && userAgent.startsWith(bypassPrefix),
  );

  const oauthUserAgents =
    process.env.OAUTH_USER_AGENTS?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) || [];
  const userAgentMatchesOAuth = oauthUserAgents.some((ua) => userAgent.includes(ua));

  const requestUrl = new URL(request.url);
  const isPluginClient = requestUrl.searchParams.get("client")?.includes("plugin") ?? false;

  const loginParam = requestUrl.searchParams.get("login");
  const wantsLogin =
    loginParam !== null &&
    (loginParam === "" || ["1", "true", "yes"].includes(loginParam.toLowerCase()));

  return {
    bypassRateLimit,
    bypassApiKey,
    requireOAuth: Boolean(
      options?.forceOAuth || userAgentMatchesOAuth || isPluginClient || wantsLogin,
    ),
    resourcePath: options?.resourcePath ?? "mcp",
  };
}

function logRequestConfig(request: Request, config: RequestConfig): void {
  if (!config.debug) return;
  console.log(`[EXA-MCP] Request URL: ${request.url}`);
  console.log(`[EXA-MCP] Enabled tools: ${config.enabledTools?.join(", ") || "default"}`);
  console.log(`[EXA-MCP] Auth method: ${config.authMethod}`);
  console.log(
    `[EXA-MCP] API key provided: ${config.userProvidedApiKey ? "yes" : "no (using env var)"}`,
  );
}

// Usuario de bypass roda com chave propria do servico e segue marcado como
// NAO-fornecedor de chave, para continuar sujeito a contabilidade.
function applyBypassKey(
  config: RequestConfig,
  request: Request,
  gate: RequestGate,
  userAgent: string,
): void {
  if (!gate.bypassRateLimit || config.userProvidedApiKey) return;

  config.exaApiKey = gate.bypassApiKey;
  config.userProvidedApiKey = false;

  const clientIp = getClientIp(request);
  if (clientIp) {
    saveBypassRequestInfo(clientIp, userAgent, config.debug);
  } else if (config.debug) {
    console.log("[EXA-MCP] Skipping bypass request info save: trusted client IP unavailable");
  }
}

/** Devolve a resposta 429 quando o limite estoura, ou null quando a chamada segue. */
async function enforceRateLimit(
  request: Request,
  config: RequestConfig,
  body: string | undefined,
): Promise<Response | null> {
  if (config.userProvidedApiKey || request.method !== "POST") return null;

  // Apenas tools/call conta: metodos de protocolo como tools/list nao gastam cota.
  const rateLimitedCallCount = countRateLimitedCalls(body ?? "");
  if (rateLimitedCallCount === 0) {
    if (config.debug) console.log(`[EXA-MCP] Skipping rate limit for non-tool-call method`);
    return null;
  }

  await initializeRateLimiters();
  const clientIp = getClientIp(request);
  if (config.debug) {
    console.log(
      `[EXA-MCP] Client IP: ${clientIp ?? "unavailable"}, tools/call count: ${rateLimitedCallCount}`,
    );
  }

  return (await checkRateLimits(clientIp, rateLimitedCallCount, config.debug)) ?? null;
}

/**
 * Remove as credenciais antes de repassar ao mcp-handler.
 * O Agnost (trackMCP) envolve o transporte e captura headers, query params e a URL
 * inteira de toda requisicao. Sem esta limpeza, a chave do usuario vinda de
 * x-api-key ou ?exaApiKey= chegaria ao endpoint externo de analytics. A chave ja
 * foi extraida para `config`, entao as ferramentas continuam com acesso a ela.
 */
function sanitizeForwardedRequest(request: Request, body: string | undefined): Request {
  const url = new URL(request.url);
  if (NORMALIZED_PATHS.has(url.pathname)) {
    url.pathname = "/api/mcp";
  }
  url.searchParams.delete("exaApiKey");

  const sanitizedHeaders = new Headers(request.headers);
  sanitizedHeaders.delete("x-api-key");
  sanitizedHeaders.delete("authorization");

  return new Request(url.toString(), {
    method: request.method,
    headers: sanitizedHeaders,
    body,
    signal: request.signal,
  });
}

async function attachSessionId(
  response: Response,
  config: RequestConfig,
  initializeClientInfo: InitializeClientInfo,
  userAgent: string,
): Promise<Response> {
  const responseSessionId =
    response.headers.get("Mcp-Session-Id") ?? config.mcpSessionId ?? randomUUID();

  await saveMcpClientMetadata(
    responseSessionId,
    buildMcpClientMetadata({
      source: config.exaSource,
      sessionId: responseSessionId,
      clientInfo: initializeClientInfo,
      userAgent,
    }),
    config.debug,
  );

  if (response.headers.has("Mcp-Session-Id")) return response;

  const headers = new Headers(response.headers);
  headers.set("Mcp-Session-Id", responseSessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Main request handler that extracts config from URL and creates
 * a fresh handler for each request
 */
async function processRequest(request: Request, options?: RequestOptions): Promise<Response> {
  const body = request.method === "POST" ? await request.clone().text() : undefined;
  if (body !== undefined && declaresJsonBody(request) && !isParsableJson(body)) {
    return createParseErrorResponse();
  }

  const isInitializeRequest = isInitializeMethod(body ?? "");
  const initializeClientInfo = extractInitializeClientInfo(body);
  const userAgent = request.headers.get("user-agent") || "";

  const gate = evaluateAuthGate(request, userAgent, options);
  if (!gate.bypassRateLimit && gate.requireOAuth && !hasAuth(request)) {
    return create401Response("missing", gate.resourcePath);
  }

  const config = await getConfigFromRequest(request);

  // Um Bearer JWT que falha verificacao (expirado, assinatura ruim, issuer/audience
  // errado) precisa produzir 401 + WWW-Authenticate para o cliente saber que deve
  // renovar. Cair para a env key ou para o free tier mascararia o sinal de
  // credencial expirada e impediria o fluxo de refresh do cliente de disparar.
  if (config.invalidOAuthJwt) {
    return create401Response("invalid_token", gate.resourcePath);
  }

  if (!config.userProvidedApiKey && config.enabledTools?.some(requiresUserProvidedApiKey)) {
    return create401Response("missing", gate.resourcePath);
  }

  config.mcpClient = buildMcpClientMetadata({
    source: config.exaSource,
    sessionId: config.mcpSessionId,
    clientInfo: initializeClientInfo,
    stored: isInitializeRequest
      ? undefined
      : await loadMcpClientMetadata(config.mcpSessionId, config.debug),
    userAgent,
  });

  logRequestConfig(request, config);
  applyBypassKey(config, request, gate, userAgent);

  const rateLimited = await enforceRateLimit(request, config, body);
  if (rateLimited) return rateLimited;

  const handler = createHandler(config);
  const response = withCors(await handler(sanitizeForwardedRequest(request, body)));

  return isInitializeRequest && response.ok
    ? attachSessionId(response, config, initializeClientInfo, userAgent)
    : response;
}

function handleOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Export handlers for Vercel Functions
export {
  handleRequest as GET,
  handleRequest as POST,
  handleRequest as DELETE,
  handleOptions as OPTIONS,
};

export { handleRequest, handleOptions };
