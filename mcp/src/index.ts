import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CallToolResult,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createProductSchema,
  getProductSchema,
  updateProductSchema,
} from "./tools/schemas.js";

const CONFIG = {
  host: process.env.HOST || "localhost",
  port: Number(process.env.PORT) || 3002,
  apiUrl: process.env.API_URL || "http://localhost:3000",
  auth: {
    host: process.env.AUTH_HOST || process.env.HOST || "localhost",
    port: Number(process.env.AUTH_PORT) || 8080,
    realm: process.env.AUTH_REALM || "master",
    clientId: process.env.OAUTH_CLIENT_ID || "mcp-server",
    clientSecret: process.env.OAUTH_CLIENT_SECRET || "",
  },
};

function createOAuthUrls() {
  const authBaseUrl = new URL(
    `http://${CONFIG.auth.host}:${CONFIG.auth.port}/realms/${CONFIG.auth.realm}/`
  );
  return {
    issuer: authBaseUrl.toString(),
    introspection_endpoint: new URL(
      "protocol/openid-connect/token/introspect",
      authBaseUrl
    ).toString(),
    authorization_endpoint: new URL(
      "protocol/openid-connect/auth",
      authBaseUrl
    ).toString(),
    token_endpoint: new URL(
      "protocol/openid-connect/token",
      authBaseUrl
    ).toString(),
  };
}

function createRequestLogger() {
  return (req: any, res: any, next: any) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(
        `${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms`
      );
    });
    next();
  };
}

const app = express();

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf?.toString() ?? "";
    },
  })
);

app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

app.use(createRequestLogger());

const mcpServerUrl = new URL(`http://${CONFIG.host}:${CONFIG.port}/mcp`);
const oauthUrls = createOAuthUrls();

const oauthMetadata: OAuthMetadata = {
  ...oauthUrls,
  response_types_supported: ["code"],
};

console.log("[AUTH] OAuth configuration:");
console.log(`  - MCP Server URL: ${mcpServerUrl}`);
console.log(`  - Authorization: ${oauthMetadata.authorization_endpoint}`);
console.log(`  - Token: ${oauthMetadata.token_endpoint}`);
console.log(`  - Introspection: ${oauthMetadata.introspection_endpoint}`);

const tokenVerifier = {
  verifyAccessToken: async (token: string) => {
    console.log("[AUTH] Verifying access token...");
    const endpoint = oauthMetadata.introspection_endpoint;

    if (!endpoint) {
      console.error("[AUTH] ❌ No introspection endpoint in metadata");
      throw new Error("No token verification endpoint available in metadata");
    }

    const params = new URLSearchParams({
      token: token,
      client_id: CONFIG.auth.clientId,
    });

    if (CONFIG.auth.clientSecret) {
      params.set("client_secret", CONFIG.auth.clientSecret);
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
    } catch (e) {
      console.error("[AUTH] ❌ Introspection fetch threw", e);
      throw e;
    }

    if (!response.ok) {
      const txt = await response.text();
      console.error("[AUTH] ❌ Introspection non-OK", {
        status: response.status,
        body: txt,
      });
      throw new Error(`Invalid or expired token`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (e) {
      const txt = await response.text();
      console.error("[AUTH] ❌ Failed to parse introspection JSON", {
        error: String(e),
        body: txt,
      });
      throw e;
    }

    console.log("[AUTH] Token introspection response:", data);

    if (data.active === false) {
      console.error("[AUTH] ❌ Token is not active");
      throw new Error("Inactive token");
    }

    if (!data.aud) {
      console.warn(
        "[AUTH] ⚠️ Resource indicator (aud) missing - allowing anyway"
      );
      // Don't fail if aud is missing, just warn
    } else {
      const audiences: string[] = Array.isArray(data.aud)
        ? data.aud
        : [data.aud];
      const allowed = audiences.some((a) =>
        checkResourceAllowed({
          requestedResource: a,
          configuredResource: mcpServerUrl,
        })
      );
      if (!allowed) {
        console.error(
          `[AUTH] ❌ None of the provided audiences are allowed. Expected ${mcpServerUrl}, got: ${audiences.join(
            ", "
          )}`
        );
        throw new Error(
          `None of the provided audiences are allowed. Expected ${mcpServerUrl}, got: ${audiences.join(
            ", "
          )}`
        );
      }
    }

    console.log("[AUTH] ✅ Token verified successfully");
    return {
      token,
      clientId: data.client_id,
      scopes: data.scope ? data.scope.split(" ") : [],
      expiresAt: data.exp,
    };
  },
};

app.use(
  mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: mcpServerUrl,
    scopesSupported: ["mcp:tools"],
    resourceName: "Product MCP Server",
  })
);

const authMiddleware = requireBearerAuth({
  verifier: tokenVerifier,
  requiredScopes: [],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
});

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

