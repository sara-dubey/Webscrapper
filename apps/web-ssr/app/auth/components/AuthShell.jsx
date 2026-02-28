"use client";

import React from "react";
import Link from "next/link";
import MiraLogo from "../../components/MiraLogo";

export default function AuthShell({ title, subtitle, children, variant = "default" }) {
  const modern = variant === "modern";
  const showFooter = modern;

  return (
    <div className={`shell homeShell ${modern ? "authModernShell" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <MiraLogo variant="nav" />
        </div>

        <nav className="topnav">
          <Link className="toplink" href="/">
            Home
          </Link>
          <Link className="toplink" href="/auth/login">
            Login
          </Link>
          <Link className="toplink" href="/auth/register">
            Create User
          </Link>
        </nav>
      </header>

      <main className={`container homeMain ${modern ? "authModernMain" : ""}`} style={{ maxWidth: modern ? 560 : 640 }}>
        <div className={`card ${modern ? "authModernCard" : ""}`}>
          <div className={`cardHead ${modern ? "authModernHead" : ""}`}>
            <div>
              <div className={`cardTitle ${modern ? "authModernTitle" : ""}`}>{title}</div>
              {subtitle ? <div className={`cardSub ${modern ? "authModernSub" : ""}`}>{subtitle}</div> : null}
            </div>
          </div>

          <div className={`cardBody ${modern ? "authModernBody" : ""}`}>
            {children}
          </div>
        </div>
      </main>

      {showFooter ? (
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
      ) : null}
    </div>
  );
}
