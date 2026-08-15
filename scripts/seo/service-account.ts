// Tolerant parser for the GOOGLE_SERVICE_ACCOUNT secret.
// Accepts raw JSON, base64-encoded JSON, a value carrying a UTF-8 BOM, and a
// value whose double quotes were stripped in transit by a shell.
export function parseServiceAccount(raw: string): Record<string, any> {
  let s = (raw || "").trim().replace(/^﻿/, "");

  if (!s) throw new Error("GOOGLE_SERVICE_ACCOUNT is empty");

  if (!s.startsWith("{")) {
    s = Buffer.from(s, "base64").toString("utf-8").trim();
  }

  try {
    return JSON.parse(s);
  } catch {
    // Quotes stripped: {type:service_account,private_key:-----BEGIN ...}
    const repaired = s
      .replace(/([{,])\s*([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/:\s*([^",{}\[\]]+?)\s*([,}])/g, (_m, v, end) => `:${JSON.stringify(v)}${end}`);
    return JSON.parse(repaired);
  }
}
