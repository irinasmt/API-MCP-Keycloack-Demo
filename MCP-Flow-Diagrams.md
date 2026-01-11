# MCP Communication Flows

## 1. MCP Flow WITHOUT OAuth

```mermaid
sequenceDiagram
    participant Host as MCP Host<br/>(VS Code)
    participant Client as MCP Client<br/>(Built into VS Code)
    participant Server as MCP Server<br/>(Your Express App)

    Note over Host,Server: Server Startup
    Host->>Server: Start server process
    Server-->>Host: Server running on localhost:3002

    Note over Host,Server: 1. Initialization Phase
    Client->>Server: POST /mcp<br/>initialize request<br/>{protocolVersion, capabilities, clientInfo}
    Server->>Server: Register tools<br/>(get-products, create-product, etc.)
    Server-->>Client: initialize response<br/>{protocolVersion, capabilities, serverInfo}

    Client->>Server: POST /mcp<br/>initialized notification
    Server-->>Client: Acknowledged

    Note over Host,Server: 2. Discover Available Tools
    Client->>Server: POST /mcp<br/>tools/list request
    Server->>Server: Return registered tools<br/>with Zod schemas
    Server-->>Client: tools/list response<br/>[{name, description, inputSchema}]

    Note over Host,Server: 3. User Interaction
    Host->>Host: User asks:<br/>"Get all products"
    Host->>Client: Identify tool: get-products

    Note over Host,Server: 4. Execute Tool
    Client->>Server: POST /mcp<br/>tools/call request<br/>{name: "get-products", arguments: {}}
    Server->>Server: Execute tool handler<br/>Call Product API
    Server-->>Client: tools/call response<br/>{content: [{type: "text", text: "..."}]}

    Client-->>Host: Display results to user
```

## 2. MCP Flow WITH OAuth (Keycloak)

```mermaid
sequenceDiagram
    participant Host as MCP Host<br/>(VS Code)
    participant Client as MCP Client<br/>(Built into VS Code)
    participant Server as MCP Server<br/>(Your Express App)
    participant Keycloak as Keycloak<br/>(OAuth Provider)
    participant API as Product API<br/>(Protected Resource)

    Note over Host,Server: Server Startup
    Host->>Server: Start server process
    Server-->>Host: Server running on localhost:3002

    Note over Host,API: Phase 1: OAuth Discovery
    Client->>Server: GET /.well-known/oauth-protected-resource-metadata
    Server-->>Client: OAuth metadata<br/>{authorization_endpoint, token_endpoint, scopes}

    Note over Host,API: Phase 2: User Authorization
    Host->>Host: Prompt user to authorize
    Client->>Server: GET /oauth/authorize?client_id=...&redirect_uri=...
    Server->>Keycloak: Redirect to authorization endpoint<br/>with PKCE challenge

    Keycloak->>Keycloak: User logs in<br/>(if not already)
    Keycloak->>Host: Redirect to callback<br/>?code=AUTH_CODE&state=...

    Note over Host,API: Phase 3: Token Exchange
    Client->>Server: POST /oauth/token<br/>{code, code_verifier, client_id}
    Server->>Keycloak: POST token endpoint<br/>{grant_type: authorization_code, code, ...}
    Keycloak->>Keycloak: Validate PKCE<br/>Generate tokens
    Keycloak-->>Server: {access_token, refresh_token, expires_in}
    Server-->>Client: {access_token, refresh_token, expires_in}

    Client->>Client: Store tokens securely

    Note over Host,API: Phase 4: Initialize with Auth
    Client->>Server: POST /mcp<br/>Authorization: Bearer {token}<br/>initialize request
    Server->>Keycloak: POST introspection endpoint<br/>Verify token
    Keycloak-->>Server: {active: true, client_id, scope, exp}
    Server->>Server: Create session<br/>Register tools for user
    Server-->>Client: initialize response<br/>{protocolVersion, capabilities}

    Client->>Server: POST /mcp<br/>Authorization: Bearer {token}<br/>initialized notification
    Server-->>Client: Acknowledged

    Note over Host,API: Phase 5: Discover Tools (Authenticated)
    Client->>Server: POST /mcp<br/>Authorization: Bearer {token}<br/>tools/list request
    Server->>Keycloak: Verify token (cached/fast)
    Server->>Server: Return tools for this session
    Server-->>Client: tools/list response

    Note over Host,API: Phase 6: Execute Tool (Authenticated)
    Host->>Host: User asks: "Get products"
    Client->>Server: POST /mcp<br/>Authorization: Bearer {token}<br/>tools/call {name: "get-products"}
    Server->>Keycloak: Verify token
    Keycloak-->>Server: Token valid
    Server->>API: GET /products<br/>Authorization: Bearer {token}
    API->>API: Verify token<br/>Check permissions
    API-->>Server: [products data]
    Server-->>Client: tools/call response<br/>{content: [...]}
    Client-->>Host: Display results

    Note over Host,API: Phase 7: Token Refresh (When Expired)
    Client->>Client: Token expired
    Client->>Server: POST /oauth/token<br/>{grant_type: refresh_token, refresh_token}
    Server->>Keycloak: POST token endpoint
    Keycloak-->>Server: {access_token, refresh_token, expires_in}
    Server-->>Client: New tokens
    Client->>Client: Update stored tokens

    Note over Host,API: Continue with new token
    Client->>Server: POST /mcp<br/>Authorization: Bearer {new_token}<br/>tools/call request
    Server->>API: Request with new token
    API-->>Server: Response
    Server-->>Client: Response
```

