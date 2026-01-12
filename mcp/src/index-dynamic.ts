import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CallToolResult,
  isInitializeRequest,
  ReadResourceResult,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
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
    // For DCR, we use a registration access token or admin credentials
    registrationClientId: process.env.DCR_CLIENT_ID || "admin-cli",
    registrationClientSecret: process.env.DCR_CLIENT_SECRET || "",
    // MCP Server's own client credentials for introspection
    clientId: process.env.OAUTH_CLIENT_ID || "mcp-server",
    clientSecret: process.env.OAUTH_CLIENT_SECRET || "",
  },
};

// Store for dynamically registered clients (in-memory for demo)
// In production, use a database
interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
  created_at: number;
}

const registeredClients = new Map<string, RegisteredClient>();

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
    registration_endpoint: new URL(
      "clients-registrations/default",
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
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

console.log("[AUTH] OAuth configuration with DCR:");
console.log(`  - MCP Server URL: ${mcpServerUrl}`);
console.log(`  - Authorization: ${oauthMetadata.authorization_endpoint}`);
console.log(`  - Token: ${oauthMetadata.token_endpoint}`);
console.log(`  - Introspection: ${oauthMetadata.introspection_endpoint}`);
console.log(`  - Registration: ${oauthMetadata.registration_endpoint}`);

// Dynamic Client Registration endpoint
app.post("/register", async (req, res) => {
  console.log("[DCR] Received client registration request");
  console.log("[DCR] Request body:", JSON.stringify(req.body, null, 2));

  try {
    const {
      client_name,
      redirect_uris,
      grant_types = ["authorization_code", "refresh_token"],
      response_types = ["code"],
      scope = "mcp:tools openid profile",
      token_endpoint_auth_method = "client_secret_post",
    } = req.body;

    // Validate required fields
    if (!client_name) {
      return res.status(400).json({
        error: "invalid_client_metadata",
        error_description: "client_name is required",
      });
    }

    if (
      !redirect_uris ||
      !Array.isArray(redirect_uris) ||
      redirect_uris.length === 0
    ) {
      return res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array",
      });
    }

    // Register client with Keycloak
    const keycloakRegistrationUrl = oauthMetadata.registration_endpoint!;

    console.log(
      "[DCR] Registering client with Keycloak:",
      keycloakRegistrationUrl
    );

    const keycloakResponse = await fetch(keycloakRegistrationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // For open registration, no auth header needed if enabled in Keycloak
        // For protected registration, add: Authorization: Bearer <registration_access_token>
      },
      body: JSON.stringify({
        clientName: client_name,
        redirectUris: redirect_uris,
        grantTypes: grant_types,
        responseTypes: response_types,
        scope: scope,
        tokenEndpointAuthMethod: token_endpoint_auth_method,
      }),
    });

    if (!keycloakResponse.ok) {
      const errorText = await keycloakResponse.text();
      console.error("[DCR] ❌ Keycloak registration failed:", errorText);
      return res.status(keycloakResponse.status).json({
        error: "registration_failed",
        error_description: `Keycloak registration failed: ${errorText}`,
      });
    }

    const keycloakClient = await keycloakResponse.json();
    console.log(
      "[DCR] ✅ Client registered with Keycloak:",
      keycloakClient.clientId
    );

    // Store client locally
    const registeredClient: RegisteredClient = {
      client_id: keycloakClient.clientId,
      client_secret:
        keycloakClient.secret || keycloakClient.registrationAccessToken,
      client_name,
      redirect_uris,
      grant_types,
      response_types,
      scope,
      token_endpoint_auth_method,
      created_at: Date.now(),
    };

    registeredClients.set(registeredClient.client_id, registeredClient);
    console.log(`[DCR] Stored client locally: ${registeredClient.client_id}`);

    // Return client credentials per RFC 7591
    res.status(201).json({
      client_id: registeredClient.client_id,
      client_secret: registeredClient.client_secret,
      client_name: registeredClient.client_name,
      redirect_uris: registeredClient.redirect_uris,
      grant_types: registeredClient.grant_types,
      response_types: registeredClient.response_types,
      scope: registeredClient.scope,
      token_endpoint_auth_method: registeredClient.token_endpoint_auth_method,
      client_id_issued_at: Math.floor(registeredClient.created_at / 1000),
    });
  } catch (error: any) {
    console.error("[DCR] ❌ Registration error:", error);
    res.status(500).json({
      error: "server_error",
      error_description:
        error.message || "Internal server error during registration",
    });
  }
});

