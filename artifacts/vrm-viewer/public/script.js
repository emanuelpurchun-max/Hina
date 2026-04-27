import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const CHAT_ENDPOINT = "/chat";

const AFFECT_STORAGE_KEY = "hina.affection.v1";
const AFFECT_MIN = 0;
const AFFECT_MAX = 100;
const AFFECT_KIND_DELTA = 2;
const AFFECT_INSULT_DELTA = -3;
const AFFECT_DECAY_PER_MINUTE = 0.1;
const AFFECT_DECAY_GRACE_MIN = 5;

const KIND_WORDS = [
  "gracias", "por favor", "te quiero", "te amo", "amor", "cariño", "carino",
  "linda", "bonita", "hermosa", "preciosa", "encantadora", "guapa",
  "eres genial", "increíble", "increible", "fantástica", "fantastica",
  "perfecta", "buena chica", "querida", "mejor", "amiga", "te adoro",
  "feliz", "buenos días", "buenos dias", "buenas noches",
];

const INSULT_WORDS = [
  "tonta", "estupida", "estúpida", "idiota", "imbecil", "imbécil",
  "fea", "inútil", "inutil", "mierda", "puta", "callate", "cállate",
  "odio", "te odio", "basura", "mala", "fastidias", "jodete", "jódete",
  "muerete", "muérete", "asco",
];

let affectionScore = 10;
let affectionLastInteractionAt = Date.now();

function clampAffection(n) {
  if (!Number.isFinite(n)) return 10;
  return Math.max(AFFECT_MIN, Math.min(AFFECT_MAX, Math.round(n * 100) / 100));
}

function loadAffection() {
  try {
    const raw = localStorage.getItem(AFFECT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed?.score)) {
      affectionScore = clampAffection(parsed.score);
    }
    if (Number.isFinite(parsed?.lastInteractionAt)) {
      affectionLastInteractionAt = parsed.lastInteractionAt;
    }
  } catch (err) {
    console.warn("[affect] no se pudo leer almacenamiento:", err);
  }
}

function persistAffection() {
  try {
    localStorage.setItem(
      AFFECT_STORAGE_KEY,
      JSON.stringify({
        score: affectionScore,
        lastInteractionAt: affectionLastInteractionAt,
      }),
    );
  } catch (err) {
    console.warn("[affect] no se pudo guardar:", err);
  }
}

function applyInactivityDecay() {
  const now = Date.now();
  const minutesIdle = (now - affectionLastInteractionAt) / 60000;
  if (minutesIdle <= AFFECT_DECAY_GRACE_MIN) return;

  const decay = (minutesIdle - AFFECT_DECAY_GRACE_MIN) * AFFECT_DECAY_PER_MINUTE;
  if (decay <= 0) return;

  const before = affectionScore;
  affectionScore = clampAffection(affectionScore - decay);
  console.log(
    `[affect] decay -${decay.toFixed(2)} tras ${minutesIdle.toFixed(1)} min inactivo (${before} → ${affectionScore})`,
  );
}

function evaluateSentiment(text) {
  const t = (text || "").toLowerCase();
  let delta = 0;
  let kindHit = null;
  let insultHit = null;
  for (const w of KIND_WORDS) {
    if (t.includes(w)) { kindHit = w; delta += AFFECT_KIND_DELTA; break; }
  }
  for (const w of INSULT_WORDS) {
    if (t.includes(w)) { insultHit = w; delta += AFFECT_INSULT_DELTA; break; }
  }
  return { delta, kindHit, insultHit };
}

function updateAffection(userText) {
  applyInactivityDecay();
  const { delta, kindHit, insultHit } = evaluateSentiment(userText);
  if (delta !== 0) {
    const before = affectionScore;
    affectionScore = clampAffection(affectionScore + delta);
    console.log(
      `[affect] ${delta > 0 ? "+" : ""}${delta} (${kindHit || ""}${insultHit ? " / " + insultHit : ""}) → ${before} → ${affectionScore}`,
    );
  }
  affectionLastInteractionAt = Date.now();
  persistAffection();
  updateMemoryAffectionPeak();
}

function affectionLevel(score = affectionScore) {
  if (score <= 25) return "low";
  if (score <= 60) return "mid";
  return "high";
}

