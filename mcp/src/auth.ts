import type { AuthInfo } from "@modelcontextprotocol/sdk/types.js";

// For now, let's create a simple token verifier
// The ProxyOAuthServerProvider might not be available in the SDK version you have
export async function verifyKeycloakToken(token: string): Promise<AuthInfo> {
  const keycloakUrl = process.env.KEYCLOAK_URL!;
  const realm = process.env.KEYCLOAK_REALM!;
  const clientId = process.env.OAUTH_CLIENT_ID!;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET!;

  console.log("[AUTH] Verifying access token...");
  const introspectionUrl = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/token/introspect`;

  const response = await fetch(introspectionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token,
    }),
  });

  if (!response.ok) {
    console.log("[AUTH] ❌ Token verification failed");
    throw new Error("Token verification failed");
  }

  const data = await response.json();
  console.log("[AUTH] Token introspection response:", data);

  if (!data.active) {
    console.log("[AUTH] ❌ Token is not active");
    throw new Error("Invalid or expired token");
  }

  console.log("[AUTH] ✅ Token verified successfully");
  return {
    token,
    clientId: data.client_id,
    scopes: data.scope ? data.scope.split(" ") : [],
    expiresAt: data.exp,
  };
}