// Get registered client info (optional, for debugging)
app.get("/clients/:clientId", (req, res) => {
  const clientId = req.params.clientId;
  const client = registeredClients.get(clientId);

  if (!client) {
    return res.status(404).json({ error: "Client not found" });
  }

  // Don't expose client_secret in GET requests
  res.json({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    scope: client.scope,
    created_at: client.created_at,
  });
});

// Token verifier that works with dynamically registered clients
const tokenVerifier = {
  verifyAccessToken: async (token: string) => {
    console.log("[AUTH] Verifying access token...");
    const endpoint = oauthMetadata.introspection_endpoint;

    if (!endpoint) {
      console.error("[AUTH] ❌ No introspection endpoint in metadata");
      throw new Error("No token verification endpoint available in metadata");
    }

    // Use MCP Server's own credentials for introspection
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

    // Check if token was issued to a dynamically registered client
    const clientId = data.client_id || data.azp;
    if (registeredClients.has(clientId)) {
      console.log(
        `[AUTH] ℹ️ Token from dynamically registered client: ${clientId}`
      );
    }

    console.log("[AUTH] ✅ Token verified successfully");
    return {
      token,
      clientId: clientId,
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
    resourceName: "Product MCP Server (with DCR)",
  })
);

const authMiddleware = requireBearerAuth({
  verifier: tokenVerifier,
  requiredScopes: [],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
});

const mcpServer = new McpServer({
  name: "Product MCP Server with DCR",
  version: "1.0.0",
});

// Resources
console.log("[MCP] Registering resource: docs://product-description-guide");
mcpServer.registerResource(
  "product-description-guide",
  "docs://product-description-guide",
  {
    title: "Product Description Guidelines",
    description:
      "Best practices and guidelines for writing effective product descriptions",
    mimeType: "text/markdown",
  },
  async (uri): Promise<ReadResourceResult> => {
    console.log("[RESOURCE] Reading product description guide");
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const guidePath = path.join(
        process.cwd(),
        "product-description-guide.md"
      );
      const content = await fs.readFile(guidePath, "utf-8");
      return {
        contents: [
          {
            uri: uri.href,
            text: content,
            mimeType: "text/markdown",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: `Error reading guide: ${error}`,
            mimeType: "text/plain",
          },
        ],
      };
    }
  }
);

// Tools
mcpServer.tool(
  "get-products",
  "Get all products from the API",
  {},
  async (_params, { auth }) => {
    console.log("[TOOL] get-products called");

    const token = auth?.token;
    if (!token) {
      throw new Error("No authentication token available");
    }

    const response = await fetch(`${CONFIG.apiUrl}/products`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const products = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(products, null, 2),
        },
      ],
    } as CallToolResult;
  }
);

mcpServer.tool(
  "get-product",
  "Get a single product by ID",
  { id: getProductSchema },
  async (params, { auth }) => {
    console.log("[TOOL] get-product called with:", params);

    const token = auth?.token;
    if (!token) {
      throw new Error("No authentication token available");
    }

    const response = await fetch(`${CONFIG.apiUrl}/products/${params.id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const product = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(product, null, 2),
        },
      ],
    } as CallToolResult;
  }
);

mcpServer.tool(
  "browse-products",
  "Browse products efficiently using ResourceLinks. Returns lightweight references instead of full product data. The client can then fetch full details only for products of interest.",
  {},
  async (_params, { auth }) => {
    console.log("[TOOL] browse-products called");

    const token = auth?.token;
    if (!token) {
      throw new Error("No authentication token available");
    }

    const response = await fetch(`${CONFIG.apiUrl}/products`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const products = await response.json();
    const links: ResourceLink[] = products.map((p: any) => ({
      uri: `product://${p.id}`,
      name: p.name,
      description: p.description || `Product: ${p.name}`,
      mimeType: "application/json",
    }));

    return {
      content: [
        {
          type: "resource",
          resource: links,
        },
      ],
    } as CallToolResult;
  }
);