## Key Differences

### Without OAuth:

- ✅ **Simple**: No authentication overhead
- ✅ **Fast**: Direct tool execution
- ❌ **Insecure**: No user identity or permissions
- ❌ **No access control**: All users have same access

### With OAuth:

- ✅ **Secure**: User identity verified via Keycloak
- ✅ **Fine-grained**: Per-user permissions and scopes
- ✅ **Token refresh**: Seamless token renewal
- ✅ **Audit trail**: Know who called which tools
- ⚠️ **Complex**: More moving parts
- ⚠️ **Latency**: Token verification on each request

## Important MCP Protocol Details

### Message Structure

All MCP messages use JSON-RPC 2.0 format:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get-products",
    "arguments": {}
  }
}
```

### Response Structure

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Product data..."
      }
    ]
  }
}
```

### OAuth Token Flow Details

**Authorization Request:**

```
GET /oauth/authorize?
  response_type=code
  &client_id=d8475370-0116-4e4b-ae30-6f9b0308d07c
  &redirect_uri=http://localhost:3002/oauth/callback
  &code_challenge=BASE64URL(SHA256(code_verifier))
  &code_challenge_method=S256
  &state=random_state
```

**Token Exchange:**

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTH_CODE
&redirect_uri=http://localhost:3002/oauth/callback
&client_id=d8475370-0116-4e4b-ae30-6f9b0308d07c
&client_secret=SECRET
&code_verifier=ORIGINAL_VERIFIER
```

**Token Introspection (Your Implementation):**

```
POST /realms/master/protocol/openid-connect/token/introspect
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)

token=ACCESS_TOKEN
```

## Your Implementation Highlights

### Server Entry Points:

1. **`GET /.well-known/oauth-protected-resource-metadata`**

   - Returns OAuth configuration
   - Handled by `mcpAuthMetadataRouter`

2. **`POST /mcp`**

   - Main MCP endpoint
   - Protected by `requireBearerAuth` middleware
   - Handles all JSON-RPC requests

3. **`GET /oauth/authorize`** (proxied to Keycloak)

   - Starts OAuth flow
   - Handled by `mcpAuthMetadataRouter`

4. **`POST /oauth/token`** (proxied to Keycloak)
   - Exchanges code for tokens
   - Handled by `mcpAuthMetadataRouter`

### Token Verification:

Your `verifyKeycloakToken()` function:

- Calls Keycloak introspection endpoint
- Validates `active: true`
- Validates `aud` (audience) matches API URL
- Returns `AuthInfo` with scopes and expiry
