"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import AuthShell from "../components/AuthShell.jsx";
import { getApiBase, getPasswordRules, register, sendRegisterVerificationCode } from "../../lib/api.js";

export default function RegisterPage() {
  const router = useRouter();
  const googleStart = `${getApiBase()}/auth/google/start`;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [hints, setHints] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

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

  async function onSendCode() {
    setErr("");
    setInfo("");

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setErr("Enter your email first");
      toast.error("Enter your email first");
      return;
    }

    setSendingCode(true);
    try {
      const out = await sendRegisterVerificationCode(normalizedEmail);
      if (!out?.ok) throw new Error(out?.error || "Could not send verification code");
      setInfo("Verification code sent. Check your email inbox.");
      toast.success("Verification code sent");
    } catch (e: any) {
      const msg = e?.message || "Could not send verification code";
      setErr(msg);
      toast.error(msg);
    } finally {
      setSendingCode(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setInfo("");

    if (!name.trim()) {
      setErr("Name is required");
      toast.error("Name is required");
      return;
    }

    if (!verificationCode.trim()) {
      setErr("Enter the verification code sent to your email");
      toast.error("Enter the verification code sent to your email");
      return;
    }

    if (password !== confirmPassword) {
      setErr("Passwords do not match");
      toast.error("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      const out = await register(email.trim(), password, verificationCode.trim(), name.trim());
      if (!out?.ok) throw new Error(out?.error || "Account creation failed");
      toast.success("Account created");
      router.push("/paper");
    } catch (e: any) {
      const details = Array.isArray(e?.data?.passwordErrors) ? e.data.passwordErrors.join(" ") : "";
      const msg = details ? `${e?.message || "Account creation failed"} ${details}` : e?.message || "Account creation failed";
      setErr(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Hello! Register to get started" subtitle="Register with email/password and verify your email code." variant="modern">
      {err ? <div className="alert alertErr">{err}</div> : null}
      {info ? <div className="alert">{info}</div> : null}

      <form onSubmit={onSubmit} className="form authModernForm" style={{ marginTop: 12 }}>
        <div className="field">
          <label className="authModernLabel">Name</label>
          <input
            className="input authModernInput"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="Username"
            required
          />
        </div>

        <div className="field">
          <label className="authModernLabel">Email</label>
          <input
            className="input authModernInput"
            name="register_email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            placeholder="Email"
          />
        </div>

        <div className="oauthRow authCodeRow">
          <button className="btn btnGhost authCodeBtn" type="button" onClick={onSendCode} disabled={sendingCode}>
            {sendingCode ? "Sending code…" : "Send verification code"}
          </button>
        </div>

        <div className="field">
          <label className="authModernLabel">Verification code</label>
          <input
            className="input authModernInput"
            value={verificationCode}
            onChange={(e) => setVerificationCode(e.target.value)}
            autoComplete="one-time-code"
            placeholder="6-digit code"
          />
        </div>

        <div className="field">
          <label className="authModernLabel">Password</label>
          <input
            className="input authModernInput"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="Password"
          />
        </div>

        <div className="field">
          <label className="authModernLabel">Confirm password</label>
          <input
            className="input authModernInput"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="Confirm password"
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
          {loading ? "Creating…" : "Create account"}
        </button>
      </form>

      <div className="authOrRow">
        <span>Or Register with</span>
      </div>

      <div className="authProviderRow">
        <a className="btn authProviderBtn" href={googleStart}>
          Google
        </a>
      </div>

      <div className="authBottomText">
        Already have an account?{" "}
        <Link href="/auth/login" className="authBottomLink">
          Login Now
        </Link>
      </div>
    </AuthShell>
  );
}