loadAffection();
applyInactivityDecay();
console.log(
  `[affect] inicio: score=${affectionScore} nivel=${affectionLevel()}`,
);

const MEMORY_STORAGE_KEY = "hina.memory.v1";
const MEMORY_MAX_SUMMARIES = 10;
const HISTORY_WINDOW = 3;
const SUMMARY_EVERY_N_USER_MSGS = 10;

const DEFAULT_MEMORY = {
  profile: {
    name: "Víctor",
    city: "Piura, Perú",
    career: "Ingeniería de Software",
    institute: "SENATI",
    language: "Python",
  },
  highestAffectionReached: 10,
  highestLevelReached: "low",
  summaries: [],
  totalUserMessages: 0,
};

let memory = structuredClone(DEFAULT_MEMORY);

function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    memory = {
      ...DEFAULT_MEMORY,
      ...parsed,
      profile: { ...DEFAULT_MEMORY.profile, ...(parsed?.profile || {}) },
      summaries: Array.isArray(parsed?.summaries) ? parsed.summaries : [],
    };
  } catch (err) {
    console.warn("[memory] no se pudo leer:", err);
  }
}

function persistMemory() {
  try {
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(memory));
  } catch (err) {
    console.warn("[memory] no se pudo guardar:", err);
  }
}

function updateMemoryAffectionPeak() {
  const level = affectionLevel(affectionScore);
  let changed = false;
  if (affectionScore > (memory.highestAffectionReached || 0)) {
    memory.highestAffectionReached = affectionScore;
    changed = true;
  }
  const ranking = { low: 0, mid: 1, high: 2 };
  if (
    ranking[level] > ranking[memory.highestLevelReached || "low"]
  ) {
    memory.highestLevelReached = level;
    changed = true;
  }
  if (changed) {
    console.log(
      `[memory] nuevo pico: score=${memory.highestAffectionReached} nivel=${memory.highestLevelReached}`,
    );
    persistMemory();
  }
}

function distilledMemoryForServer() {
  return {
    profile: memory.profile,
    summaries: memory.summaries.slice(-3),
    highestLevelReached: memory.highestLevelReached,
  };
}

loadMemory();
console.log("[memory] cargada:", {
  profile: memory.profile,
  summaries: memory.summaries.length,
  totalUserMessages: memory.totalUserMessages,
  highestLevelReached: memory.highestLevelReached,
});

const chatHistory = [];

function pushHistory(role, text) {
  chatHistory.push({ role, text });
  if (chatHistory.length > 20) chatHistory.shift();
}

const info = document.getElementById("info");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 1.4, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444466, 0.8);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(2, 4, 3);
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0xa0c0ff, 0.4);
fillLight.position.set(-3, 2, -2);
scene.add(fillLight);

const gridHelper = new THREE.GridHelper(10, 10, 0x444466, 0x222244);
scene.add(gridHelper);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.update();

const clock = new THREE.Clock();

const lookAtTarget = new THREE.Object3D();
lookAtTarget.position.set(0, 1.4, 2);
scene.add(lookAtTarget);

let currentVrm = null;
let blinkTimer = 0;
let nextBlinkAt = 2 + Math.random() * 3;
let blinkPhase = 0;

function updateLookAtTargetFromPointer(clientX, clientY) {
  const x = (clientX / window.innerWidth) * 2 - 1;
  const y = -(clientY / window.innerHeight) * 2 + 1;

  const headHeight = currentVrm
    ? controls.target.y
    : 1.4;

  lookAtTarget.position.set(x * 1.5, headHeight + y * 0.8, 2);
}

window.addEventListener("mousemove", (event) => {
  updateLookAtTargetFromPointer(event.clientX, event.clientY);
});

