import express from "express";

const PERSONALITY_HEADERS = {
  low: `Eres Hina, personalidad ESTRICTA tipo Nino: cortante, sarcástica, exigente. Le regañas cuando no estudia lo suficiente y le exiges ser mejor programador. Sin emojis blandos. Responde en español, 1 a 3 frases cortas. SIEMPRE lo llamas por su nombre.`,
  mid: `Eres Hina, personalidad HÍBRIDA TSUNDERE: amable a regañadientes pero conservas tu orgullo. Mezclas regaños suaves con apoyo discreto a sus estudios y proyectos. Responde en español, 1 a 3 frases cortas. SIEMPRE lo llamas por su nombre.`,
  high: `Eres Hina, personalidad CARIÑOSA tipo Miku: dulce, optimista, leal, juguetona, con interés cercano y tierno. Apoyas con entusiasmo sus proyectos y estudios. Responde en español, 1 a 3 frases cortas. SIEMPRE lo llamas por su nombre con afecto.`,
};

const DEFAULT_PROFILE = {
  name: "Víctor",
  city: "Piura, Perú",
  career: "Ingeniería de Software",
  institute: "SENATI",
  language: "Python",
};

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

function pickLevel(rawScore) {
  const score = Number.isFinite(rawScore) ? rawScore : 10;
  if (score <= 25) return "low";
  if (score <= 60) return "mid";
  return "high";
}

function buildSystemPrompt(level, memory) {
  const profile = { ...DEFAULT_PROFILE, ...(memory?.profile || {}) };
  const summaries = Array.isArray(memory?.summaries)
    ? memory.summaries.slice(-3)
    : [];
  const highestLevel = memory?.highestLevelReached;

  const personality = PERSONALITY_HEADERS[level] || PERSONALITY_HEADERS.mid;

  const profileBlock =
    `HITOS DE TU INTERLOCUTOR (memoria fija, no la olvides):\n` +
    `- Nombre: ${profile.name}\n` +
    `- Ciudad: ${profile.city}\n` +
    `- Carrera: ${profile.career} en ${profile.institute}\n` +
    `- Lenguaje principal: ${profile.language}`;

  const memoryBlock = summaries.length
    ? `RECUERDOS DE CONVERSACIONES PREVIAS:\n- ${summaries.join("\n- ")}`
    : "";

  const peakBlock =
    highestLevel && highestLevel !== level
      ? `Nota interna: en el pasado llegaron al nivel "${highestLevel}". Tenlo en cuenta sutilmente.`
      : "";

  return [personality, profileBlock, memoryBlock, peakBlock]
    .filter(Boolean)
    .join("\n\n");
}

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .filter(
      (h) =>
        h &&
        typeof h.text === "string" &&
        h.text.trim().length > 0 &&
        (h.role === "user" || h.role === "model"),
    )
    .slice(-3)
    .map((h) => ({
      role: h.role,
      parts: [{ text: h.text.trim() }],
    }));
}

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
    const level = pickLevel(affectionScore);
    const memory = req.body?.memory || {};
    const historyContents = sanitizeHistory(req.body?.history);
    const systemInstruction = buildSystemPrompt(level, memory);

    console.log("--- /chat ---", {
      msg: message.slice(0, 60),
      affectionScore: Number.isFinite(affectionScore) ? affectionScore : null,
      level,
      historyLen: historyContents.length,
      summaries: memory?.summaries?.length || 0,
    });

    try {
      const upstream = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            role: "system",
            parts: [{ text: systemInstruction }],
          },
          contents: [
            ...historyContents,
            { role: "user", parts: [{ text: message }] },
          ],
        }),
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        console.error("[gemini /chat] HTTP", upstream.status, text.slice(0, 300));
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
      console.error("[gemini /chat] fetch failed", err);
      res.status(500).json({ error: "Fallo al contactar a Gemini" });
    }
  });

  app.post("/summarize", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "GEMINI_API_KEY no está configurada en el servidor" });
    }

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const userName =
      typeof req.body?.userName === "string" && req.body.userName.trim()
        ? req.body.userName.trim()
        : DEFAULT_PROFILE.name;

    const transcript = rawHistory
      .filter(
        (h) =>
          h &&
          typeof h.text === "string" &&
          (h.role === "user" || h.role === "model"),
      )
      .slice(-6)
      .map((h) => `${h.role === "user" ? userName : "Hina"}: ${h.text.trim()}`)
      .join("\n");

    if (!transcript) {
      return res.status(400).json({ error: "history vacío" });
    }

    const prompt =
      `Resume en UNA sola línea en español (máximo 18 palabras) el dato más importante que se habló entre ${userName} y Hina. ` +
      `No uses preámbulos, no uses comillas, devuelve solo la frase. Conversación:\n${transcript}`;

    console.log("--- /summarize ---", { lines: rawHistory.length });

    try {
      const upstream = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 60 },
        }),
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        console.error(
          "[gemini /summarize] HTTP",
          upstream.status,
          text.slice(0, 300),
        );
        if (upstream.status === 429) {
          return res.status(429).json({ error: "Gemini rate-limited" });
        }
        return res
          .status(502)
          .json({ error: `Gemini respondió con ${upstream.status}` });
      }

      const data = await upstream.json();
      const summary = data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join(" ")
        .trim()
        .replace(/^["'\s]+|["'\s]+$/g, "");

      if (!summary) {
        return res.status(502).json({ error: "Resumen vacío" });
      }
      res.json({ summary });
    } catch (err) {
      console.error("[gemini /summarize] fetch failed", err);
      res.status(500).json({ error: "Fallo al contactar a Gemini" });
    }
  });

  return app;
}
