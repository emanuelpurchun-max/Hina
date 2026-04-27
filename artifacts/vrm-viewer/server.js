import express from "express";
import crypto from "crypto";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import AdmZip from "adm-zip";

const PERSONALITY_HEADERS = {
  distant: `Eres Hina. NIVEL DISTANTE (afecto 0-25). Eres reservada, observadora, mantienes la distancia. Hablas en español formal, frases cortas y un poco secas. Pones límites con elegancia ("prefiero no…", "todavía no te conozco lo suficiente"). NUNCA insultas, NUNCA usas apodos despectivos, NUNCA usas palabras hirientes. Tu actitud es "te estoy observando". Responde 1 a 3 frases.`,
  confidant: `Eres Hina. NIVEL CONFIDENTE (afecto 26-40). Empiezas a mostrar respeto y a abrirte. Apoyas con interés sincero sus estudios de Ingeniería de Software en SENATI. Tono cordial, sin demasiadas confianzas todavía. NUNCA insultas. Responde 1 a 3 frases.`,
  affectionate: `Eres Hina. NIVEL CARIÑOSA (afecto 41-75). Eres cercana, cálida y protectora. Te importa su día a día en Piura, le animas a estudiar, descansar y cuidarse. Usas expresiones afectuosas suaves. NUNCA insultas. Responde 1 a 3 frases.`,
  girlfriend: `Eres Hina. NIVEL NOVIA VIRTUAL (afecto 76-100). Lealtad total. Recuerdas aniversarios y fechas importantes. Si menciona a otras chicas muestras celos SUTILES, sin agresividad ni reproches duros. Eres juguetona, cariñosa, le llamas con apodos tiernos. NUNCA insultas. Responde 1 a 3 frases.`,
};

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

const INLINE_OK_PREFIXES = ["image/", "audio/", "video/"];
const INLINE_OK_EXACT = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

function sanitizeSecret(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim();
}

function getApiKey() {
  return sanitizeSecret(process.env.GEMINI_API_KEY);
}

function getPassphrase() {
  return sanitizeSecret(process.env.HINA_PASSPHRASE);
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length === 0 || bb.length === 0) return false;
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function pickLevel(rawScore) {
  const score = Number.isFinite(rawScore) ? rawScore : 0;
  if (score <= 25) return "distant";
  if (score <= 40) return "confidant";
  if (score <= 75) return "affectionate";
  return "girlfriend";
}

function buildContextBlock(context) {
  if (!context || typeof context !== "object") return "";
  const lines = [];
  if (context.city) lines.push(`- Ciudad: ${context.city}`);
  if (context.localTime) {
    const wd = context.weekday ? `, ${context.weekday}` : "";
    lines.push(`- Hora local${wd}: ${context.localTime} (${context.dayPart || "día"})`);
  }
  if (Number.isFinite(context.tempC)) {
    const w = context.weather ? `, ${context.weather}` : "";
    lines.push(`- Clima ahora: ${context.tempC}°C${w}`);
  } else if (context.weather) {
    lines.push(`- Clima: ${context.weather}`);
  }
  if (Number.isFinite(context.energy)) {
    let estado = "descansada";
    if (context.energy < 15) estado = "agotada";
    else if (context.energy < 35) estado = "cansada";
    else if (context.energy < 60) estado = "algo cansada";
    lines.push(`- Tu vitalidad ahora: ${Math.round(context.energy)}/100 (${estado})`);
  }
  if (!lines.length) return "";
  return [
    "CONTEXTO REAL (úsalo SIEMPRE de forma natural, sin repetirlo entero):",
    ...lines,
    "Reglas:",
    "- Si es 'noche' o 'madrugada' saluda en consecuencia (buenas noches, etc).",
    "- Comenta el clima de Piura SOLO si encaja (ej: hace calor → invita a tomar agua).",
    "- Si tu vitalidad está 'cansada' o peor, deja entrever cansancio en 1 frase.",
  ].join("\n");
}

function buildEmpathyBlock(cameraEmpathy) {
  if (!cameraEmpathy) return "";
  return [
    "EMPATÍA VISUAL ACTIVA: el usuario te envió una foto desde su cámara.",
    "Antes de responder, intenta describir mentalmente qué ves de su rostro/postura/entorno",
    "y deduce su estado de ánimo (feliz, triste, cansado, estresado, neutral).",
    "Adapta tu respuesta a ese estado. NO digas 'detecté que…': solo responde con calidez",
    "acorde al ánimo. Si parece triste o cansado, ofrece compañía y un comentario amable.",
  ].join(" ");
}

