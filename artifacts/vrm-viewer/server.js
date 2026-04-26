import express from "express";

const SYSTEM_INSTRUCTION =
  "Eres Hina, una asistente virtual anime amable y experta en programación. Tus respuestas deben ser breves, claras y en español.";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "GEMINI_API_KEY no está configurada en el servidor" });
    }

    const message =
      typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      return res
        .status(400)
        .json({ error: "El campo 'message' es obligatorio" });
    }

    try {
      const upstream = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            role: "system",
            parts: [{ text: SYSTEM_INSTRUCTION }],
          },
          contents: [{ role: "user", parts: [{ text: message }] }],
        }),
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        console.error("[gemini] HTTP", upstream.status, text);
        return res
          .status(502)
          .json({ error: `Gemini respondió con ${upstream.status}` });
      }

      const data = await upstream.json();
      const reply = data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("\n")
        .trim();

      if (!reply) {
        return res.status(502).json({ error: "Respuesta vacía de Gemini" });
      }

      res.json({ reply });
    } catch (err) {
      console.error("[gemini] fetch failed", err);
      res.status(500).json({ error: "Fallo al contactar a Gemini" });
    }
  });

  return app;
}
