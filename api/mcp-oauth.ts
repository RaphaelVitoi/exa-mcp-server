import { handleRequest } from "./mcp.js";

async function handleOAuthRequest(request: Request): Promise<Response> {
  return handleRequest(request, { forceOAuth: true, resourcePath: "mcp/oauth" });
}

// OPTIONS e repassado sem alteracao, entao re-exporta direto em vez de importar
// para reexportar.
export { handleOptions as OPTIONS } from "./mcp.js";

export { handleOAuthRequest as GET, handleOAuthRequest as POST, handleOAuthRequest as DELETE };