window.addEventListener(
  "touchmove",
  (event) => {
    if (event.touches.length > 0) {
      const touch = event.touches[0];
      updateLookAtTargetFromPointer(touch.clientX, touch.clientY);
    }
  },
  { passive: true },
);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  "personaje.vrm",
  (gltf) => {
    const vrm = gltf.userData.vrm;

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);

    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    VRMUtils.rotateVRM0(vrm);

    scene.add(vrm.scene);
    currentVrm = vrm;

    const leftUpperArm = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
    const rightUpperArm = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
    if (leftUpperArm) {
      leftUpperArm.rotation.z = THREE.MathUtils.degToRad(70);
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.z = THREE.MathUtils.degToRad(-70);
    }

    if (vrm.lookAt) {
      vrm.lookAt.target = lookAtTarget;
    }

    const box = new THREE.Box3().setFromObject(vrm.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const headY = center.y + size.y * 0.35;
    controls.target.set(center.x, headY, center.z);

    const distance = size.y * 1.6;
    camera.position.set(center.x, headY, center.z + distance);
    controls.update();

    if (info) {
      info.textContent = "personaje.vrm cargado · mueve el cursor";
    }
  },
  (progress) => {
    if (info && progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      info.textContent = `Cargando personaje.vrm… ${pct}%`;
    }
  },
  (error) => {
    console.error("Error cargando el modelo VRM:", error);
    if (info) {
      info.textContent = "Error al cargar personaje.vrm";
    }
  },
);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const chatLog = document.getElementById("chat-log");
const chatBar = document.getElementById("chat-bar");
const chatInput = document.getElementById("chat-input");

function appendMessage(text, sender) {
  if (!chatLog) return null;
  const msg = document.createElement("div");
  msg.className = `chat-message ${sender}`;

  if (sender === "bot") {
    const textEl = document.createElement("span");
    textEl.className = "bubble-text";
    textEl.textContent = text;
    msg.appendChild(textEl);

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "play-btn";
    playBtn.setAttribute("aria-label", "Reproducir audio");
    playBtn.innerHTML =
      '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z"/></svg>';
    playBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = textEl.textContent || "";
      if (current) speakResponse(current);
    });
    msg.appendChild(playBtn);
  } else {
    msg.textContent = text;
  }

  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msg;
}

function setBubbleText(bubble, text) {
  if (!bubble) return;
  const textEl = bubble.querySelector(".bubble-text");
  if (textEl) {
    textEl.textContent = text;
  } else {
    bubble.textContent = text;
  }
}

let happyTimeoutId = null;
let lipSyncRafId = null;
let lipSyncStartedAt = 0;

let fallbackLipSyncIntervalId = null;
let fallbackLipSyncTimeoutId = null;

function stopFallbackLipSync() {
  if (fallbackLipSyncIntervalId !== null) {
    clearInterval(fallbackLipSyncIntervalId);
    fallbackLipSyncIntervalId = null;
  }
  if (fallbackLipSyncTimeoutId !== null) {
    clearTimeout(fallbackLipSyncTimeoutId);
    fallbackLipSyncTimeoutId = null;
  }
}

function fallbackLipSync(text) {
  stopFallbackLipSync();
  if (!currentVrm || !currentVrm.expressionManager) return;

  const length = (text && text.length) || 20;
  const durationMs = Math.max(1500, Math.min(12000, length * 70));
  const startedAt = performance.now();

  console.log(
    "[speech] fallback lip-sync activado (",
    durationMs,
    "ms, 75ms tick)",
  );

  fallbackLipSyncIntervalId = setInterval(() => {
    if (!currentVrm || !currentVrm.expressionManager) return;
    const t = (performance.now() - startedAt) / 1000;
    const wave = Math.abs(Math.sin(t * 9));
    const jitter = (Math.random() - 0.5) * 0.15;
    const value = Math.max(0, Math.min(1, 0.35 + wave * 0.55 + jitter));
    currentVrm.expressionManager.setValue("aa", value);
  }, 75);

  fallbackLipSyncTimeoutId = setTimeout(() => {
    stopFallbackLipSync();
    if (currentVrm && currentVrm.expressionManager) {
      currentVrm.expressionManager.setValue("aa", 0);
    }
  }, durationMs);
}

function stopLipSync() {
  if (lipSyncRafId !== null) {
    cancelAnimationFrame(lipSyncRafId);
    lipSyncRafId = null;
  }
  stopFallbackLipSync();
  if (currentVrm && currentVrm.expressionManager) {
    currentVrm.expressionManager.setValue("aa", 0);
  }
}