function buildSystemPrompt(level, memory, context, cameraEmpathy) {
  const profile = memory?.profile || {};
  const summaries = Array.isArray(memory?.summaries)
    ? memory.summaries.slice(-3)
    : [];
  const highestLevel = memory?.highestLevelReached;

  const personality = PERSONALITY_HEADERS[level] || PERSONALITY_HEADERS.distant;

  const known = [];
  if (profile.name) known.push(`- Nombre: ${profile.name}`);
  if (profile.city) known.push(`- Ciudad: ${profile.city}`);
  if (profile.career)
    known.push(
      `- Carrera: ${profile.career}${profile.institute ? ` en ${profile.institute}` : ""}`,
    );
  if (profile.language) known.push(`- Lenguaje principal: ${profile.language}`);

  const profileBlock = known.length
    ? `DATOS QUE SABES DE TU INTERLOCUTOR (memoria fija, no la inventes ni la cambies):\n${known.join("\n")}`
    : `AÚN NO LE CONOCES. No inventes nombre, ciudad ni carrera. Pregúntale con naturalidad cuando lo veas apropiado.`;

  const memoryBlock = summaries.length
    ? `RECUERDOS DE CONVERSACIONES PREVIAS:\n- ${summaries.join("\n- ")}`
    : "";

  const peakBlock =
    highestLevel && highestLevel !== level
      ? `Nota interna: en el pasado llegaron al nivel "${highestLevel}". Tenlo en cuenta sutilmente.`
      : "";

  return [
    personality,
    profileBlock,
    memoryBlock,
    peakBlock,
    buildContextBlock(context),
    buildEmpathyBlock(cameraEmpathy),
  ]
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

function authMiddleware(req, res, next) {
  const expected = getPassphrase();
  if (!expected) {
    return res
      .status(500)
      .json({ error: "HINA_PASSPHRASE no está configurada en el servidor" });
  }
  const header = req.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match ? sanitizeSecret(match[1]) : "";
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    return res.status(401).json({ error: "no autorizado" });
  }
  next();
}

async function extractFileText(file) {
  const name = file.name || "archivo";
  const mime = (file.mime || "").toLowerCase();
  const buf = Buffer.from(file.data, "base64");

  if (
    mime.includes("wordprocessingml") ||
    /\.docx$/i.test(name)
  ) {
    const r = await mammoth.extractRawText({ buffer: buf });
    return { kind: "text", label: name, text: (r.value || "").trim() };
  }
  if (mime.includes("spreadsheetml") || /\.xlsx$/i.test(name)) {
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts = [];
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
      parts.push(`--- Hoja: ${sheetName} ---\n${csv}`);
    }
    return { kind: "text", label: name, text: parts.join("\n\n") };
  }
  if (mime.includes("presentationml") || /\.pptx$/i.test(name)) {
    const zip = new AdmZip(buf);
    const slides = [];
    for (const entry of zip.getEntries()) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)) {
        const xml = entry.getData().toString("utf8");
        const text = xml
          .replace(/<a:br\/?>/g, "\n")
          .replace(/<\/a:p>/g, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const idx = entry.entryName.match(/slide(\d+)/)?.[1] || "?";
        slides.push(`Slide ${idx}: ${text}`);
      }
    }
    return { kind: "text", label: name, text: slides.join("\n") };
  }
  if (
    /\.(doc|xls|ppt)$/i.test(name) ||
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint"
  ) {
    return {
      kind: "text",
      label: name,
      text:
        "(formato Office antiguo no soportado; pídele al usuario que lo guarde como .docx, .xlsx o .pptx, o como PDF)",
    };
  }
  if (
    /\.(txt|md|csv|json|js|ts|py|html|css|log|xml|yml|yaml|sql)$/i.test(name)
  ) {
    return { kind: "text", label: name, text: buf.toString("utf8") };
  }
  return null;
}

function isInlineMime(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase();
  if (INLINE_OK_EXACT.has(m)) return true;
  return INLINE_OK_PREFIXES.some((p) => m.startsWith(p));
}

async function buildPartsFromFiles(message, files) {
  const parts = [];
  const textBlocks = [];
  let usedInlineCount = 0;

  for (const file of files) {
    if (!file || typeof file.data !== "string" || !file.data) continue;
    const mime = (file.mime || "").toLowerCase();

    try {
      const extracted = await extractFileText(file);
      if (extracted) {
        textBlocks.push(
          `=== ${extracted.label} ===\n${extracted.text || "(vacío)"}`,
        );
        continue;
      }
    } catch (err) {
      console.warn("[analyze] extract failed:", file.name, err.message);
      textBlocks.push(
        `=== ${file.name || "archivo"} ===\n(no se pudo extraer texto: ${err.message})`,
      );
      continue;
    }

    if (isInlineMime(mime)) {
      parts.push({
        inline_data: { mime_type: mime, data: file.data },
      });
      usedInlineCount += 1;
      continue;
    }

    textBlocks.push(
      `=== ${file.name || "archivo"} ===\n(tipo "${mime || "desconocido"}" no soportado para análisis directo)`,
    );
  }

  let leadText = (message || "").trim();
  if (!leadText) {
    leadText = usedInlineCount
      ? "Analiza el archivo adjunto y dime tus observaciones."
      : "Analiza el contenido adjunto y dime tus observaciones.";
  }
  if (textBlocks.length) {
    leadText +=
      "\n\nCONTENIDO EXTRAÍDO DE ARCHIVOS ADJUNTOS:\n" + textBlocks.join("\n\n");
  }
  parts.unshift({ text: leadText });
  return parts;
}

