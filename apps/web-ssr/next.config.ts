import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // optional: removes the “Cross origin request detected … allowedDevOrigins” warning
  allowedDevOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
};

export default nextConfig;