mcpServer.tool(
  "create-product",
  "Create a new product",
  createProductSchema,
  async (params, { auth }) => {
    console.log("[TOOL] create-product called with:", params);

    const token = auth?.token;
    if (!token) {
      throw new Error("No authentication token available");
    }

    const response = await fetch(`${CONFIG.apiUrl}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const product = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(product, null, 2),
        },
      ],
    } as CallToolResult;
  }
);

mcpServer.tool(
  "update-product",
  "Update product details (name, price, description)",
  updateProductSchema,
  async (params, { auth }) => {
    console.log("[TOOL] update-product called with:", params);

    const token = auth?.token;
    if (!token) {
      throw new Error("No authentication token available");
    }

    const { id, ...updateData } = params;
    const response = await fetch(`${CONFIG.apiUrl}/products/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(updateData),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const product = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(product, null, 2),
        },
      ],
    } as CallToolResult;
  }
);

mcpServer.tool(
  "write-product-description",
  "Generate a compelling product description following our guidelines",
  { id: getProductSchema },
  async (params) => {
    return {
      content: [
        {
          type: "text",
          text: `You are a product description writer. Using the product description guidelines, write a compelling description for this product:

Product ${params.id}

Follow these steps:
1. Review the product details
2. Read the product description guidelines resource (docs://product-description-guide)
3. Write a description that highlights benefits, includes specs, and follows our style guide
4. Make sure it's between 50-150 words
5. Update the product with the new description using update-product tool`,
        },
      ],
    } as CallToolResult;
  }
);

// Resource templates for individual products
console.log("[MCP] Registering resource template: product://{id}");
mcpServer.registerResource(
  "product-detail",
  new ResourceTemplate("product://{id}", {
    list: undefined,
  }),
  {
    title: "Product Details",
    description:
      "Individual product resource. Fetch full details for a specific product by ID.",
    mimeType: "application/json",
  },
  async (uri, variables, { auth }): Promise<ReadResourceResult> => {
    console.log("[RESOURCE] Reading product resource:", uri.href);

    const id = variables?.id;
    if (!id) {
      throw new Error("Product ID is required");
    }

    const token = auth?.token;
    if (!token) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              { error: "No authentication token available" },
              null,
              2
            ),
            mimeType: "application/json",
          },
        ],
      };
    }

    const response = await fetch(`${CONFIG.apiUrl}/products/${id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch product: ${response.statusText}`);
    }

    const product = await response.json();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(product, null, 2),
        },
      ],
    };
  }
);

// Transport management
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

const mcpPostHandler = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const token = (req as any).auth?.token;

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

    console.log("[POST] Connecting MCP server to transport...");
    await mcpServer.connect(transport);
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

// MCP endpoints
app.post("/mcp", authMiddleware, mcpPostHandler);
app.get("/mcp", authMiddleware, handleSessionRequest);
app.delete("/mcp", authMiddleware, handleSessionRequest);

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    dynamicRegistration: "enabled",
    registeredClients: registeredClients.size,
    sessions: Object.keys(transports).length,
  });
});

// Start server
app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(
    `\n🚀 Product MCP Server with DCR running at http://${CONFIG.host}:${CONFIG.port}`
  );
  console.log(`   - MCP endpoint: http://${CONFIG.host}:${CONFIG.port}/mcp`);
  console.log(
    `   - Registration: http://${CONFIG.host}:${CONFIG.port}/register`
  );
  console.log(`   - Health check: http://${CONFIG.host}:${CONFIG.port}/health`);
  console.log(
    `   - OAuth metadata: http://${CONFIG.host}:${CONFIG.port}/.well-known/oauth-protected-resource`
  );
  console.log(`\n📝 Keycloak: http://${CONFIG.auth.host}:${CONFIG.auth.port}`);
  console.log(`   - Realm: ${CONFIG.auth.realm}`);
  console.log(
    `   - Registration endpoint: ${oauthMetadata.registration_endpoint}`
  );
});
