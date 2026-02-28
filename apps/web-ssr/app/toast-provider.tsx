"use client";

import { Toaster } from "react-hot-toast";

export default function ToastProvider() {
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 2800,
        style: {
          border: "1px solid rgba(15, 27, 45, 0.12)",
          borderRadius: "12px",
          background: "#ffffff",
          color: "#0f1b2d",
          boxShadow: "0 8px 24px rgba(15, 27, 45, 0.15)",
          fontSize: "0.875rem",
          fontWeight: 600,
        },
        success: {
          iconTheme: {
            primary: "#22c55e",
            secondary: "#ffffff",
          },
        },
        error: {
          iconTheme: {
            primary: "#b91c1c",
            secondary: "#ffffff",
          },
        },
      }}
    />
  );
}
