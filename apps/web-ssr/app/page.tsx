/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { clearToken, me } from "./lib/api.js";
import MiraLogo from "./components/MiraLogo";

export default function Home() {
  const [user, setUser] = useState<any>(null);
  const [authChecked, setAuthChecked] = useState(false);

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

  const firstName = useMemo(() => {
    const fromName = String(user?.name || "").trim();
    if (fromName) return fromName.split(/\s+/)[0];

    const email = String(user?.email || "").trim();
    if (!email) return "User";

    const base = email.split("@")[0] || "";
    const clean = base.replace(/[._-]+/g, " ").trim();
    const token = clean.split(/\s+/)[0] || "User";
    return token.charAt(0).toUpperCase() + token.slice(1);
  }, [user?.name, user?.email]);
  const isSuperadmin = String(user?.role || "").trim().toLowerCase() === "superadmin";

  function logout() {
    clearToken();
    setUser(null);
  }

  return (
    <div className="shell homeShell">
      <header className="topbar">
        <div className="brand">
          <MiraLogo variant="nav" />
        </div>

        <nav className="topnav">
          <Link className="toplink active" href="/">
            Home
          </Link>
          {user ? (
            <>
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
              <button className="toplink btnLink" onClick={logout}>
                Logout
              </button>
            </>
          ) : (
            <>
              <Link className="toplink" href="/auth/login">
                Login
              </Link>
              <Link className="toplink" href="/auth/register">
                Create User
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="container homeMain authModernMain">
        <section className="card authModernCard homeLandingCard">
          <div className="cardBody authModernBody homeLandingBody">
            <MiraLogo variant="hero" className="homeLandingLogoMark" />
            <p className="homeLandingTagline">Research cockpit for paper search.</p>
            <div className="homeLandingDivider" />

            <div className="publicCtaTitle">{user ? `Continue your paper reading, ${firstName}` : "Welcome"}</div>
            <p className="publicCtaText">
              {user ? "Pick up your latest papers and insights from the dashboard." : "Login to continue with paper analysis and your saved research sessions."}
            </p>
            {authChecked && user ? <p className="publicCtaUserInfo">Logged in as {user?.email}</p> : null}
            <div className="publicCtaActions homeLandingActions">
              {user ? (
                <>
                  <Link className="btn authMainBtn" href="/paper">
                    Dashboard -&gt;
                  </Link>
                  <Link className="btn authProviderBtn" href="/analytics">
                    Analytics -&gt;
                  </Link>
                </>
              ) : (
                <>
                  <Link className="btn authMainBtn" href="/auth/login">
                    Login
                  </Link>
                  <Link className="btn authProviderBtn" href="/auth/register">
                    Create User
                  </Link>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="homeFooterBar">
        <div className="homeFooterInner">
          <div className="homeFooterText">© Sara Dubey 2026</div>
          <div className="homeFooterLinks" aria-label="Contact">
            <a className="homeFooterLink" href="https://github.com/sara-dubey" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a className="homeFooterLink" href="https://www.linkedin.com/in/sara-dubey" target="_blank" rel="noreferrer">
              LinkedIn
            </a>
            <a className="homeFooterLink" href="mailto:saradubey98@gmail.com">
              saradubey98@gmail.com
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