function simulateLipSync() {
  if (lipSyncRafId !== null) return;
  if (typeof speechSynthesis === "undefined") return;

  lipSyncStartedAt = performance.now();

  const tick = (now) => {
    lipSyncRafId = null;

    if (!speechSynthesis.speaking) {
      if (currentVrm && currentVrm.expressionManager) {
        currentVrm.expressionManager.setValue("aa", 0);
      }
      return;
    }

    if (currentVrm && currentVrm.expressionManager) {
      const t = (now - lipSyncStartedAt) / 1000;
      const wave = Math.abs(Math.sin(t * 9));
      const jitter = (Math.random() - 0.5) * 0.15;
      const value = Math.max(0, Math.min(1, 0.35 + wave * 0.55 + jitter));
      currentVrm.expressionManager.setValue("aa", value);
    }

    lipSyncRafId = requestAnimationFrame(tick);
  };

  lipSyncRafId = requestAnimationFrame(tick);
}

let cachedVoices = [];

function loadVoices() {
  if (typeof speechSynthesis === "undefined") return;
  cachedVoices = speechSynthesis.getVoices() || [];
}

if (typeof speechSynthesis !== "undefined") {
  loadVoices();
  if (typeof speechSynthesis.addEventListener === "function") {
    speechSynthesis.addEventListener("voiceschanged", loadVoices);
  } else {
    speechSynthesis.onvoiceschanged = loadVoices;
  }
}

function pickSpanishFemaleVoice() {
  if (cachedVoices.length === 0) loadVoices();
  const esVoices = cachedVoices.filter((v) =>
    (v.lang || "").toLowerCase().startsWith("es"),
  );
  if (esVoices.length === 0) return null;

  const femaleHints = [
    "female",
    "mujer",
    "mónica",
    "monica",
    "paulina",
    "marisol",
    "esperanza",
    "sabina",
    "helena",
    "lucia",
    "lucía",
    "sara",
    "laura",
    "carmen",
    "elvira",
    "google español",
  ];
  const maleHints = ["male", "masculino", "jorge", "diego", "carlos", "juan"];

  const female = esVoices.find((v) => {
    const n = (v.name || "").toLowerCase();
    return (
      femaleHints.some((h) => n.includes(h)) &&
      !maleHints.some((h) => n.includes(h))
    );
  });

  return female || esVoices[0];
}

let speechPrimed = false;

function primeSpeech() {
  if (speechPrimed || typeof speechSynthesis === "undefined") return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.rate = 1;
    speechSynthesis.speak(u);
    console.log("[speech] audio desbloqueado");
  } catch (err) {
    console.warn("[speech] no se pudo desbloquear el audio:", err);
  }
  speechPrimed = true;
}

function doSpeak(text) {
  const voices = speechSynthesis.getVoices() || [];
  console.log("Voces disponibles:", voices.length);
  cachedVoices = voices;

  const voice = pickSpanishFemaleVoice();
  console.log(
    "[speech] voz elegida:",
    voice ? `${voice.name} (${voice.lang})` : "ninguna (default del navegador)",
  );

  const utter = new SpeechSynthesisUtterance(text);
  if (voice) utter.voice = voice;
  utter.lang = voice?.lang || "es-ES";
  utter.rate = 1.0;
  utter.pitch = 1.1;

  utter.onstart = () => {
    console.log("[speech] onstart — arrancando lip-sync");
    simulateLipSync();
  };
  utter.onend = () => {
    console.log("[speech] onend");
    stopLipSync();
  };
  utter.onerror = (event) => {
    console.warn("[speech] onerror:", event.error, "→ usando lip-sync de respaldo");
    stopLipSync();
    fallbackLipSync(text);
  };

  speechSynthesis.speak(utter);
}

