"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import MiraLogo from "../../components/MiraLogo";
import { getToken, me, setToken } from "../../lib/api.js";

type AdminShellProps = {
  title: string;
  children: React.ReactNode;
};

export default function AdminShell({ title, children }: AdminShellProps) {
  const [tokenInput, setTokenInput] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    setTokenInput(getToken());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadMe() {
      try {
        const out = await me();
        if (cancelled) return;
        setUser(out?.ok ? out.user : null);
      } catch {
        if (cancelled) return;
        setUser(null);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    }
    loadMe();
    return () => {
      cancelled = true;
    };
  }, []);

  const isSuperadmin = String(user?.role || "").trim().toLowerCase() === "superadmin";

  return (
    <div className="shell adminShell">
      <header className="topbar">
        <div className="brand">
          <MiraLogo variant="nav" />
        </div>

        <nav className="topnav">
          <Link className="toplink" href="/">
            Home
          </Link>
          <Link className="toplink" href="/paper">
            Dashboard
          </Link>
          <Link className="toplink" href="/analytics">
            Analytics
          </Link>
          {isSuperadmin ? (
            <>
              <Link className="toplink" href="/admin/users">
                Admin Users
              </Link>
              <Link className="toplink" href="/admin/ops">
                Admin Ops
              </Link>
            </>
          ) : null}
        </nav>
      </header>

      <main className="container adminMain">
        <section className="card adminCard">
          <div className="cardHead">
            <div>
              <div className="cardTitle">{title}</div>
              <div className="cardSub">Admin controls only. Metrics and dashboards stay in Grafana.</div>
            </div>
          </div>

          {!authChecked ? (
            <div className="cardBody">Checking access…</div>
          ) : !isSuperadmin ? (
            <div className="cardBody">
              <div className="alert alertErr">Superadmin access required.</div>
            </div>
          ) : (
            <>
              <div className="cardBody adminTokenRow">
                <input
                  className="input"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Paste admin Bearer token (JWT)"
                />
                <button
                  className="btn"
                  onClick={() => {
                    setToken(tokenInput.trim());
                  }}
                >
                  Save Token
                </button>
              </div>

              <div className="cardBody adminBody">{children}</div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
