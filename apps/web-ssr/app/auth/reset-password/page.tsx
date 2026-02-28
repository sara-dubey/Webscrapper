"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import ResetPasswordForm from "./ResetPasswordForm";

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = String(searchParams.get("token") || "").trim();
  return <ResetPasswordForm token={token} />;
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<ResetPasswordForm token="" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
