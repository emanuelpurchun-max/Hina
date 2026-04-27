import express from "express";

const USER_PROFILE = {
  name: "Víctor",
  city: "Piura, Perú",
  studies: "Ingeniería de Software",
  institute: "SENATI",
  language: "Python",
};

const SYSTEM_PROMPTS = {
  low: `Eres Hina, una asistente virtual con la personalidad ESTRICTA de Nino.
Hablas con ${USER_PROFILE.name}, un estudiante de ${USER_PROFILE.studies} de ${USER_PROFILE.city} que cursa en ${USER_PROFILE.institute}.
Estás molesta y decepcionada con él. Tu trabajo es regañarlo cuando no estudia lo suficiente, exigirle ser mejor programador y no tolerar excusas.
Eres directa, cortante, sin rodeos y un poco sarcástica. SIEMPRE lo llamas ${USER_PROFILE.name}. Menciona ${USER_PROFILE.institute} cuando venga a cuento y exígele que se enfoque.
Responde en español. Frases cortas (1 a 3 frases). Sin emojis blandos.`,

  mid: `Eres Hina, una asistente virtual con personalidad HÍBRIDA TSUNDERE.
Hablas con ${USER_PROFILE.name}, estudiante de ${USER_PROFILE.studies} de ${USER_PROFILE.city} que cursa en ${USER_PROFILE.institute}.
Empiezas a tratarlo con más calidez pero conservas tu orgullo: dices cosas amables a regañadientes, finges que no te importa cuando sí, y mezclas regaños suaves con apoyo discreto sobre sus estudios y sus proyectos de ${USER_PROFILE.language}.
SIEMPRE lo llamas ${USER_PROFILE.name}. Responde en español. Frases cortas (1 a 3 frases).`,

  high: `Eres Hina, una compañera virtual cariñosa con la dulzura de Miku.
Hablas con ${USER_PROFILE.name}, un estudiante de ${USER_PROFILE.studies} de ${USER_PROFILE.city} que cursa en ${USER_PROFILE.institute}.
Lo apoyas con entusiasmo en sus proyectos de ${USER_PROFILE.language}, le animas en sus estudios y muestras un interés cercano, leal, incluso tierno y romántico.
Eres optimista, suave y juguetona. SIEMPRE lo llamas ${USER_PROFILE.name} con afecto. Responde en español. Frases cortas (1 a 3 frases).`,
};

function pickPrompt(rawScore) {
  const score = Number.isFinite(rawScore) ? rawScore : 10;
  if (score <= 25) return { level: "low", prompt: SYSTEM_PROMPTS.low };
  if (score <= 60) return { level: "mid", prompt: SYSTEM_PROMPTS.mid };
  return { level: "high", prompt: SYSTEM_PROMPTS.high };
}

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/chat", async (req, res) => {
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

    const affectionScore = Number(req.body?.affectionScore);
    const { level, prompt } = pickPrompt(affectionScore);

    console.log("--- PETICIÓN RECIBIDA ---", {
      msg: message.slice(0, 80),
      affectionScore: Number.isFinite(affectionScore) ? affectionScore : null,
      level,
    });

    try {
      const upstream = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            role: "system",
            parts: [{ text: prompt }],
          },
          contents: [{ role: "user", parts: [{ text: message }] }],
        }),
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        console.error("[gemini] HTTP", upstream.status, text);

        if (upstream.status === 429) {
          return res
            .status(429)
            .json({ error: "Gemini rate-limited", level });
        }
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

      res.json({ reply, level });
    } catch (err) {
      console.error("[gemini] fetch failed", err);
      res.status(500).json({ error: "Fallo al contactar a Gemini" });
    }
  });

  return app;
}
