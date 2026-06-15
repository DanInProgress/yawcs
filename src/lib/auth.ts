import { load } from "@std/dotenv";
await load({ export: true });

/**
 * Build the Cookie header string from environment variables.
 * Exits with an error message if CLAUDE_SESSION_KEY is not set.
 */
export function getCookieHeader(): string {
  const sessionKey = Deno.env.get("CLAUDE_SESSION_KEY");
  if (!sessionKey) {
    console.error(
      "Error: CLAUDE_SESSION_KEY is not set.\n" +
        "Copy .env.example to .env and populate it with your session cookie from:\n" +
        "  Browser DevTools → Application → Cookies → claude.ai → sessionKey",
    );
    Deno.exit(1);
  }

  const parts = [`sessionKey=${sessionKey}`];
  if (Deno.env.get("CF_CLEARANCE")) parts.push(`cf_clearance=${Deno.env.get("CF_CLEARANCE")}`);
  if (Deno.env.get("CF_BM")) parts.push(`__cf_bm=${Deno.env.get("CF_BM")}`);

  return parts.join("; ");
}

/**
 * Base headers for all claude.ai API requests.
 * For multipart uploads, callers must delete the 'content-type' key so that
 * native fetch can set it with the correct multipart boundary.
 */
export function getBaseHeaders(): Record<string, string> {
  const userAgent = Deno.env.get("USER_AGENT");
  if (!userAgent) {
    console.warn(
      "WARN: USER_AGENT is not set in .env. Cloudflare ties cf_clearance to the browser UA.\n" +
        "      Copy your User-Agent from DevTools > Network > any request > Request Headers.",
    );
  }

  return {
    Cookie: getCookieHeader(),
    "anthropic-client-platform": "web_claude_ai",
    accept: "*/*",
    "content-type": "application/json",
    Origin: "https://claude.ai",
    Referer: "https://claude.ai/",
    ...(userAgent && { "User-Agent": userAgent }),
  };
}
