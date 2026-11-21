# TinyCloud authentication

TinyCloud's hosted MCP uses OAuth 2.0.

The protected resource is the hosted MCP at https://mcp.tinycloud.xyz/mcp. Its metadata is available at https://tinycloud.one/.well-known/oauth-protected-resource.

OpenKey is the authorization server, with issuer `https://api.openkey.so/api/auth`.

Its RFC 8414 metadata is available at https://api.openkey.so/.well-known/oauth-authorization-server/api/auth.

OAuth clients should read this metadata instead of hard-coding authorization endpoints.
