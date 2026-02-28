"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import AuthShell from "../components/AuthShell.jsx";
import { getApiBase, login } from "../../lib/api.js";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setLoading(true);

    try {
      const out = await login(email.trim(), password);
      if (!out?.ok) throw new Error(out?.error || "Login failed");
      toast.success("Login successful");
      router.push("/paper");
    } catch (e: any) {
      const msg = e?.message || "Login failed";
      setErr(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  const googleStart = `${getApiBase()}/auth/google/start`;

  return (
    <AuthShell title="Welcome back! Glad to see you, Again!" subtitle="Use your email/password or Google account." variant="modern">
      {err ? <div className="alert alertErr">{err}</div> : null}

      <form onSubmit={onSubmit} className="form authModernForm" style={{ marginTop: 12 }}>
        <div className="field">
          <label className="authModernLabel">Email</label>
          <input
            className="input authModernInput"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="Enter your email"
          />
        </div>

        <div className="field">
          <label className="authModernLabel">Password</label>
          <input
            className="input authModernInput"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="Enter your password"
          />
        </div>

        <div className="authInlineRight">
          <Link className="authTinyLink" href="/auth/forgot-password">
            Forgot Password?
          </Link>
        </div>

        <button className="btn authMainBtn" type="submit" disabled={loading}>
          {loading ? "Logging in…" : "Login"}
        </button>
      </form>

      <div className="authOrRow">
        <span>Or Login with</span>
      </div>

      <div className="authProviderRow">
        <a className="btn authProviderBtn" href={googleStart}>
          Google
        </a>
      </div>

      <div className="authBottomText">
        Don&apos;t have an account?{" "}
        <Link href="/auth/register" className="authBottomLink">
          Register Now
        </Link>
      </div>
    </AuthShell>
  );
}
