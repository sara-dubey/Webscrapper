import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);

function toSafeUrl(raw: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  return parsed;
}

export async function GET(req: NextRequest) {
  const raw = String(req.nextUrl.searchParams.get("url") || "").trim();
  if (!raw) {
    return new Response(JSON.stringify({ ok: false, error: "Missing url query param." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const safeUrl = toSafeUrl(raw);
  if (!safeUrl) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid or unsupported PDF URL." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const upstream = await fetch(safeUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 PAPER-AI/1.0",
        Accept: "application/pdf,*/*",
      },
      cache: "no-store",
    });

    if (!upstream.ok) {
      return new Response(JSON.stringify({ ok: false, error: `Upstream failed (${upstream.status}).` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const type = upstream.headers.get("content-type") || "application/pdf";
    if (!type.toLowerCase().includes("pdf")) {
      return new Response(JSON.stringify({ ok: false, error: "Upstream did not return a PDF." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=600",
        "X-Source-Url": safeUrl.toString(),
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "Failed to fetch PDF." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