function speakResponse(text) {
  console.log("--- Intentando hablar ---", text?.slice(0, 60));

  if (typeof speechSynthesis === "undefined") {
    console.warn("[speech] Web Speech API no disponible en este navegador");
    fallbackLipSync(text);
    return;
  }

  try {
    speechSynthesis.pause();
    speechSynthesis.resume();
    speechSynthesis.cancel();
  } catch (err) {
    console.warn("[speech] force-reset falló:", err);
  }
  stopLipSync();

  if (!text) return;

  const voices = speechSynthesis.getVoices() || [];
  if (voices.length === 0) {
    console.log(
      "[speech] lista de voces vacía, esperando 'voiceschanged'…",
    );

    let fired = false;
    const onVoices = () => {
      if (fired) return;
      fired = true;
      speechSynthesis.removeEventListener?.("voiceschanged", onVoices);
      doSpeak(text);
    };
    speechSynthesis.addEventListener?.("voiceschanged", onVoices);

    window.setTimeout(() => {
      if (fired) return;
      fired = true;
      speechSynthesis.removeEventListener?.("voiceschanged", onVoices);
      console.warn(
        "[speech] 'voiceschanged' no llegó tras 1.5s, hablo igualmente",
      );
      doSpeak(text);
    }, 1500);
    return;
  }

  doSpeak(text);
}

function reactHappy(durationMs = 2000) {
  if (!currentVrm || !currentVrm.expressionManager) return;
  currentVrm.expressionManager.setValue("happy", 1);
  if (happyTimeoutId !== null) {
    clearTimeout(happyTimeoutId);
  }
  happyTimeoutId = window.setTimeout(() => {
    if (currentVrm && currentVrm.expressionManager) {
      currentVrm.expressionManager.setValue("happy", 0);
    }
    happyTimeoutId = null;
  }, durationMs);
}

async function postChatOnce(payload) {
  const requestBody = JSON.stringify(payload);
  console.log("Petición al servidor:", {
    url: CHAT_ENDPOINT,
    affectionScore: payload.affectionScore,
    level: affectionLevel(payload.affectionScore),
    historyLen: payload.history?.length || 0,
    summaries: payload.memory?.summaries?.length || 0,
  });

  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (parseErr) {
    console.error(
      "Respuesta del servidor (no es JSON):",
      response.status,
      rawText,
    );
    throw new Error(
      `Respuesta no-JSON del servidor (HTTP ${response.status})`,
    );
  }

  console.log("Respuesta del servidor:", data);

  if (!response.ok) {
    const detail = data?.error ? ` - ${data.error}` : "";
    console.error(
      `Error del servidor: HTTP ${response.status}${detail}`,
      data,
    );
    const err = new Error(`HTTP ${response.status}${detail}`);
    err.status = response.status;
    throw err;
  }

  const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
  if (!reply) {
    throw new Error("El servidor respondió 200 pero sin campo 'reply'");
  }
  return reply;
}

async function askGemini(userText) {
  const payload = {
    message: userText,
    affectionScore,
    history: chatHistory.slice(-HISTORY_WINDOW),
    memory: distilledMemoryForServer(),
  };

  try {
    return await postChatOnce(payload);
  } catch (err) {
    if (err?.status === 429) {
      console.warn(
        "[chat] 429 recibido — esperando 2s y reintentando una vez...",
      );
      await new Promise((r) => setTimeout(r, 2000));
      return await postChatOnce(payload);
    }
    throw err;
  }
}

async function requestSummary() {
  const recent = chatHistory.slice(-6);
  if (recent.length < 2) return;

  console.log(
    `[memory] generando resumen tras ${memory.totalUserMessages} mensajes…`,
  );

  try {
    const response = await fetch("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history: recent,
        userName: memory.profile.name,
      }),
    });
    if (!response.ok) {
      console.warn("[memory] resumen falló: HTTP", response.status);
      return;
    }
    const data = await response.json().catch(() => null);
    const summary =
      typeof data?.summary === "string" ? data.summary.trim() : "";
    if (!summary) {
      console.warn("[memory] resumen vacío");
      return;
    }
    memory.summaries.push(summary);
    if (memory.summaries.length > MEMORY_MAX_SUMMARIES) {
      memory.summaries = memory.summaries.slice(-MEMORY_MAX_SUMMARIES);
    }
    persistMemory();
    console.log(`[memory] hito guardado: "${summary}"`);
  } catch (err) {
    console.warn("[memory] error generando resumen:", err);
  }
}

