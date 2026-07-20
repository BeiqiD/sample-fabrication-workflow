import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./types";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function normalizedTeamDomain(value: string) {
  return value.trim().replace(/\/$/, "");
}

export function allowedEmail(email: string, allowlist?: string) {
  if (!allowlist?.trim()) return true;
  const allowed = new Set(allowlist.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  return allowed.has(email.toLowerCase());
}

export async function authenticateRequest(request: Request, env: Env): Promise<JWTPayload & { email: string }> {
  if (env.AUTH_MODE === "disabled") return { email: "local-development" };
  if (env.AUTH_MODE !== "access") throw new Error("AUTH_MODE must be access or disabled");
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error("Cloudflare Access is not configured");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Error("Missing Cloudflare Access JWT");
  const teamDomain = normalizedTeamDomain(env.ACCESS_TEAM_DOMAIN);
  let keySet = keySets.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keySet);
  }
  const { payload } = await jwtVerify(token, keySet, { issuer: teamDomain, audience: env.ACCESS_AUD });
  if (typeof payload.email !== "string" || !payload.email) throw new Error("Cloudflare Access token has no email claim");
  if (!allowedEmail(payload.email, env.ALLOWED_EMAILS)) throw new Error("User is not in the application allowlist");
  return payload as JWTPayload & { email: string };
}
