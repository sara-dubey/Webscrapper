// src/auth/jwt.js
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || "dev_secret_change_me";
const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_TTL || process.env.ACCESS_TOKEN_TTL || "7d";

export function signAccess(userOrId) {
  const userId =
    typeof userOrId === "string"
      ? userOrId
      : userOrId?.userId || userOrId?.id || null;

  if (!userId) {
    throw new Error("Cannot sign access token without userId");
  }

  return jwt.sign({ userId }, SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}

export function verifyAccess(token) {
  // throws if invalid/expired
  return jwt.verify(token, SECRET);
}
