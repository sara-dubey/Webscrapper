// app/layout.tsx
import "./globals.css";
import "react-pdf/dist/Page/TextLayer.css";
import ToastProvider from "./toast-provider";

export const metadata = {
  title: "MIRA Research",
  description: "Paper search + summaries + reddit threads",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const bodyStyle = {
    "--react-pdf-text-layer": "1",
    "--react-pdf-annotation-layer": "1",
  } as React.CSSProperties;

  return (
    <html lang="en">
      <body style={bodyStyle}>
        {children}
        <ToastProvider />
      </body>
    </html>
  );
}
