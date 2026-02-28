import crypto from "crypto";

export function sha1(s = "") {
  return crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
}
