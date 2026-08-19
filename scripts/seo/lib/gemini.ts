/**
 * Shared Gemini caller used by every auto-push agent. Rotates across
 * comma-separated GEMINI_API_KEYS on a 429 so one exhausted key doesn't
 * stop the run; returns "" (never throws) so callers can treat "no draft"
 * as a normal, held-back outcome rather than a crash.
 */
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

export async function callGemini(prompt: string, jsonMode = false): Promise<string> {
  const keys = (process.env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return "";

  for (let i = 0; i < keys.length; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${keys[i]}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            ...(jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        }),
      }
    );

    if (res.status === 429) {
      console.warn(`  Key ${i + 1}/${keys.length} hit quota, trying next...`);
      continue;
    }

    if (!res.ok) {
      console.error(`  Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return "";
    }

    const data = (await res.json()) as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error(`  Gemini returned no text: ${JSON.stringify(data).slice(0, 300)}`);
      return "";
    }
    return text;
  }

  console.error("  All Gemini keys hit quota.");
  return "";
}
