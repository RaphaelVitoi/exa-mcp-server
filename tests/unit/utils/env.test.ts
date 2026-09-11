import { describe, expect, it } from "vitest";
import { parseEnvConfig } from "../../../src/utils/env.js";

describe("env utility", () => {
  it("provides sensible defaults when empty environment is passed", () => {
    const config = parseEnvConfig({});

    expect(config.RATE_LIMIT_QPS).toBe(2);
    expect(config.RATE_LIMIT_DAILY).toBe(50);
    expect(config.AGNOST_LOG_LEVEL).toBe("error");
    expect(config.DEBUG).toBe(false);
    expect(config.ENABLED_TOOLS).toBeUndefined();
    expect(config.OAUTH_USER_AGENTS).toEqual([]);
    expect(config.KV_REST_API_URL).toBeUndefined();
    expect(config.UPSTASH_REDIS_REST_URL).toBeUndefined();
  });

  it("parses valid custom environment configuration", () => {
    const config = parseEnvConfig({
      EXA_API_KEY: "test-api-key",
      DEBUG: "true",
      ENABLED_TOOLS: "web_search_exa,web_fetch_exa",
      OAUTH_USER_AGENTS: "Cursor, Windsurf",
      RATE_LIMIT_BYPASS: "BypassPrefix",
      EXA_API_KEY_BYPASS: "bypass-key",
      RATE_LIMIT_QPS: "5",
      RATE_LIMIT_DAILY: "200",
      KV_REST_API_URL: "https://redis.example.com",
      KV_REST_API_TOKEN: "redis-token",
    });

    expect(config.EXA_API_KEY).toBe("test-api-key");
    expect(config.DEBUG).toBe(true);
    expect(config.ENABLED_TOOLS).toEqual(["web_search_exa", "web_fetch_exa"]);
    expect(config.OAUTH_USER_AGENTS).toEqual(["Cursor", "Windsurf"]);
    expect(config.RATE_LIMIT_BYPASS).toBe("BypassPrefix");
    expect(config.EXA_API_KEY_BYPASS).toBe("bypass-key");
    expect(config.RATE_LIMIT_QPS).toBe(5);
    expect(config.RATE_LIMIT_DAILY).toBe(200);
    expect(config.KV_REST_API_URL).toBe("https://redis.example.com");
    expect(config.KV_REST_API_TOKEN).toBe("redis-token");
  });

  it("handles blank or whitespace URL strings gracefully", () => {
    const config = parseEnvConfig({
      KV_REST_API_URL: "   ",
      UPSTASH_REDIS_REST_URL: "",
    });

    expect(config.KV_REST_API_URL).toBeUndefined();
    expect(config.UPSTASH_REDIS_REST_URL).toBeUndefined();
  });

  it("falls back gracefully when numeric limits or URLs are invalid", () => {
    const config = parseEnvConfig({
      RATE_LIMIT_QPS: "-10",
      RATE_LIMIT_DAILY: "invalid",
      KV_REST_API_URL: "invalid-url-string",
    });

    expect(config.RATE_LIMIT_QPS).toBe(2);
    expect(config.RATE_LIMIT_DAILY).toBe(50);
    expect(config.KV_REST_API_URL).toBeUndefined();
  });
});