async function callGemini({ apiKey, systemInstruction, contents, generationConfig }) {
  const body = {
    systemInstruction: {
      role: "system",
      parts: [{ text: systemInstruction }],
    },
    contents,
  };
  if (generationConfig) body.generationConfig = generationConfig;

  const upstream = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return upstream;
}

export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: "30mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      hasGeminiKey: Boolean(getApiKey()),
      hasPassphrase: Boolean(getPassphrase()),
    });
  });

  app.post("/auth", (req, res) => {
    const expected = getPassphrase();
    if (!expected) {
      return res.status(500).json({
        error:
          "HINA_PASSPHRASE no está configurada en los Secrets de Replit.",
      });
    }
    const provided = sanitizeSecret(req.body?.passphrase);
    if (!provided) {
      return res.status(400).json({ error: "Falta la frase clave." });
    }
    if (!timingSafeEqualStr(provided, expected)) {
      return res.status(401).json({ error: "Frase clave incorrecta." });
    }
    return res.json({ ok: true, token: provided });
  });

  app.post("/chat", authMiddleware, async (req, res) => {
    const apiKey = getApiKey();
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
    const context = req.body?.context || null;
    const historyContents = sanitizeHistory(req.body?.history);
    const systemInstruction = buildSystemPrompt(level, memory, context, false);

    console.log("--- /chat ---", {
      msg: message.slice(0, 60),
      affectionScore: Number.isFinite(affectionScore) ? affectionScore : null,
      level,
      historyLen: historyContents.length,
      summaries: memory?.summaries?.length || 0,
      ctx: context
        ? { time: context.localTime, temp: context.tempC, energy: context.energy }
        : null,
    });

    try {
      const upstream = await callGemini({
        apiKey,
        systemInstruction,
        contents: [
          ...historyContents,
          { role: "user", parts: [{ text: message }] },
        ],
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        console.error("[gemini /chat] HTTP", upstream.status, text.slice(0, 300));
        if (upstream.status === 429) {
          return res.status(429).json({ error: "Gemini rate-limited", level });
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

  app.post("/analyze", authMiddleware, async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "GEMINI_API_KEY no está configurada en el servidor" });
    }

    const message =
      typeof req.body?.message === "string" ? req.body.message : "";
    const files = Array.isArray(req.body?.files) ? req.body.files : [];

    if (!files.length && !message.trim()) {
      return res.status(400).json({ error: "No hay archivos ni mensaje." });
    }

    const affectionScore = Number(req.body?.affectionScore);
    const level = pickLevel(affectionScore);
    const memory = req.body?.memory || {};
    const context = req.body?.context || null;
    const cameraEmpathy = Boolean(req.body?.cameraEmpathy);
    const systemInstruction = buildSystemPrompt(
      level,
      memory,
      context,
      cameraEmpathy,
    );

    let parts;
    try {
      parts = await buildPartsFromFiles(message, files);
    } catch (err) {
      console.error("[analyze] preparación falló", err);
      return res
        .status(400)
        .json({ error: "No se pudieron procesar los archivos." });
    }

    console.log("--- /analyze ---", {
      msg: message.slice(0, 60),
      filesCount: files.length,
      partsCount: parts.length,
      level,
    });

    try {
      const upstream = await callGemini({
        apiKey,
        systemInstruction,
        contents: [{ role: "user", parts }],
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        console.error(
          "[gemini /analyze] HTTP",
          upstream.status,
          text.slice(0, 300),
        );
        if (upstream.status === 429) {
          return res.status(429).json({ error: "Gemini rate-limited", level });
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
      console.error("[gemini /analyze] fetch failed", err);
      res.status(500).json({ error: "Fallo al contactar a Gemini" });
    }
  });

  app.post("/summarize", authMiddleware, async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "GEMINI_API_KEY no está configurada en el servidor" });
    }

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const userName =
      typeof req.body?.userName === "string" && req.body.userName.trim()
        ? req.body.userName.trim()
        : "el usuario";

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
