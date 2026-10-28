import { createMcpMeetingTools } from "./dispatch.js";
import { createHttpMcpPort } from "./port.js";
import type { McpMeetingTools } from "./dispatch.js";

export interface McpChatWiring {
  mcpMeetings?: McpMeetingTools;
  mcpChatAccountAllowed?: (address: string) => boolean;
  mcpOwnerDidFor?: (address: string) => string;
}

const CONNECTORS_DATABASE = "xyz.tinycloud.tinychat/connectors";

/**
 * MCP chat is off unless MCP_CHAT_ENABLED is exactly "true" AND the MCP endpoint, the service credential and both
 * header names are configured AND MCP_CHAT_TEST_ACCOUNTS names at least one account (an empty list admits nobody).
 * Header names and the two optional 401 error values come from the MCP's native-auth contract; none is assumed here.
 */
export function mcpChatFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): McpChatWiring {
  if (env.MCP_CHAT_ENABLED !== "true") return {};
  const url = env.MCP_CHAT_URL?.trim();
  const serviceCredential = env.MCP_CHAT_SERVICE_CREDENTIAL;
  const serviceCredentialHeader = env.MCP_CHAT_SERVICE_CREDENTIAL_HEADER?.trim();
  const ownerDidHeader = env.MCP_CHAT_OWNER_DID_HEADER?.trim();
  const accounts = new Set((env.MCP_CHAT_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!url || !serviceCredential || !serviceCredentialHeader || !ownerDidHeader || accounts.size === 0) {
    console.warn("[startup] MCP_CHAT_ENABLED is set but the MCP chat configuration is incomplete; MCP chat is disabled.");
    return {};
  }
  const chainId = Number(env.MCP_CHAT_OWNER_CHAIN_ID ?? "1");
  const grantErrors = {
    ...(env.MCP_CHAT_GRANT_EXPIRED_ERROR ? { expired: env.MCP_CHAT_GRANT_EXPIRED_ERROR } : {}),
    ...(env.MCP_CHAT_GRANT_REJECTED_ERROR ? { rejected: env.MCP_CHAT_GRANT_REJECTED_ERROR } : {}),
  };
  const config = {
    url, serviceCredential, serviceCredentialHeader, ownerDidHeader, grantErrors,
    space: env.MCP_CHAT_SPACE?.trim() || "applications",
    database: CONNECTORS_DATABASE,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  return {
    mcpMeetings: createMcpMeetingTools(owner => createHttpMcpPort(config, owner)),
    mcpChatAccountAllowed: address => accounts.has(address.toLowerCase()),
    // The MCP canonicalizes the owner DID with a lowercase address (js-sdk packages/mcp native-auth canonicalOwnerDid).
    mcpOwnerDidFor: address => `did:pkh:eip155:${Number.isInteger(chainId) && chainId > 0 ? chainId : 1}:${address.toLowerCase()}`,
  };
}
