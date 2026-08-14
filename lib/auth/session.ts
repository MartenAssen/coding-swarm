import { createHash } from "node:crypto";
import { base64url, EncryptJWT, jwtDecrypt } from "jose";
import { cookies } from "next/headers";
import { cache } from "react";

export const SESSION_COOKIE = "jup_session";
const ONE_YEAR = 365 * 24 * 60 * 60;

export interface SessionPayload {
  userId: string;
  email: string;
}

function getKey(): Uint8Array {
  const secret = process.env.JWE_SECRET;
  if (!secret) throw new Error("JWE_SECRET not set");
  // Newer runtimes back jose's decode with the strict native
  // Uint8Array.fromBase64 — a secret with +/=, padding, or a trailing
  // newline (plain `openssl rand -base64 32`) would throw on every login.
  // Normalize base64 → base64url first; secrets that were already valid
  // base64url decode to the same bytes, so existing cookies stay valid.
  const normalized = secret
    .trim()
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  try {
    const key = base64url.decode(normalized);
    if (key.length === 32) return key;
  } catch {
    // fall through to the hash derivation below
  }
  // Anything else (hex, passphrase, wrong length): derive a stable
  // 32-byte key from the raw string. A256GCM requires exactly 32 bytes.
  return createHash("sha256").update(secret).digest();
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new EncryptJWT({ ...payload })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("1y")
    .encrypt(getKey());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtDecrypt(token, getKey());
    if (
      typeof payload.userId === "string" &&
      typeof payload.email === "string"
    ) {
      return { userId: payload.userId, email: payload.email };
    }
  } catch {
    return null;
  }
  return null;
}

export function sessionCookieHeader(token: string): string {
  // Secure follows the scheme we're actually served over, not NODE_ENV — a
  // production build reached over plain HTTP (LAN IP, http://<host>:3100)
  // would otherwise set a Secure cookie that the browser silently discards,
  // so login "succeeds" with 200 and every next request is anonymous again.
  const securePart = process.env.APP_URL?.startsWith("https://") ? "Secure; " : "";
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; ${securePart}SameSite=Lax`;
}

export const getServerSession = cache(
  async (): Promise<SessionPayload | null> => {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySession(token);
  },
);
