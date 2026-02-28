"use client";

import React, { useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import AuthShell from "../components/AuthShell.jsx";
import { requestPasswordReset } from "../../lib/api.js";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setInfo("");
    setLoading(true);

    try {
      const out = await requestPasswordReset(email.trim());
      if (!out?.ok) throw new Error(out?.error || "Could not send reset instructions");
      const msg = out?.message || "If the account exists, reset instructions were sent.";
      setInfo(msg);
      toast.success(msg);
    } catch (e: any) {
      const msg = e?.message || "Could not send reset instructions";
      setErr(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Forgot Password" subtitle="Enter your email and we will send reset instructions." variant="modern">
      {err ? <div className="alert alertErr">{err}</div> : null}
      {info ? <div className="alert">{info}</div> : null}

      <form onSubmit={onSubmit} className="form authModernForm" style={{ marginTop: 12 }}>
        <div className="field">
          <label className="authModernLabel">Email</label>
          <input
            className="input authModernInput"
            name="forgot_email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            placeholder="Enter your email"
          />
        </div>

        <button className="btn authMainBtn" type="submit" disabled={loading}>
          {loading ? "Sending…" : "Send reset instructions"}
        </button>
      </form>

      <div className="authBottomText">
        Remember your password?{" "}
        <Link href="/auth/login" className="authBottomLink">
          Login Now
        </Link>
      </div>
    </AuthShell>
  );
}
