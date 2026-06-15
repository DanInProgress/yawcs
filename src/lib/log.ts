// Verbose logging for API interactions.
// These are undocumented endpoints — logging everything helps us learn the
// response shapes and catch changes/breakage quickly.

let verbose = true;

/** Enable or disable verbose HTTP request/response logging. */
export function setVerbose(value: boolean): void {
  verbose = value;
}

const REDACT_REQUEST = new Set(["cookie", "authorization", "x-api-key"]);
const REDACT_RESPONSE = new Set(["set-cookie"]);
const BODY_LIMIT = 2048;

/**
 * Format a response/request body for display.
 * - JSON: pretty-printed
 * - Text: raw
 * - Binary/unknown: descriptor only (no content)
 * All output is truncated at BODY_LIMIT chars.
 */
function formatBody(contentType: string | null, rawBody: string | null): string | null {
  if (!rawBody) return null;

  const ct = (contentType ?? "").toLowerCase();
  let text: string;

  if (ct.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(rawBody), null, 2);
    } catch {
      text = rawBody;
    }
  } else if (ct.includes("text/")) {
    text = rawBody;
  } else {
    // Binary or unknown content-type — describe it, don't print contents
    text = `[binary ${ct || "unknown"}, ${rawBody.length} bytes]`;
  }

  if (text.length > BODY_LIMIT) {
    return text.slice(0, BODY_LIMIT) + `\n… [truncated, ${text.length} total chars]`;
  }
  return text;
}

/**
 * Log an outgoing API request.
 * @param method HTTP method
 * @param url Request URL
 * @param headers Request headers as a plain object
 * @param bodyDesc Human-readable description of the body
 */
export function logRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyDesc?: string,
): void {
  if (!verbose) return;
  console.log(`\n→ ${method} ${url}`);
  for (const [key, value] of Object.entries(headers)) {
    const display = REDACT_REQUEST.has(key.toLowerCase()) ? "[redacted]" : value;
    console.log(`  ${key}: ${display}`);
  }
  if (bodyDesc) console.log(`  body: ${bodyDesc}`);
}

/**
 * Log an API response.
 * @param status HTTP status code
 * @param headers Response Headers object
 * @param rawBody Raw response text (null for binary responses)
 */
export function logResponse(status: number, headers: Headers, rawBody: string | null): void {
  if (!verbose) return;
  console.log(`← ${status}`);
  for (const [key, value] of headers.entries()) {
    const display = REDACT_RESPONSE.has(key.toLowerCase()) ? "[redacted]" : value;
    console.log(`  ${key}: ${display}`);
  }
  const ct = headers.get("content-type");
  const body = formatBody(ct, rawBody);
  if (body) console.log(`  body: ${body}`);
}
