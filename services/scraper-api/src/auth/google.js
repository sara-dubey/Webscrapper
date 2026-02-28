import { OAuth2Client } from "google-auth-library";

const LOCAL_CALLBACK_PATHS = ["/auth/google/callback", "/auth/callback"];

function normalizeRedirectUri(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return null;
    const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

function addIfValid(set, uri) {
  const normalized = normalizeRedirectUri(uri);
  if (normalized) set.add(normalized);
}

function requestProtocol(req) {
  const forwarded = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  if (forwarded) return forwarded;
  if (req?.protocol) return req.protocol;
  return "http";
}

function requestHost(req) {
  return String(req?.get?.("host") || "")
    .split(",")[0]
    .trim();
}

export function getGoogleRedirectCandidates(req) {
  const out = new Set();

  addIfValid(out, process.env.GOOGLE_REDIRECT_URI);

  const extra = String(process.env.GOOGLE_REDIRECT_URIS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const uri of extra) addIfValid(out, uri);

  const proto = requestProtocol(req);
  const hostHeader = requestHost(req);
  const hostOnly = hostHeader.replace(/:\d+$/, "");
  const localHosts = new Set([hostOnly, "localhost", "127.0.0.1"]);

  for (const host of localHosts) {
    if (!host) continue;
    for (const path of LOCAL_CALLBACK_PATHS) {
      addIfValid(out, `${proto}://${host}:3001${path}`);
    }
  }

  return Array.from(out);
}

export function pickGoogleRedirectUri(req) {
  const candidates = getGoogleRedirectCandidates(req);
  if (!candidates.length) return null;

  const hostHeader = requestHost(req);
  if (hostHeader) {
    const preferred = candidates.find((u) => {
      try {
        return new URL(u).host === hostHeader && new URL(u).pathname === "/auth/google/callback";
      } catch {
        return false;
      }
    });
    if (preferred) return preferred;

    const sameHost = candidates.find((u) => {
      try {
        return new URL(u).host === hostHeader;
      } catch {
        return false;
      }
    });
    if (sameHost) return sameHost;
  }

  const configured = normalizeRedirectUri(process.env.GOOGLE_REDIRECT_URI);
  if (configured && candidates.includes(configured)) return configured;

  return candidates[0];
}

export function isAllowedGoogleRedirectUri(uri, req) {
  const normalized = normalizeRedirectUri(uri);
  if (!normalized) return false;
  return getGoogleRedirectCandidates(req).includes(normalized);
}

export function makeGoogleClient(redirectUri = null) {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri || process.env.GOOGLE_REDIRECT_URI || undefined
  );
}
