"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import AuthShell from "../components/AuthShell.jsx";
import { getPasswordRules, resetPassword } from "../../lib/api.js";

type Props = {
  token: string;
};

export default function ResetPasswordForm({ token }: Props) {
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [hints, setHints] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadHints() {
      try {
        const out = await getPasswordRules();
        if (!cancelled && Array.isArray(out?.hints)) {
          setHints(out.hints);
        }
      } catch {
        if (!cancelled) {
          setHints([]);
        }
      }
    }

    loadHints();

    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setInfo("");

    if (!token) {
      setErr("This reset link is missing or invalid. Request a new reset email.");
      toast.error("This reset link is missing or invalid");
      return;
    }

    if (password !== confirmPassword) {
      setErr("Passwords do not match");
      toast.error("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const out = await resetPassword(token, password);
      if (!out?.ok) throw new Error(out?.error || "Reset failed");

      setInfo("Password updated. Redirecting to login…");
      toast.success("Password updated");
      setTimeout(() => router.push("/auth/login"), 800);
    } catch (e: any) {
      const details = Array.isArray(e?.data?.passwordErrors) ? e.data.passwordErrors.join(" ") : "";
      const msg = details ? `${e?.message || "Reset failed"} ${details}` : e?.message || "Reset failed";
      setErr(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Reset Password" subtitle="Set your new password." variant="modern">
      {!token ? <div className="alert alertErr">This link is invalid or expired. Request a new reset email.</div> : null}
      {err ? <div className="alert alertErr">{err}</div> : null}
      {info ? <div className="alert">{info}</div> : null}

      {token ? (
        <form onSubmit={onSubmit} className="form authModernForm" style={{ marginTop: 12 }}>
          <div className="field">
            <label className="authModernLabel">New password</label>
            <input
              className="input authModernInput"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Enter new password"
            />
          </div>

          <div className="field">
            <label className="authModernLabel">Confirm new password</label>
            <input
              className="input authModernInput"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Confirm new password"
            />
          </div>

          {hints.length ? (
            <details className="authRulesDetails">
              <summary>Password rules</summary>
              <ul className="bullets" style={{ marginBottom: 0 }}>
                {hints.map((hint, idx) => (
                  <li key={idx} className="tiny muted">
                    {hint}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <button className="btn authMainBtn" type="submit" disabled={loading}>
            {loading ? "Resetting…" : "Reset password"}
          </button>
        </form>
      ) : (
        <div className="authBottomText" style={{ marginTop: 14 }}>
          <Link href="/auth/forgot-password" className="authBottomLink">
            Go to forgot password
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
