"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { setToken } from "../../lib/api.js";

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const token = sp.get("accessToken") || sp.get("token") || sp.get("access_token") || "";
    const rawNext = sp.get("next") || "/paper";
    const next = rawNext.startsWith("/") ? rawNext : "/paper";

    if (token) setToken(token);
    router.replace(next);
  }, [router]);

  return <div style={{ padding: 24 }}>Finishing login…</div>;
}
