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
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or invalid authorization header" });
  }

  const token = authHeader.substring(7);
  const introspectionUrl = `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token/introspect`;

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

    const data = (await response.json()) as TokenIntrospectionResponse;

    if (!data.active) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = data;
    next();
  } catch (error) {
    console.error("Token validation failed:", error);
    return res
      .status(500)
      .json({ error: "Authentication service unavailable" });
  }
}
