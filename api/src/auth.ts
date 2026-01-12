import { NextFunction, Request, Response } from "express";

interface TokenIntrospectionResponse {
  active: boolean;
  username?: string;
  client_id?: string;
}

export async function validateToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.log("[API AUTH] ==================== TOKEN VALIDATION ====================");
  console.log("[API AUTH] Request:", req.method, req.path);
  
  const authHeader = req.headers.authorization;
  console.log("[API AUTH] Authorization header present:", !!authHeader);

  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[API AUTH] ❌ Missing or invalid authorization header");
    return res
      .status(401)
      .json({ error: "Missing or invalid authorization header" });
  }

  const token = authHeader.substring(7);
  console.log("[API AUTH] Token (first 20 chars):", token.substring(0, 20) + "...");
  
  const introspectionUrl = `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token/introspect`;
  console.log("[API AUTH] Introspection URL:", introspectionUrl);
  console.log("[API AUTH] Using client_id:", process.env.OAUTH_CLIENT_ID);

  try {
    const response = await fetch(introspectionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.OAUTH_CLIENT_ID!,
        client_secret: process.env.OAUTH_CLIENT_SECRET!,
        token,
      }),
    });

    console.log("[API AUTH] Introspection response status:", response.status);
    const data = (await response.json()) as TokenIntrospectionResponse;
    console.log("[API AUTH] Introspection response data:", JSON.stringify(data, null, 2));

    if (!data.active) {
      console.log("[API AUTH] ❌ Token is not active");
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    console.log("[API AUTH] ✅ Token validated successfully");
    console.log("[API AUTH] Username:", data.username);
    console.log("[API AUTH] Client ID:", data.client_id);
    
    req.user = data;
    next();
  } catch (error) {
    console.error("[API AUTH] ❌ Token validation failed:", error);
    return res
      .status(500)
      .json({ error: "Authentication service unavailable" });
  }
}