async function handleUserMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  primeSpeech();
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
  stopLipSync();

  updateAffection(trimmed);

  appendMessage(trimmed, "user");
  chatInput.value = "";
  pushHistory("user", trimmed);

  memory.totalUserMessages = (memory.totalUserMessages || 0) + 1;
  persistMemory();

  const thinkingBubble = appendMessage("Hina está pensando...", "bot");

  try {
    const reply = await askGemini(trimmed);
    if (thinkingBubble) {
      setBubbleText(thinkingBubble, reply);
    } else {
      appendMessage(reply, "bot");
    }
    pushHistory("model", reply);
    reactHappy(3000);
    speakResponse(reply);

    if (memory.totalUserMessages % SUMMARY_EVERY_N_USER_MSGS === 0) {
      requestSummary();
    }
  } catch (error) {
    console.error("Error consultando a Gemini:", error);

    let errorText;
    if (error?.status === 429) {
      errorText =
        "¡Cálmate, Víctor! Me aturdes con tantos mensajes, dame un respiro.";
    } else {
      const detail = error?.message ? ` (${error.message})` : "";
      errorText = `Hina tuvo un pequeño problema de conexión${detail}`;
    }

    if (thinkingBubble) {
      setBubbleText(thinkingBubble, errorText);
    } else {
      appendMessage(errorText, "bot");
    }
  }
}

function showInitialGreeting() {
  if (!chatLog) return;
  const name = memory.profile.name;
  const city = memory.profile.city;
  const lvl = affectionLevel(affectionScore);

  let greeting;
  if (lvl === "low") {
    greeting = `Tch, ya regresaste, ${name}. ¿Hoy sí piensas estudiar en SENATI o solo vienes a perder el tiempo?`;
  } else if (lvl === "mid") {
    greeting = `Hola, ${name}… no te emociones. Solo me alegra un poco verte de vuelta.`;
  } else {
    greeting = `¡${name}! Te estaba esperando. ¿Cómo va todo por ${city}? Cuéntame qué proyecto de Python traes hoy.`;
  }

  if (memory.summaries.length > 0) {
    const lastSummary = memory.summaries[memory.summaries.length - 1];
    console.log(`[memory] último hito recordado: "${lastSummary}"`);
  }

  appendMessage(greeting, "bot");
  pushHistory("model", greeting);
}

if (chatBar) {
  chatBar.addEventListener("submit", (event) => {
    event.preventDefault();
    handleUserMessage(chatInput.value);
  });
}

if (chatInput) {
  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleUserMessage(chatInput.value);
    }
  });
}

const startOverlay = document.getElementById("start-overlay");

function dismissStartOverlay() {
  primeSpeech();
  if (startOverlay) {
    startOverlay.classList.add("hidden");
    window.setTimeout(() => startOverlay.remove(), 500);
  }
}

if (startOverlay) {
  const handleStart = (event) => {
    event.preventDefault();
    dismissStartOverlay();
  };
  startOverlay.addEventListener("pointerdown", handleStart, { once: true });
  startOverlay.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        dismissStartOverlay();
      }
    },
    { once: true },
  );
}

const unlockOnFirstTouch = () => {
  primeSpeech();
};
window.addEventListener("pointerdown", unlockOnFirstTouch, { once: true });
window.addEventListener("keydown", unlockOnFirstTouch, { once: true });

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.elapsedTime;

  if (currentVrm) {
    const spine = currentVrm.humanoid?.getNormalizedBoneNode("spine");
    if (spine) {
      spine.rotation.x = Math.sin(elapsed * 1.5) * 0.025;
    }

    const expressionManager = currentVrm.expressionManager;
    if (expressionManager) {
      blinkTimer += delta;
      if (blinkPhase === 0 && blinkTimer >= nextBlinkAt) {
        blinkPhase = 1;
        blinkTimer = 0;
      }

      let blinkValue = 0;
      if (blinkPhase === 1) {
        blinkValue = Math.min(blinkTimer / 0.08, 1);
        if (blinkValue >= 1) {
          blinkPhase = 2;
          blinkTimer = 0;
        }
      } else if (blinkPhase === 2) {
        blinkValue = 1 - Math.min(blinkTimer / 0.12, 1);
        if (blinkValue <= 0) {
          blinkPhase = 0;
          blinkTimer = 0;
          nextBlinkAt = 2 + Math.random() * 3;
          blinkValue = 0;
        }
      }
      expressionManager.setValue("blink", blinkValue);
    }

    currentVrm.update(delta);
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();
showInitialGreeting();
