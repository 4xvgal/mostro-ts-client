// Outbound HTTP guards shared by LNURL-pay and Blossom fetches.
// Untrusted input (counterparty invoices, chat attachments) can name a URL;
// without validation the client becomes an SSRF proxy and a cleartext MITM
// target. These helpers fail closed.

/** Default outbound request timeout. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export interface UrlPolicy {
  /** Allow plaintext http (only sensible for loopback/dev). Default false. */
  allowHttp?: boolean;
  /** Allow loopback/private/link-local targets. Default false. */
  allowPrivate?: boolean;
}

/** True for loopback, RFC1918, link-local, CGNAT and IPv6 local ranges. */
export function isPrivateHost(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase());
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) {
    return false;
  }
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Validate a URL before fetching. Throws on unsupported scheme or blocked host.
 * Returns the parsed URL.
 */
export function assertSafeFetchUrl(raw: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol === "http:") {
    if (!policy.allowHttp && !isPrivateHost(url.hostname)) {
      throw new Error("insecure http URL rejected; use https");
    }
  } else if (url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }
  if (!policy.allowPrivate && isPrivateHost(url.hostname)) {
    throw new Error(`refusing to fetch private/loopback host: ${url.hostname}`);
  }
  return url;
}

/** Fetch with an abort timeout. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