function createMcpServer(token?: string) {
  console.log("[MCP] Creating new McpServer instance...");
  console.log("[MCP] Token available:", !!token);

  const server = new McpServer({
    name: "product-mcp",
    version: "1.0.0",
  });

  // Register get-products tool
  console.log("[MCP] Registering tool: get-products");
  server.registerTool(
    "get-products",
    {
      description: "Get all products from the API",
      inputSchema: z.object({}),
    },
    async (): Promise<CallToolResult> => {
      console.log("[TOOL] Executing get-products");
      if (!token) {
        return {
          content: [
            { type: "text", text: "Error: No authentication token available" },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${CONFIG.apiUrl}/products`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error}` }],
          isError: true,
        };
      }
    }
  );

  // Register get-product tool
  console.log("[MCP] Registering tool: get-product");
  server.registerTool(
    "get-product",
    {
      description: "Get a single product by ID",
      inputSchema: getProductSchema,
    },
    async ({ id }): Promise<CallToolResult> => {
      console.log("[TOOL] Executing get-product with id:", id);
      if (!token) {
        return {
          content: [
            { type: "text", text: "Error: No authentication token available" },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${CONFIG.apiUrl}/products/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error}` }],
          isError: true,
        };
      }
    }
  );

  // Register create-product tool
  console.log("[MCP] Registering tool: create-product");
  server.registerTool(
    "create-product",
    {
      description: "Create a new product",
      inputSchema: createProductSchema,
    },
    async ({ name, price, description }): Promise<CallToolResult> => {
      console.log("[TOOL] Executing create-product with:", {
        name,
        price,
        description,
      });
      if (!token) {
        return {
          content: [
            { type: "text", text: "Error: No authentication token available" },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${CONFIG.apiUrl}/products`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name, price, description }),
        });
        const data = await response.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error}` }],
          isError: true,
        };
      }
    }
  );

  // Register update-product tool
  console.log("[MCP] Registering tool: update-product");
  server.registerTool(
    "update-product",
    {
      description: "Update product details (name, price, description)",
      inputSchema: updateProductSchema,
    },
    async ({ id, ...updates }): Promise<CallToolResult> => {
      console.log(
        "[TOOL] Executing update-product with id:",
        id,
        "updates:",
        updates
      );
      if (!token) {
        return {
          content: [
            { type: "text", text: "Error: No authentication token available" },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${CONFIG.apiUrl}/products/${id}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updates),
        });
        const data = await response.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error}` }],
          isError: true,
        };
      }
    }
  );

  console.log("[MCP] All tools registered. Total tools: 4");
  console.log(
    "[MCP] Tools: get-products, get-product, create-product, update-product"
  );
  return server;
}

const mcpPostHandler = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const token = (req as any).auth?.token;

  console.log("[POST] ==================== NEW REQUEST ====================");
  console.log("[POST] Session ID:", sessionId || "<none>");
  console.log("[POST] Request method:", req.body?.method || "<unknown>");
  console.log("[POST] Token available:", !!token);

  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    console.log("[POST] Reusing existing transport for session:", sessionId);
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    console.log("[POST] *** NEW INITIALIZATION REQUEST DETECTED ***");
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        console.log(`[POST] ✅ Session initialized: ${sessionId}`);
        transports[sessionId] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        console.log(
          `[POST] 🔄 Transport closed for session ${transport.sessionId}`
        );
        delete transports[transport.sessionId];
      }
    };

    console.log("[POST] Creating MCP server with token...");
    const server = createMcpServer(token);
    console.log("[POST] Connecting server to transport...");
    await server.connect(transport);
    console.log("[POST] ✅ Server connected to transport");
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
};

const handleSessionRequest = async (
  req: express.Request,
  res: express.Response
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.log("[SESSION] Handling session request for:", sessionId);

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get("/health", (req: express.Request, res: express.Response) => {
  res.json({
    status: "ok",
    sessions: Object.keys(transports).length,
    config: {
      host: CONFIG.host,
      port: CONFIG.port,
      apiUrl: CONFIG.apiUrl,
      auth: {
        realm: CONFIG.auth.realm,
        clientId: CONFIG.auth.clientId,
      },
    },
  });
});

app.post("/mcp", authMiddleware, mcpPostHandler);
app.get("/mcp", authMiddleware, handleSessionRequest);
app.delete("/mcp", authMiddleware, handleSessionRequest);

app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`🚀 Product MCP Server running on ${mcpServerUrl.origin}`);
  console.log(`📡 MCP endpoint: ${mcpServerUrl}`);
  console.log(`💚 Health check: http://${CONFIG.host}:${CONFIG.port}/health`);
  console.log(
    `🔐 OAuth metadata: ${getOAuthProtectedResourceMetadataUrl(mcpServerUrl)}`
  );
});
