import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// =============================================================================
// FASE 1 · ACCESO PRIVADO (frase clave)
// =============================================================================

const AUTH_STORAGE_KEY = "hina.auth.token.v1";
const AUTH_ENDPOINT = "/auth";
const CHAT_ENDPOINT = "/chat";
const ANALYZE_ENDPOINT = "/analyze";

// =============================================================================
// FASE 8 · CEREBRO DUAL (Gemini + Groq) con persistencia y aviso visual
// =============================================================================
const BRAIN_STORAGE_KEY = "hina.brain.v1";
const BRAIN_OPTIONS = ["gemini", "groq"];
let currentBrain = (() => {
  try {
    const v = localStorage.getItem(BRAIN_STORAGE_KEY);
    return BRAIN_OPTIONS.includes(v) ? v : "gemini";
  } catch {
    return "gemini";
  }
})();
function persistBrain() {
  try { localStorage.setItem(BRAIN_STORAGE_KEY, currentBrain); } catch {}
}

function brainLabel(b) {
  return b === "groq" ? "Groq · llama3-70b" : "Gemini · flash";
}

function refreshBrainToggleUi() {
  const btn = document.getElementById("brain-toggle");
  if (!btn) return;
  btn.dataset.brain = currentBrain;
  btn.textContent = currentBrain === "groq" ? "🧠 Groq" : "🧠 Gemini";
  btn.title = `Cerebro activo: ${brainLabel(currentBrain)} · click para cambiar`;
}

function setBrain(next, opts = {}) {
  if (!BRAIN_OPTIONS.includes(next)) return;
  if (currentBrain === next) return;
  currentBrain = next;
  persistBrain();
  refreshBrainToggleUi();
  if (opts.silent) return;
  const msg = next === "groq"
    ? "Cambiando a procesador de alta velocidad para ayudarte mejor."
    : "Vuelvo al cerebro Gemini, tengo más contexto multimodal aquí.";
  appendMessage(msg, "bot");
  pushHistory("model", msg);
  speakResponse(msg);
}

function toggleBrain() {
  setBrain(currentBrain === "groq" ? "gemini" : "groq");
}

// Aviso silencioso (no se habla) cuando el servidor cae al otro cerebro
// por error 401/429/500 — solo mostramos un mensaje de sistema y actualizamos el toggle.
let lastFallbackToast = 0;
function notifyBrainSwitchedByFallback(requested, actual) {
  const now = Date.now();
  if (now - lastFallbackToast < 5000) return; // no spamear
  lastFallbackToast = now;
  appendMessage(
    `(*${brainLabel(requested)} no respondió, salté a ${brainLabel(actual)}.*)`,
    "system",
  );
  // sincronizamos el toggle con la realidad para no engañar al usuario
  currentBrain = actual;
  persistBrain();
  refreshBrainToggleUi();
}
const SUMMARIZE_ENDPOINT = "/summarize";

let authToken = null;

function loadStoredAuth() {
  try {
    const v = localStorage.getItem(AUTH_STORAGE_KEY);
    if (typeof v === "string" && v.trim().length > 0) authToken = v.trim();
  } catch (err) {
    console.warn("[auth] no se pudo leer localStorage:", err);
  }
}

function persistAuth(token) {
  try {
    if (token) localStorage.setItem(AUTH_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch (err) {
    console.warn("[auth] no se pudo guardar localStorage:", err);
  }
}

function authHeaders(extra = {}) {
  return authToken
    ? { Authorization: `Bearer ${authToken}`, ...extra }
    : { ...extra };
}

async function verifyPassphrase(passphrase) {
  const response = await fetch(AUTH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = data?.error || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  if (!data?.token) throw new Error("Respuesta sin token");
  return data.token;
}

// =============================================================================
// FASE 2 · AFECTO 4 NIVELES (sin insultos)
// =============================================================================

const AFFECT_STORAGE_KEY = "hina.affection.v2";
const AFFECT_MIN = 0;
const AFFECT_MAX = 100;
const AFFECT_INITIAL = 0;
const AFFECT_KIND_DELTA = 2;
const AFFECT_GIFT_DELTA = 10;
const AFFECT_DECAY_PER_MINUTE = 0.1;
const AFFECT_DECAY_GRACE_MIN = 5;

const KIND_WORDS = [
  "gracias", "por favor", "te quiero", "te amo", "amor", "cariño", "carino",
  "linda", "bonita", "hermosa", "preciosa", "encantadora", "guapa",
  "eres genial", "increíble", "increible", "fantástica", "fantastica",
  "perfecta", "querida", "te adoro",
  "feliz", "buenos días", "buenos dias", "buenas noches", "buenas tardes",
];

let affectionScore = AFFECT_INITIAL;
let affectionLastInteractionAt = Date.now();

function clampAffection(n) {
  if (!Number.isFinite(n)) return AFFECT_INITIAL;
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
  for (const w of KIND_WORDS) {
    if (t.includes(w)) {
      kindHit = w;
      delta += AFFECT_KIND_DELTA;
      break;
    }
  }
  return { delta, kindHit };
}

function bumpAffection(delta, reason = "") {
  if (!Number.isFinite(delta) || delta === 0) return;
  const before = affectionScore;
  affectionScore = clampAffection(affectionScore + delta);
  console.log(
    `[affect] ${delta > 0 ? "+" : ""}${delta} (${reason}) → ${before} → ${affectionScore}`,
  );
  affectionLastInteractionAt = Date.now();
  persistAffection();
  updateMemoryAffectionPeak();
}

function registerInteraction(userText) {
  applyInactivityDecay();
  const { delta, kindHit } = evaluateSentiment(userText);
  if (delta !== 0) bumpAffection(delta, kindHit || "");
  affectionLastInteractionAt = Date.now();
  persistAffection();
}

function affectionLevel(score = affectionScore) {
  if (score <= 25) return "distant";
  if (score <= 40) return "confidant";
  if (score <= 75) return "affectionate";
  return "girlfriend";
}

const LEVEL_LABEL_ES = {
  distant: "Distante",
  confidant: "Confidente",
  affectionate: "Cariñosa",
  girlfriend: "Novia virtual",
};

loadAffection();
applyInactivityDecay();
console.log(
  `[affect] inicio: score=${affectionScore} nivel=${affectionLevel()}`,
);

// =============================================================================
// FASE 2 · MEMORIA RESETEADA (Hina no sabe nada del usuario)
// =============================================================================

const MEMORY_STORAGE_KEY = "hina.memory.v2";
const MEMORY_MAX_SUMMARIES = 10;
const HISTORY_WINDOW = 3;
const SUMMARY_EVERY_N_USER_MSGS = 10;

const DEFAULT_MEMORY = {
  profile: {
    // En blanco a propósito: Hina te conocerá desde cero.
  },
  highestAffectionReached: AFFECT_INITIAL,
  highestLevelReached: "distant",
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
  const ranking = { distant: 0, confidant: 1, affectionate: 2, girlfriend: 3 };
  if (
    (ranking[level] ?? 0) >
    (ranking[memory.highestLevelReached || "distant"] ?? 0)
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

// =============================================================================
// ESCENA 3D
// =============================================================================

const info = document.getElementById("info");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 1.45, 1.2);

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
controls.target.set(0, 1.45, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.minDistance = 0.6;
controls.maxDistance = 3.0;
controls.update();

const clock = new THREE.Clock();

const lookAtTarget = new THREE.Object3D();
lookAtTarget.position.set(0, 1.4, 2);
scene.add(lookAtTarget);

let currentVrm = null;
let blinkTimer = 0;
let nextBlinkAt = 2 + Math.random() * 3;
let blinkPhase = 0;

let basePoseRest = null;

function captureRestPose(vrm) {
  const rest = {};
  const bones = [
    "leftUpperArm", "rightUpperArm",
    "leftLowerArm", "rightLowerArm",
    "leftHand", "rightHand",
    "spine", "chest", "neck", "head",
    "hips", "leftUpperLeg", "rightUpperLeg",
  ];
  for (const name of bones) {
    const node = vrm.humanoid?.getNormalizedBoneNode(name);
    if (node) rest[name] = node.rotation.clone();
  }
  basePoseRest = rest;
}

function updateLookAtTargetFromPointer(clientX, clientY) {
  const x = (clientX / window.innerWidth) * 2 - 1;
  const y = -(clientY / window.innerHeight) * 2 + 1;
  const headHeight = currentVrm ? controls.target.y : 1.45;
  lookAtTarget.position.set(x * 1.5, headHeight + y * 0.8, 2);
}

window.addEventListener("mousemove", (event) => {
  updateLookAtTargetFromPointer(event.clientX, event.clientY);
});

window.addEventListener(
  "touchmove",
  (event) => {
    if (event.touches.length > 0) {
      const t = event.touches[0];
      updateLookAtTargetFromPointer(t.clientX, t.clientY);
    }
  },
  { passive: true },
);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

// =============================================================================
// FASE 7 · BARRA DE PROGRESO GLOBAL (carga de outfits y animaciones)
// =============================================================================

const loadBarEl = document.getElementById("load-bar");
const loadBarText = document.getElementById("load-bar-text");
const loadBarPct = document.getElementById("load-bar-pct");
const loadBarFill = document.getElementById("load-bar-fill");
let loadBarHideTimer = null;

function showLoadBar(label) {
  if (!loadBarEl) return;
  if (loadBarHideTimer) {
    clearTimeout(loadBarHideTimer);
    loadBarHideTimer = null;
  }
  if (loadBarText) loadBarText.textContent = label || "Cargando…";
  if (loadBarFill) loadBarFill.style.width = "0%";
  if (loadBarPct) loadBarPct.textContent = "0%";
  loadBarEl.classList.add("visible");
}

function updateLoadBar(loaded, total, label) {
  if (!loadBarEl) return;
  if (label && loadBarText) loadBarText.textContent = label;
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
    if (loadBarFill) loadBarFill.style.width = `${pct}%`;
    if (loadBarPct) loadBarPct.textContent = `${pct}%`;
  } else {
    // tamaño desconocido: muestra MB descargados
    const mb = (loaded / (1024 * 1024)).toFixed(1);
    if (loadBarPct) loadBarPct.textContent = `${mb} MB`;
  }
}

function hideLoadBar(delayMs = 600) {
  if (!loadBarEl) return;
  if (loadBarFill) loadBarFill.style.width = "100%";
  if (loadBarPct) loadBarPct.textContent = "100%";
  if (loadBarHideTimer) clearTimeout(loadBarHideTimer);
  loadBarHideTimer = setTimeout(() => {
    loadBarEl.classList.remove("visible");
    loadBarHideTimer = null;
  }, delayMs);
}

// =============================================================================
// FASE 7 · ARMARIO (outfits VRM)
// =============================================================================

const WARDROBE = {
  hina:    { label: "Hina (default)", path: "wardrobe/hina.vrm",    category: "default" },
  casual1: { label: "Casual 1",       path: "wardrobe/casual1.vrm", category: "casual"  },
  casual2: { label: "Casual 2",       path: "wardrobe/casual2.vrm", category: "casual"  },
  casual3: { label: "Casual 3",       path: "wardrobe/casual3.vrm", category: "casual"  },
  pijama:  { label: "Pijama",         path: "wardrobe/pijama.vrm",  category: "noche"   },
  maid:    { label: "Maid",           path: "wardrobe/maid.vrm",    category: "especial"},
  cosplay: { label: "Cosplay",        path: "wardrobe/cosplay.vrm", category: "especial"},
  sexy1:   { label: "Sexy",           path: "wardrobe/sexy1.vrm",   category: "especial"},
  sexy2:   { label: "Sexy 2",         path: "wardrobe/sexy2.vrm",   category: "especial"},
};

const OUTFIT_STORAGE_KEY = "hina.outfit.v1";
let currentOutfit = "hina";
let isOutfitLoading = false;

function persistCurrentOutfit() {
  try { localStorage.setItem(OUTFIT_STORAGE_KEY, currentOutfit); } catch {}
}

function loadStoredOutfit() {
  try {
    const v = localStorage.getItem(OUTFIT_STORAGE_KEY);
    if (v && WARDROBE[v]) return v;
  } catch {}
  return null;
}

function pickInitialOutfit() {
  // 1) lo último que llevaba puesto, si existe
  const stored = loadStoredOutfit();
  if (stored) return stored;
  // 2) por hora de Piura
  const h = piuraLocalDate().getHours();
  if (h >= 22 || h < 6) return "pijama";
  // 3) por calor: si arriba de 30°C, 50% de probabilidad de subir a sexy/cosplay
  const temp = piuraContext?.tempC;
  if (Number.isFinite(temp) && temp > 30 && Math.random() < 0.5) {
    const hot = ["sexy1", "sexy2", "cosplay"];
    return hot[Math.floor(Math.random() * hot.length)];
  }
  // 4) casual aleatorio (rotación 1/2/3)
  const casuals = ["casual1", "casual2", "casual3"];
  return casuals[Math.floor(Math.random() * casuals.length)];
}

function disposeVrm(vrm) {
  if (!vrm) return;
  scene.remove(vrm.scene);
  vrm.scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (v && typeof v === "object" && typeof v.dispose === "function" && v.isTexture) {
            v.dispose();
          }
        }
        m.dispose?.();
      }
    }
  });
  VRMUtils.deepDispose?.(vrm.scene);
}

// FASE 7+ · pose canónica de Hina (A-pose natural).
// Se aplica a TODOS los modelos al cargar para eliminar la T-pose por completo.
// Cualquier outfit hereda la misma postura de descanso, así Hina siempre se ve
// como Hina, sin importar qué ropa lleve.
const HINA_REST_POSE = {
  // tronco
  hips:           { x: 0,     y: 0,     z: 0     },
  spine:          { x: 0.04,  y: 0,     z: 0     },
  chest:          { x: 0.02,  y: 0,     z: 0     },
  upperChest:     { x: 0,     y: 0,     z: 0     },
  neck:           { x: 0.02,  y: 0,     z: 0     },
  head:           { x: 0,     y: 0,     z: 0     },
  // brazos en A-pose suave
  leftShoulder:   { x: 0,     y: 0,     z: 0.05  },
  rightShoulder:  { x: 0,     y: 0,    z: -0.05  },
  leftUpperArm:   { x: 0.05,  y: 0,     z: 1.222 }, // ≈ 70°
  rightUpperArm:  { x: 0.05,  y: 0,    z: -1.222 },
  leftLowerArm:   { x: 0,     y: 0.18,  z: 0     },
  rightLowerArm:  { x: 0,     y: -0.18, z: 0     },
  leftHand:       { x: 0,     y: 0,     z: -0.05 },
  rightHand:      { x: 0,     y: 0,     z: 0.05  },
  // piernas relajadas
  leftUpperLeg:   { x: 0,     y: 0,     z: 0     },
  rightUpperLeg:  { x: 0,     y: 0,     z: 0     },
  leftLowerLeg:   { x: 0.02,  y: 0,     z: 0     },
  rightLowerLeg:  { x: 0.02,  y: 0,     z: 0     },
  leftFoot:       { x: 0,     y: 0,     z: 0     },
  rightFoot:      { x: 0,     y: 0,     z: 0     },
};

function normalizeToHinaPose(vrm) {
  if (!vrm.humanoid) return;
  // 1) reset duro: vuelve TODOS los huesos humanoides a rotación 0 (T-pose nativa)
  if (typeof vrm.humanoid.resetNormalizedPose === "function") {
    vrm.humanoid.resetNormalizedPose();
  } else if (typeof vrm.humanoid.resetPose === "function") {
    vrm.humanoid.resetPose();
  }
  // 2) aplica la A-pose canónica de Hina hueso por hueso
  for (const [boneName, rot] of Object.entries(HINA_REST_POSE)) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) continue;
    node.rotation.x = rot.x;
    node.rotation.y = rot.y;
    node.rotation.z = rot.z;
  }
}

// alias retrocompatible: cualquier llamada vieja sigue funcionando
function applyDefaultRestPose(vrm) {
  normalizeToHinaPose(vrm);
}

// =============================================================================
// FASE 7+ · INTERCAMBIO UNIVERSAL DE TEXTURAS (préstamo de ropa)
// =============================================================================
//
// Permite que el modelo activo "tome prestada" la textura de ropa de cualquier
// otro modelo del armario sin cambiar de estructura. Funciona porque los VRoid
// nombran sus materiales con sufijos consistentes (Tops/Bottoms/Onepiece/etc).
const CLOTH_KEYWORDS = [
  "tops", "bottoms", "onepiece", "outerwear", "footwear",
  "skirt", "dress", "cloth", "swimwear", "underwear",
];

function isClothMaterial(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return CLOTH_KEYWORDS.some((k) => lower.includes(k));
}

function extractClothTextures(vrm) {
  const out = [];
  const seen = new Set();
  vrm.scene.traverse((obj) => {
    if (!obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m.name || seen.has(m.name)) continue;
      if (!isClothMaterial(m.name)) continue;
      if (!m.map) continue;
      seen.add(m.name);
      out.push({
        materialName: m.name,
        texture: m.map,
        color: m.color?.clone?.(),
      });
    }
  });
  return out;
}

function applyClothTextures(vrm, source) {
  if (!source || !source.length) return 0;
  let count = 0;
  vrm.scene.traverse((obj) => {
    if (!obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m.name || !m.map) continue;
      // 1) match exacto por nombre de material
      let pick = source.find((s) => s.materialName === m.name);
      // 2) fallback por categoría (Tops, Bottoms, etc.)
      if (!pick) {
        const cat = CLOTH_KEYWORDS.find((k) =>
          m.name.toLowerCase().includes(k),
        );
        if (cat) {
          pick = source.find((s) =>
            s.materialName.toLowerCase().includes(cat),
          );
        }
      }
      if (pick) {
        m.map = pick.texture;
        if (m.color && pick.color) m.color.copy(pick.color);
        m.needsUpdate = true;
        count += 1;
      }
    }
  });
  return count;
}

let isBorrowingTexture = false;
async function borrowTexturesFrom(sourceName) {
  if (!currentVrm) return false;
  const def = WARDROBE[sourceName];
  if (!def) return false;
  if (isBorrowingTexture) return false;
  isBorrowingTexture = true;
  showLoadBar(`Tomando prestada la ropa de ${def.label}…`);
  return new Promise((resolve) => {
    loader.load(
      def.path,
      (gltf) => {
        const sourceVrm = gltf.userData.vrm;
        const tex = extractClothTextures(sourceVrm);
        const applied = applyClothTextures(currentVrm, tex);
        // limpieza: dispone TODO menos las texturas que se quedaron prestadas
        const keepers = new Set(tex.map((t) => t.texture.uuid));
        sourceVrm.scene.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose?.();
          if (!obj.material) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            for (const k of Object.keys(m)) {
              const v = m[k];
              if (v && v.isTexture && !keepers.has(v.uuid)) v.dispose();
            }
            m.dispose?.();
          }
        });
        VRMUtils.deepDispose?.(sourceVrm.scene);
        hideLoadBar(400);
        isBorrowingTexture = false;
        console.log(`[texture-swap] aplicadas ${applied} texturas de ${sourceName}`);
        resolve(applied > 0);
      },
      (p) => updateLoadBar(p.loaded || 0, p.total || 0),
      (err) => {
        console.error("[texture-swap] error", err);
        hideLoadBar(0);
        isBorrowingTexture = false;
        resolve(false);
      },
    );
  });
}

function loadOutfit(name, opts = {}) {
  const def = WARDROBE[name];
  if (!def) {
    console.warn("[wardrobe] outfit desconocido:", name);
    return Promise.resolve(false);
  }
  if (isOutfitLoading) {
    console.log("[wardrobe] ya hay una carga en curso, se ignora", name);
    return Promise.resolve(false);
  }
  isOutfitLoading = true;
  const label = `Cargando ${def.label}…`;
  showLoadBar(label);
  if (info) info.textContent = label;

  return new Promise((resolve) => {
    loader.load(
      def.path,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);
        vrm.scene.traverse((obj) => { obj.frustumCulled = false; });
        VRMUtils.rotateVRM0(vrm);

        // descarta outfit anterior
        if (currentVrm) disposeVrm(currentVrm);

        scene.add(vrm.scene);
        currentVrm = vrm;
        currentOutfit = name;
        persistCurrentOutfit();

        applyDefaultRestPose(vrm);
        if (vrm.lookAt) vrm.lookAt.target = lookAtTarget;
        captureRestPose(vrm);

        // FASE 8 · Watcher anti-T-pose: algunos VRMs (casual2, casual3, pijama,
        // cosplay) tienen una pose interna que sobreescribe la nuestra durante
        // los primeros frames. Volvemos a normalizar 5 frames y a 100/300 ms.
        const reapply = () => {
          if (currentVrm === vrm) normalizeToHinaPose(vrm);
        };
        for (let i = 1; i <= 5; i++) {
          requestAnimationFrame(reapply);
        }
        setTimeout(reapply, 100);
        setTimeout(reapply, 300);

        // ancla la cámara al hueso de la cabeza (J_Bip_C_Head)
        anchorCameraToHead(vrm);

        renderWardrobeButtons();
        if (info) info.textContent = `Hina lista (${def.label})`;
        hideLoadBar(500);
        isOutfitLoading = false;

        if (!opts.silent) {
          appendMessage(`(*Hina ahora lleva: ${def.label}*)`, "system");
        }
        resolve(true);
      },
      (progress) => {
        updateLoadBar(progress.loaded || 0, progress.total || 0, label);
      },
      (error) => {
        console.error("[wardrobe] error cargando", def.path, error);
        if (info) info.textContent = `Error al cargar ${def.label}`;
        hideLoadBar(1500);
        isOutfitLoading = false;
        resolve(false);
      },
    );
  });
}

// FASE 7 · cámara anclada al hueso de la cabeza
let headBoneRef = null;
const HEAD_OFFSET = new THREE.Vector3(0, 0.05, 0); // ligera altura por encima del hueso head
function anchorCameraToHead(vrm) {
  headBoneRef =
    vrm.humanoid?.getRawBoneNode?.("head") ||
    vrm.humanoid?.getNormalizedBoneNode?.("head") ||
    null;
  if (!headBoneRef) {
    console.warn("[camera] no se encontró el hueso head, anclaje desactivado");
  }
}

// =============================================================================
// FASE 7 · ANIMACIONES POR CONTEXTO (saludo / pensativa / autónomas / heart)
// =============================================================================
//
// Los .vmd originales se conservan en public/animations/ para una integración
// futura con MMDLoader+retarget. Por ahora cada nombre dispara la animación
// procedural equivalente — funciona instantáneamente con cualquier outfit
// y no satura un Xiaomi.
const VMD_TO_GESTURE = {
  saludo: "saluda",
  pensativa: "pensativa",
  alternativo: "alternativo",
  posec: "posec",
  heart: "heart",
};
function playAnimation(name) {
  const g = VMD_TO_GESTURE[name] || name;
  playGesture(g);
}

const AUTONOMOUS_INTERVAL_MS = 45 * 1000;
const AUTONOMOUS_POOL = ["alternativo", "posec"];
let lastAutonomousAt = 0;

function tickAutonomousAnimations() {
  if (!currentVrm) return;
  if (activeGesture) return;
  if (isOutfitLoading) return;
  if (Date.now() - lastAutonomousAt < AUTONOMOUS_INTERVAL_MS) return;
  // espera a que el usuario haya entrado y a que esté quieto
  if (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking) return;
  const pick = AUTONOMOUS_POOL[Math.floor(Math.random() * AUTONOMOUS_POOL.length)];
  console.log("[autonomous] play", pick);
  playAnimation(pick);
  lastAutonomousAt = Date.now();
}
// no dispares en el primer minuto, deja que se asiente la escena
lastAutonomousAt = Date.now();

// =============================================================================
// FASE 7 · Botonera rápida del armario (esquina sup. derecha)
// =============================================================================

// FASE 8 · Toggle del cerebro (Gemini ↔ Groq)
const brainToggleBtn = document.getElementById("brain-toggle");
if (brainToggleBtn) {
  brainToggleBtn.addEventListener("click", () => toggleBrain());
  refreshBrainToggleUi();
}

const wardrobeOverlay = document.getElementById("wardrobe-overlay");
function renderWardrobeButtons() {
  if (!wardrobeOverlay) return;
  wardrobeOverlay.innerHTML = "";
  const order = ["hina", "casual1", "casual2", "casual3", "pijama", "maid", "cosplay", "sexy1", "sexy2"];
  for (const k of order) {
    const def = WARDROBE[k];
    if (!def) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wardrobe-btn" + (k === currentOutfit ? " current" : "");
    btn.textContent = def.label;
    btn.addEventListener("click", () => {
      if (k === currentOutfit) return;
      loadOutfit(k);
    });
    wardrobeOverlay.appendChild(btn);
  }
}

// arranca con un outfit; si ya hay clima cargado úsalo, si no usa hora
async function bootInitialOutfit() {
  // espera al primer fetch de clima (no bloquea más de ~1s)
  for (let i = 0; i < 20; i += 1) {
    if (piuraContext && piuraContext.fetchedAt > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const initial = pickInitialOutfit();
  await loadOutfit(initial, { silent: true });
}
// se difiere para que el resto del módulo (piuraContext, appendMessage, etc.)
// haya terminado de evaluarse antes de tocarlo
setTimeout(bootInitialOutfit, 0);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// =============================================================================
// FASE 4 · GESTOS PROCEDIMENTALES (saluda · baila · gira · ven · alegría)
// =============================================================================

const GESTURES = {
  saluda: {
    duration: 3.2,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const wave = Math.sin(t * 8) * 0.35 * k;
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const rl = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm");
      const rh = vrm.humanoid?.getNormalizedBoneNode("rightHand");
      const rest = basePoseRest || {};
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z - 1.7 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.3 * k;
      }
      if (rl && rest.rightLowerArm) {
        rl.rotation.x = rest.rightLowerArm.x - 0.6 * k + wave * 0.4;
      }
      if (rh && rest.rightHand) {
        rh.rotation.z = rest.rightHand.z + wave;
      }
    },
  },
  baila: {
    duration: 5.5,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const beat = t * 4;
      const sway = Math.sin(beat) * 0.25 * k;
      const bob = Math.abs(Math.sin(beat * 2)) * 0.15 * k;
      const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      const la = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const ll = vrm.humanoid?.getNormalizedBoneNode("leftLowerArm");
      const rl = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm");
      const rest = basePoseRest || {};
      if (hips && rest.hips) {
        hips.rotation.y = rest.hips.y + sway;
        hips.rotation.z = rest.hips.z + Math.sin(beat) * 0.08 * k;
        hips.position.y = bob;
      }
      if (spine && rest.spine) {
        spine.rotation.y = rest.spine.y - sway * 0.5;
      }
      if (la && rest.leftUpperArm) {
        la.rotation.z = rest.leftUpperArm.z + Math.sin(beat) * 0.4 * k;
        la.rotation.x = rest.leftUpperArm.x - 0.5 * k;
      }
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z + Math.cos(beat) * 0.4 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.5 * k;
      }
      if (ll && rest.leftLowerArm) {
        ll.rotation.x = rest.leftLowerArm.x - Math.abs(Math.sin(beat)) * 0.6 * k;
      }
      if (rl && rest.rightLowerArm) {
        rl.rotation.x = rest.rightLowerArm.x - Math.abs(Math.cos(beat)) * 0.6 * k;
      }
    },
  },
  gira: {
    duration: 3.0,
    apply(vrm, t, total) {
      const turn = (t / total) * Math.PI * 2;
      const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
      const rest = basePoseRest || {};
      if (hips && rest.hips) {
        hips.rotation.y = rest.hips.y + turn;
      }
    },
  },
  ven: {
    duration: 2.8,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const wave = Math.sin(t * 4);
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const rl = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm");
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      const rest = basePoseRest || {};
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z - 1.0 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.6 * k;
      }
      if (rl && rest.rightLowerArm) {
        rl.rotation.x = rest.rightLowerArm.x - 1.2 * k + wave * 0.4 * k;
      }
      if (spine && rest.spine) {
        spine.rotation.x = rest.spine.x + 0.2 * k;
      }
    },
  },
  alegria: {
    duration: 2.4,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const bob = Math.abs(Math.sin(t * 6)) * 0.1 * k;
      const la = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      const rest = basePoseRest || {};
      if (la && rest.leftUpperArm) {
        la.rotation.z = rest.leftUpperArm.z + 1.6 * k;
        la.rotation.x = rest.leftUpperArm.x - 0.6 * k;
      }
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z - 1.6 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.6 * k;
      }
      if (hips && rest.hips) hips.position.y = bob;
      if (spine && rest.spine) {
        spine.rotation.x = rest.spine.x - 0.15 * k;
      }
    },
  },
  // FASE 7 · pensativa — mano derecha al mentón, cabeza inclinada (mientras Gemini procesa)
  pensativa: {
    duration: 3.4,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const head = vrm.humanoid?.getNormalizedBoneNode("head");
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const rl = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm");
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      const rest = basePoseRest || {};
      if (head && rest.head) {
        head.rotation.z = rest.head.z + 0.18 * k;
        head.rotation.x = rest.head.x - 0.12 * k;
      }
      if (neck && rest.neck) neck.rotation.z = rest.neck.z + 0.08 * k;
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z - 1.25 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.55 * k;
      }
      if (rl && rest.rightLowerArm) {
        rl.rotation.x = rest.rightLowerArm.x - 1.55 * k;
      }
      if (spine && rest.spine) spine.rotation.x = rest.spine.x - 0.05 * k;
    },
  },
  // FASE 7 · alternativo — balanceo idle alterno (cadera + brazos suaves)
  alternativo: {
    duration: 4.2,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const sway = Math.sin(t * 1.6) * 0.18 * k;
      const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      const la = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const rest = basePoseRest || {};
      if (hips && rest.hips) hips.rotation.y = rest.hips.y + sway;
      if (spine && rest.spine) spine.rotation.y = rest.spine.y - sway * 0.4;
      if (la && rest.leftUpperArm) {
        la.rotation.x = rest.leftUpperArm.x - 0.18 * k;
        la.rotation.z = rest.leftUpperArm.z + Math.sin(t * 1.6) * 0.18 * k;
      }
      if (ra && rest.rightUpperArm) {
        ra.rotation.x = rest.rightUpperArm.x - 0.18 * k;
        ra.rotation.z = rest.rightUpperArm.z - Math.sin(t * 1.6) * 0.18 * k;
      }
    },
  },
  // FASE 7 · posec — pose tímida (manos delante, ligero giro de hombros)
  posec: {
    duration: 4.0,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      const head = vrm.humanoid?.getNormalizedBoneNode("head");
      const la = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const ll = vrm.humanoid?.getNormalizedBoneNode("leftLowerArm");
      const rl = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm");
      const rest = basePoseRest || {};
      if (hips && rest.hips) hips.rotation.y = rest.hips.y - 0.12 * k;
      if (spine && rest.spine) spine.rotation.y = rest.spine.y + 0.18 * k;
      if (head && rest.head) head.rotation.z = rest.head.z - 0.12 * k;
      if (la && rest.leftUpperArm) {
        la.rotation.z = rest.leftUpperArm.z + 0.45 * k;
        la.rotation.x = rest.leftUpperArm.x - 0.55 * k;
      }
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z - 0.45 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.55 * k;
      }
      if (ll && rest.leftLowerArm) ll.rotation.x = rest.leftLowerArm.x - 1.0 * k;
      if (rl && rest.rightLowerArm) rl.rotation.x = rest.rightLowerArm.x - 1.0 * k;
    },
  },
  // FASE 7 · heart — gesto de afecto (manos al pecho formando corazón)
  heart: {
    duration: 3.6,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const beat = Math.abs(Math.sin(t * 4)) * 0.06 * k;
      const la = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const ll = vrm.humanoid?.getNormalizedBoneNode("leftLowerArm");
      const rl = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm");
      const lh = vrm.humanoid?.getNormalizedBoneNode("leftHand");
      const rh = vrm.humanoid?.getNormalizedBoneNode("rightHand");
      const head = vrm.humanoid?.getNormalizedBoneNode("head");
      const rest = basePoseRest || {};
      if (la && rest.leftUpperArm) {
        la.rotation.z = rest.leftUpperArm.z + 0.95 * k;
        la.rotation.x = rest.leftUpperArm.x - 0.85 * k;
      }
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z - 0.95 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.85 * k;
      }
      if (ll && rest.leftLowerArm) ll.rotation.x = rest.leftLowerArm.x - 1.45 * k;
      if (rl && rest.rightLowerArm) rl.rotation.x = rest.rightLowerArm.x - 1.45 * k;
      if (lh && rest.leftHand) lh.rotation.z = rest.leftHand.z - 0.6 * k;
      if (rh && rest.rightHand) rh.rotation.z = rest.rightHand.z + 0.6 * k;
      if (head && rest.head) head.rotation.x = rest.head.x - beat;
      if (vrm.expressionManager) vrm.expressionManager.setValue("happy", 0.6 * k);
    },
  },
  // FASE 6 · cansancio (bostezo) — brazo derecho a la boca + cabeza atrás
  bostezar: {
    duration: 3.6,
    apply(vrm, t, total) {
      const k = Math.sin((t / total) * Math.PI);
      const head = vrm.humanoid?.getNormalizedBoneNode("head");
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
      const rl = vrm.humanoid?.getNormalizedBoneNode("rightLowerArm");
      const rh = vrm.humanoid?.getNormalizedBoneNode("rightHand");
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      const rest = basePoseRest || {};
      if (head && rest.head) head.rotation.x = rest.head.x - 0.35 * k;
      if (neck && rest.neck) neck.rotation.x = rest.neck.x - 0.15 * k;
      if (ra && rest.rightUpperArm) {
        ra.rotation.z = rest.rightUpperArm.z - 1.1 * k;
        ra.rotation.x = rest.rightUpperArm.x - 0.6 * k;
      }
      if (rl && rest.rightLowerArm) {
        rl.rotation.x = rest.rightLowerArm.x - 1.6 * k;
      }
      if (rh && rest.rightHand) rh.rotation.z = rest.rightHand.z + 0.4 * k;
      if (spine && rest.spine) spine.rotation.x = rest.spine.x - 0.1 * k;
      if (vrm.expressionManager) {
        vrm.expressionManager.setValue("aa", k);
      }
    },
  },
};

let activeGesture = null;
let gestureStartedAt = 0;

function playGesture(name) {
  if (!GESTURES[name]) return;
  if (!currentVrm) return;
  activeGesture = name;
  gestureStartedAt = performance.now();
  console.log(`[gesture] play "${name}"`);
}

function tickGesture() {
  if (!activeGesture || !currentVrm) return;
  const def = GESTURES[activeGesture];
  if (!def) {
    activeGesture = null;
    return;
  }
  const t = (performance.now() - gestureStartedAt) / 1000;
  if (t >= def.duration) {
    activeGesture = null;
    return;
  }
  def.apply(currentVrm, t, def.duration);
}

// =============================================================================
// CHAT UI
// =============================================================================

const chatLog = document.getElementById("chat-log");
const chatBar = document.getElementById("chat-bar");
const chatInput = document.getElementById("chat-input");

function appendMessage(text, sender, opts = {}) {
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
  } else if (sender === "system") {
    msg.textContent = text;
  } else {
    msg.textContent = text;
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      const att = document.createElement("div");
      att.className = "chat-attachment";
      for (const a of opts.attachments) {
        const line = document.createElement("div");
        line.textContent = `📎 ${a.name} · ${formatBytes(a.size)}`;
        att.appendChild(line);
        if (a.previewUrl) {
          const img = document.createElement("img");
          img.src = a.previewUrl;
          img.className = "att-thumb";
          img.alt = a.name;
          att.appendChild(img);
        }
      }
      msg.appendChild(att);
    }
  }

  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msg;
}

function setBubbleText(bubble, text) {
  if (!bubble) return;
  const textEl = bubble.querySelector(".bubble-text");
  if (textEl) textEl.textContent = text;
  else bubble.textContent = text;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// =============================================================================
// LIP-SYNC + TTS (idéntico a antes, con ligeros ajustes)
// =============================================================================

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
    "female", "mujer", "mónica", "monica", "paulina", "marisol", "esperanza",
    "sabina", "helena", "lucia", "lucía", "sara", "laura", "carmen", "elvira",
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
  } catch (err) {
    console.warn("[speech] no se pudo desbloquear:", err);
  }
  speechPrimed = true;
}

function doSpeak(text) {
  const voices = speechSynthesis.getVoices() || [];
  cachedVoices = voices;
  const voice = pickSpanishFemaleVoice();

  const utter = new SpeechSynthesisUtterance(text);
  if (voice) utter.voice = voice;
  utter.lang = voice?.lang || "es-ES";
  utter.rate = 1.0;
  utter.pitch = 1.1;

  utter.onstart = () => simulateLipSync();
  utter.onend = () => stopLipSync();
  utter.onerror = (event) => {
    console.warn("[speech] onerror:", event.error);
    stopLipSync();
    fallbackLipSync(text);
  };

  speechSynthesis.speak(utter);
}

function speakResponse(text) {
  if (typeof speechSynthesis === "undefined") {
    fallbackLipSync(text);
    return;
  }

  try {
    speechSynthesis.pause();
    speechSynthesis.resume();
    speechSynthesis.cancel();
  } catch (err) {
    /* ignore */
  }
  stopLipSync();

  if (!text) return;

  const voices = speechSynthesis.getVoices() || [];
  if (voices.length === 0) {
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
      doSpeak(text);
    }, 1500);
    return;
  }

  doSpeak(text);
}

function reactHappy(durationMs = 2000) {
  if (!currentVrm || !currentVrm.expressionManager) return;
  currentVrm.expressionManager.setValue("happy", 1);
  if (happyTimeoutId !== null) clearTimeout(happyTimeoutId);
  happyTimeoutId = window.setTimeout(() => {
    if (currentVrm && currentVrm.expressionManager) {
      currentVrm.expressionManager.setValue("happy", 0);
    }
    happyTimeoutId = null;
  }, durationMs);
}

// =============================================================================
// FASE 4 · COMANDOS DE ACCIÓN Y REGALOS
// =============================================================================

const ACTION_TRIGGERS = {
  saluda: ["saluda", "salúdame", "saludame", "/saluda", "saludo", "hola", "buenas", "qué tal", "que tal"],
  baila: ["baila", "danza", "/baila", "bailame"],
  gira: ["gira", "/gira", "da una vuelta", "vuélta", "vuelta"],
  ven: ["ven", "/ven", "ven aquí", "ven aqui", "acércate", "acercate"],
  heart: [
    "te quiero", "te amo", "te adoro", "manda corazón", "manda corazon",
    "dame amor", "/heart", "/corazon", "heart",
  ],
  pensativa: ["piensa", "piénsalo", "pensativa", "/pensativa"],
};

// FASE 7 · sinónimos de armario: cualquier frase que coincida cambia outfit.
// El primer match gana; orden de mayor a menor especificidad.
const WARDROBE_SYNONYMS = [
  // pijama / dormir / cómodo
  { outfit: "pijama", patterns: [
    "pijama", "piyama", "ponte el pijama", "ponte la pijama",
    "ropa de dormir", "ponte algo cómodo", "ponte algo comodo",
    "modo dormir", "vamos a dormir",
  ]},
  // maid
  { outfit: "maid", patterns: [
    "maid", "mucama", "sirvienta", "ponte de maid", "ponte de mucama",
    "modo maid",
  ]},
  // cosplay
  { outfit: "cosplay", patterns: [
    "cosplay", "ponte el cosplay", "modo cosplay", "disfraz",
  ]},
  // sexy / ropa de baño
  { outfit: "sexy1", patterns: [
    "ropa de baño", "ropa de bano", "bañador", "banador", "bikini",
    "traje de baño", "traje de bano", "playa", "ponte sexy", "modo sexy",
    "ropa atrevida",
  ]},
  { outfit: "sexy2", patterns: [
    "sexy 2", "otra sexy", "más sexy", "mas sexy",
  ]},
  // casual aleatorio
  { outfit: "__casual_random__", patterns: [
    "ropa casual", "casual", "ponte casual", "ropa de calle",
    "ropa de estudio", "ropa cómoda", "ropa comoda", "cámbiate", "cambiate",
    "cambio de ropa", "otra ropa",
  ]},
  // explicítos
  { outfit: "casual1", patterns: ["casual 1", "outfit 1"] },
  { outfit: "casual2", patterns: ["casual 2", "outfit 2"] },
  { outfit: "casual3", patterns: ["casual 3", "outfit 3"] },
  { outfit: "hina", patterns: ["modo default", "ropa original", "tu ropa de siempre"] },
];

function detectWardrobeCommand(textLower) {
  for (const entry of WARDROBE_SYNONYMS) {
    for (const p of entry.patterns) {
      const re = new RegExp(`(^|\\s|\\W)${p.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(\\W|$)`, "i");
      if (re.test(textLower)) {
        let outfit = entry.outfit;
        if (outfit === "__casual_random__") {
          const pool = ["casual1", "casual2", "casual3"].filter((c) => c !== currentOutfit);
          outfit = pool[Math.floor(Math.random() * pool.length)];
        }
        return outfit;
      }
    }
  }
  return null;
}

// FASE 7+ · "préstame la ropa de X" / "usa la textura de X" / "intercambia ropa con X"
// Detecta el outfit objetivo y devuelve su clave; null si no aplica.
const TEXTURE_BORROW_TRIGGERS = [
  /pr(é|e)stame\s+(la\s+)?(ropa|textura)\s+(de\s+)?(la\s+)?(\w+)/i,
  /usa\s+(la\s+)?(ropa|textura)\s+(de\s+)?(la\s+)?(\w+)/i,
  /intercambia\s+(ropa|textura)\s+con\s+(la\s+)?(\w+)/i,
  /toma\s+prestada?\s+(la\s+)?(ropa|textura)\s+(de\s+)?(la\s+)?(\w+)/i,
  /con\s+la\s+ropa\s+de\s+(la\s+)?(\w+)/i,
  // "ponte la ropa de la maid" → cambia SOLO la textura del modelo actual
  /ponte\s+la\s+ropa\s+de\s+(la\s+|el\s+)?(\w+)/i,
];

// FASE 8 · "cámbiate a X" / "cambia al modelo X" → carga el .vrm completo.
// Esto es estrictamente DISTINTO a "ponte la ropa de X" (que solo cambia textura).
const VRM_LOAD_TRIGGERS = [
  /c(á|a)mbiate\s+a(l|\s+la)?\s+(\w+)/i,
  /cambia\s+(al?|la)?\s*modelo\s+(\w+)/i,
  /carga\s+(el|la)?\s*(modelo\s+)?(\w+)/i,
];

function detectVrmLoadCommand(text) {
  for (const re of VRM_LOAD_TRIGGERS) {
    const m = text.match(re);
    if (!m) continue;
    const candidate = m[m.length - 1]?.toLowerCase();
    if (!candidate) continue;
    const out = BORROW_NAME_TO_OUTFIT[candidate];
    if (out && WARDROBE[out]) return out;
  }
  return null;
}
const BORROW_NAME_TO_OUTFIT = {
  maid: "maid", mucama: "maid", sirvienta: "maid",
  cosplay: "cosplay", disfraz: "cosplay",
  pijama: "pijama", piyama: "pijama",
  sexy: "sexy1", "sexy2": "sexy2",
  bikini: "sexy1", "bañador": "sexy1", "banador": "sexy1",
  casual: "casual1", "casual1": "casual1", "casual2": "casual2", "casual3": "casual3",
  hina: "hina", default: "hina",
};

function detectTextureBorrow(text) {
  for (const re of TEXTURE_BORROW_TRIGGERS) {
    const m = text.match(re);
    if (!m) continue;
    // el último grupo capturado es el nombre del outfit
    const candidate = m[m.length - 1]?.toLowerCase();
    if (!candidate) continue;
    const out = BORROW_NAME_TO_OUTFIT[candidate];
    if (out && WARDROBE[out]) return out;
  }
  return null;
}

const FOOD_GIFT_WORDS = [
  "pizza", "hamburguesa", "sushi", "ramen", "fideos", "pollo", "ceviche",
  "anticucho", "arroz", "papa", "papas", "chocolate", "chocolates",
  "dulce", "dulces", "caramelo", "caramelos", "torta", "pastel", "pasteles",
  "galleta", "galletas", "donut", "donuts", "donas", "helado", "helados",
  "cupcake", "cupcakes", "café", "cafe", "té", "te verde", "manzana",
  "fresa", "fresas", "fruta", "frutas", "comida", "almuerzo", "cena",
  "desayuno", "panqueque", "panqueques", "macarons", "bombón", "bombones",
  "queque", "alfajor", "alfajores", "picarones", "suspiro",
];

function detectActionCommand(textLower) {
  for (const [name, triggers] of Object.entries(ACTION_TRIGGERS)) {
    for (const t of triggers) {
      const re = new RegExp(`(^|\\s|\\W)${t.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(\\W|$)`, "i");
      if (re.test(textLower)) return name;
    }
  }
  return null;
}

function detectGiftCommand(text) {
  const t = text.trim();
  const m = /^\/regalar\b\s*(.*)$/i.exec(t);
  if (!m) return null;
  const item = m[1].trim();
  const lower = item.toLowerCase();
  const isFood = FOOD_GIFT_WORDS.some((w) =>
    new RegExp(`(^|\\W)${w}(\\W|$)`, "i").test(lower),
  );
  return { item: item || "algo", isFood };
}

// =============================================================================
// FASE 6 · CONTEXTO LOCAL DE PIURA (clima + hora) — Open-Meteo (sin API key)
// =============================================================================

const PIURA_LAT = -5.1945;
const PIURA_LON = -80.6328;
const PIURA_TZ = "America/Lima";
const WEATHER_REFRESH_MS = 30 * 60 * 1000; // 30 min

const WEATHER_CODE_ES = {
  0: "despejado", 1: "casi despejado", 2: "parcialmente nublado", 3: "nublado",
  45: "neblina", 48: "neblina con escarcha",
  51: "llovizna ligera", 53: "llovizna", 55: "llovizna intensa",
  61: "lluvia ligera", 63: "lluvia", 65: "lluvia fuerte",
  66: "lluvia helada ligera", 67: "lluvia helada fuerte",
  71: "nieve ligera", 73: "nieve", 75: "nieve intensa",
  77: "granos de nieve",
  80: "chubasco ligero", 81: "chubasco", 82: "chubasco fuerte",
  85: "nevada ligera", 86: "nevada intensa",
  95: "tormenta", 96: "tormenta con granizo ligero",
  99: "tormenta con granizo fuerte",
};

let piuraContext = {
  city: "Piura, Perú",
  tempC: null,
  conditionCode: null,
  conditionEs: null,
  fetchedAt: 0,
};

function piuraLocalDate() {
  // Hora local de Lima (UTC-5) para que Hina sepa si es día/noche aunque
  // el navegador esté en otra zona horaria.
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: PIURA_TZ }),
  );
}

function piuraDayPart() {
  const h = piuraLocalDate().getHours();
  if (h < 6) return "madrugada";
  if (h < 12) return "mañana";
  if (h < 19) return "tarde";
  return "noche";
}

async function fetchPiuraWeather() {
  if (Date.now() - piuraContext.fetchedAt < WEATHER_REFRESH_MS) return;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${PIURA_LAT}` +
      `&longitude=${PIURA_LON}&current=temperature_2m,weather_code` +
      `&timezone=${encodeURIComponent(PIURA_TZ)}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const t = d?.current?.temperature_2m;
    const code = d?.current?.weather_code;
    if (Number.isFinite(t)) piuraContext.tempC = Math.round(t * 10) / 10;
    if (Number.isFinite(code)) {
      piuraContext.conditionCode = code;
      piuraContext.conditionEs = WEATHER_CODE_ES[code] || "clima estable";
    }
    piuraContext.fetchedAt = Date.now();
    console.log("[piura] clima:", piuraContext);
  } catch (err) {
    console.warn("[piura] no se pudo leer el clima:", err.message);
    // simulamos un fallback razonable para Piura (cálido/seco)
    piuraContext.tempC = piuraContext.tempC ?? 26;
    piuraContext.conditionEs = piuraContext.conditionEs ?? "cálido";
    piuraContext.fetchedAt = Date.now();
  }
}

function buildLocalContext() {
  const d = piuraLocalDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return {
    city: piuraContext.city,
    timezone: PIURA_TZ,
    localTime: `${hh}:${mm}`,
    dayPart: piuraDayPart(),
    weekday: d.toLocaleDateString("es-PE", { weekday: "long" }),
    tempC: piuraContext.tempC,
    weather: piuraContext.conditionEs,
    energy: energyLevel,
  };
}

// arrancamos la consulta pronto para tenerla lista al primer mensaje
fetchPiuraWeather();
window.setInterval(fetchPiuraWeather, WEATHER_REFRESH_MS);

// =============================================================================
// FASE 6 · SISTEMA DE VITALIDAD (energyLevel + sugerencia de descanso)
// =============================================================================

const ENERGY_STORAGE_KEY = "hina.energy.v1";
const ENERGY_MAX = 100;
const ENERGY_MIN = 0;
const ENERGY_DECAY_PER_MSG = 1.2;       // cae con cada turno
const ENERGY_RECOVER_PER_MIN = 0.6;     // recupera con descanso (idle)
const ENERGY_TIRED_THRESHOLD = 35;
const ENERGY_EXHAUSTED_THRESHOLD = 15;
const ENERGY_YAWN_COOLDOWN_MS = 90 * 1000;

let energyLevel = ENERGY_MAX;
let energyLastUpdateAt = Date.now();
let lastYawnAt = 0;
let lastRestSuggestionAt = 0;

function loadEnergy() {
  try {
    const raw = localStorage.getItem(ENERGY_STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (Number.isFinite(p?.energy)) energyLevel = clampEnergy(p.energy);
    if (Number.isFinite(p?.lastUpdateAt)) energyLastUpdateAt = p.lastUpdateAt;
  } catch (err) {
    console.warn("[energy] no se pudo leer:", err);
  }
}
function persistEnergy() {
  try {
    localStorage.setItem(
      ENERGY_STORAGE_KEY,
      JSON.stringify({ energy: energyLevel, lastUpdateAt: energyLastUpdateAt }),
    );
  } catch (err) {
    console.warn("[energy] no se pudo guardar:", err);
  }
}
function clampEnergy(n) {
  if (!Number.isFinite(n)) return ENERGY_MAX;
  return Math.max(ENERGY_MIN, Math.min(ENERGY_MAX, Math.round(n * 100) / 100));
}
function recoverEnergyByIdle() {
  const idleMin = (Date.now() - energyLastUpdateAt) / 60000;
  if (idleMin <= 0) return;
  energyLevel = clampEnergy(energyLevel + idleMin * ENERGY_RECOVER_PER_MIN);
  energyLastUpdateAt = Date.now();
}
function consumeEnergyForMessage() {
  recoverEnergyByIdle();
  energyLevel = clampEnergy(energyLevel - ENERGY_DECAY_PER_MSG);
  energyLastUpdateAt = Date.now();
  persistEnergy();
  console.log(`[energy] nivel=${energyLevel.toFixed(1)}`);
}
function maybeYawnIfTired() {
  if (energyLevel >= ENERGY_TIRED_THRESHOLD) return false;
  if (activeGesture) return false;
  if (Date.now() - lastYawnAt < ENERGY_YAWN_COOLDOWN_MS) return false;
  lastYawnAt = Date.now();
  playGesture("bostezar");
  return true;
}
function buildRestSuggestion() {
  if (energyLevel >= ENERGY_TIRED_THRESHOLD) return "";
  if (Date.now() - lastRestSuggestionAt < 5 * 60 * 1000) return "";
  lastRestSuggestionAt = Date.now();
  if (energyLevel <= ENERGY_EXHAUSTED_THRESHOLD) {
    return "Estoy agotada… deberíamos parar un rato. Toma agua y descansa.";
  }
  return "Llevamos rato hablando. Si quieres seguimos en un momento, ¿sí?";
}

loadEnergy();
recoverEnergyByIdle();
console.log(`[energy] inicio: nivel=${energyLevel.toFixed(1)}`);

// =============================================================================
// FASE 6 · /musica — reproductor Lofi (YouTube embed)
// =============================================================================

const LOFI_PLAYLISTS = [
  {
    id: "jfKfPfyJRdk",
    title: "Lofi Girl · beats to relax/study",
  },
  {
    id: "rUxyKA_-grg",
    title: "Lofi Girl · sleepy beats",
  },
];

function getMusicOverlay() {
  return document.getElementById("music-overlay");
}

function openMusicOverlay(query = "") {
  const overlay = getMusicOverlay();
  if (!overlay) return;
  // Permitir /musica <id-de-youtube> o /musica <título>
  let track = LOFI_PLAYLISTS[0];
  const q = (query || "").trim().toLowerCase();
  if (q) {
    if (/^[\w-]{8,15}$/.test(q)) {
      track = { id: q, title: `Pista personalizada (${q})` };
    } else {
      const found = LOFI_PLAYLISTS.find((p) =>
        p.title.toLowerCase().includes(q),
      );
      if (found) track = found;
    }
  }
  const iframe = document.getElementById("music-iframe");
  const titleEl = document.getElementById("music-title");
  if (iframe) {
    iframe.src =
      `https://www.youtube.com/embed/${track.id}` +
      `?autoplay=1&rel=0&modestbranding=1`;
  }
  if (titleEl) titleEl.textContent = track.title;
  overlay.classList.add("visible");
}

function closeMusicOverlay() {
  const overlay = getMusicOverlay();
  if (!overlay) return;
  const iframe = document.getElementById("music-iframe");
  if (iframe) iframe.src = "";
  overlay.classList.remove("visible");
}

function detectMusicCommand(text) {
  const m = /^\/musica\b\s*(.*)$/i.exec(text.trim());
  if (!m) return null;
  const arg = m[1].trim();
  if (/^(off|stop|cerrar|cierra|apagar)$/i.test(arg)) return { action: "off" };
  return { action: "on", query: arg };
}

// =============================================================================
// FASE 3 · ADJUNTOS (cámara, archivos, audio)
// =============================================================================

const cameraInput = document.getElementById("camera-input");
const fileInput = document.getElementById("file-input");
const cameraBtn = document.getElementById("camera-btn");
const fileBtn = document.getElementById("file-btn");
const micBtn = document.getElementById("mic-btn");
const attachmentPreview = document.getElementById("attachment-preview");

const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB total per envío
const pendingAttachments = []; // { name, mime, size, base64, previewUrl? }

function renderAttachmentChips() {
  if (!attachmentPreview) return;
  attachmentPreview.innerHTML = "";
  if (pendingAttachments.length === 0) {
    attachmentPreview.classList.remove("visible");
    return;
  }
  attachmentPreview.classList.add("visible");
  pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const name = document.createElement("span");
    name.className = "att-name";
    name.textContent = `${att.name} · ${formatBytes(att.size)}`;
    chip.appendChild(name);
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", "Quitar adjunto");
    x.textContent = "×";
    x.addEventListener("click", () => {
      pendingAttachments.splice(idx, 1);
      renderAttachmentChips();
    });
    chip.appendChild(x);
    attachmentPreview.appendChild(chip);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const i = result.indexOf(",");
      resolve(i >= 0 ? result.slice(i + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function totalAttachedBytes() {
  return pendingAttachments.reduce((acc, a) => acc + (a.size || 0), 0);
}

async function addFilesToAttachments(filesList, opts = {}) {
  const fromCamera = Boolean(opts.fromCamera);
  for (const file of filesList) {
    if (!file) continue;
    if (totalAttachedBytes() + file.size > MAX_TOTAL_BYTES) {
      appendMessage(
        `No puedo adjuntar "${file.name}" (excede 25 MB en total).`,
        "system",
      );
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      const att = {
        name: file.name || "archivo",
        mime: file.type || "application/octet-stream",
        size: file.size || 0,
        base64,
        fromCamera,
      };
      if (att.mime.startsWith("image/")) {
        att.previewUrl = `data:${att.mime};base64,${base64}`;
      }
      pendingAttachments.push(att);
    } catch (err) {
      console.warn("[attach] no pude leer:", file.name, err);
      appendMessage(`No pude leer "${file.name}".`, "system");
    }
  }
  renderAttachmentChips();
}

if (cameraBtn && cameraInput) {
  cameraBtn.addEventListener("click", () => {
    cameraInput.value = "";
    cameraInput.click();
  });
  cameraInput.addEventListener("change", async (event) => {
    const files = event.target.files;
    if (!files || !files.length) return;
    // FASE 6 · marcamos los archivos venidos de la cámara para empatía visual
    await addFilesToAttachments(files, { fromCamera: true });
  });
}

if (fileBtn && fileInput) {
  fileBtn.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", async (event) => {
    const files = event.target.files;
    if (!files || !files.length) return;
    await addFilesToAttachments(files);
  });
}

// =============================================================================
// FASE 6 · ESCUCHA ACTIVA — Web Speech API (con fallback a grabación de audio)
// =============================================================================
//
// Tap mic → Hina escucha por voz, transcribe y envía el texto automáticamente.
// Si el navegador no soporta SpeechRecognition (Safari sin habilitar, Firefox)
// volvemos a la grabación tipo MediaRecorder y la mandamos como adjunto.

const SpeechRecognitionImpl =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

let speechRecognition = null;
let speechRecognizing = false;
let speechFinalTranscript = "";

let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;

function setMicListeningUi(on) {
  if (!micBtn) return;
  micBtn.classList.toggle("recording", on);
  micBtn.setAttribute(
    "aria-label",
    on ? "Detener escucha" : "Hablar con Hina (dictado por voz)",
  );
  micBtn.setAttribute(
    "title",
    on ? "Detener escucha" : "Hablar (Web Speech API)",
  );
}

function startSpeechRecognition() {
  if (!SpeechRecognitionImpl) return false;
  if (speechRecognizing) return true;
  try {
    speechRecognition = new SpeechRecognitionImpl();
  } catch (err) {
    console.warn("[voz] no se pudo crear SpeechRecognition:", err);
    return false;
  }
  speechRecognition.lang = "es-PE";
  speechRecognition.interimResults = true;
  speechRecognition.continuous = false;
  speechRecognition.maxAlternatives = 1;
  speechFinalTranscript = "";

  speechRecognition.onstart = () => {
    speechRecognizing = true;
    setMicListeningUi(true);
    if (chatInput) chatInput.placeholder = "Escuchándote…";
  };
  speechRecognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const r = event.results[i];
      if (r.isFinal) speechFinalTranscript += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (chatInput) {
      chatInput.value = (speechFinalTranscript + interim).trim();
    }
  };
  speechRecognition.onerror = (event) => {
    console.warn("[voz] error:", event.error);
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      appendMessage(
        "No me diste permiso para usar el micrófono.",
        "system",
      );
    } else if (event.error === "no-speech") {
      appendMessage("No escuché nada. Intenta de nuevo.", "system");
    }
  };
  speechRecognition.onend = () => {
    speechRecognizing = false;
    setMicListeningUi(false);
    if (chatInput) chatInput.placeholder = "Escribe un mensaje…";
    const text = speechFinalTranscript.trim();
    speechFinalTranscript = "";
    if (text.length > 0) {
      // Auto-envío del texto reconocido (manos libres)
      handleUserMessage(text);
    }
  };
  try {
    speechRecognition.start();
    return true;
  } catch (err) {
    console.warn("[voz] start falló:", err);
    speechRecognizing = false;
    setMicListeningUi(false);
    return false;
  }
}

function stopSpeechRecognition() {
  if (speechRecognition && speechRecognizing) {
    try { speechRecognition.stop(); } catch {}
  }
}

// Fallback: grabación clásica si el navegador no soporta SpeechRecognition
async function startRecordingFallback() {
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  if (!navigator.mediaDevices?.getUserMedia) {
    appendMessage("Tu navegador no permite grabar audio.", "system");
    return;
  }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.warn("[mic] permiso denegado:", err);
    appendMessage("No me diste permiso para usar el micrófono.", "system");
    return;
  }
  recordedChunks = [];
  let mime = "audio/webm";
  if (window.MediaRecorder?.isTypeSupported?.("audio/webm;codecs=opus")) {
    mime = "audio/webm;codecs=opus";
  } else if (window.MediaRecorder?.isTypeSupported?.("audio/mp4")) {
    mime = "audio/mp4";
  }
  try {
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType: mime });
  } catch (err) {
    console.warn("[mic] mime no soportado, fallback default:", err);
    mediaRecorder = new MediaRecorder(recordingStream);
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    recordedChunks = [];
    if (recordingStream) {
      recordingStream.getTracks().forEach((t) => t.stop());
      recordingStream = null;
    }
    const ext = blob.type.includes("mp4") ? "m4a" : "webm";
    const file = new File([blob], `nota-voz.${ext}`, { type: blob.type });
    await addFilesToAttachments([file]);
  };
  mediaRecorder.start();
  setMicListeningUi(true);
}

function stopRecordingFallback() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  setMicListeningUi(false);
}

if (micBtn) {
  micBtn.addEventListener("click", () => {
    if (SpeechRecognitionImpl) {
      if (speechRecognizing) stopSpeechRecognition();
      else startSpeechRecognition();
    } else {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        stopRecordingFallback();
      } else {
        startRecordingFallback();
      }
    }
  });
  if (!SpeechRecognitionImpl) {
    micBtn.setAttribute(
      "title",
      "Tu navegador no soporta dictado: se grabará un mensaje de voz",
    );
  }
}

// =============================================================================
// LLAMADAS A LA API
// =============================================================================

async function postChatOnce(payload) {
  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (parseErr) {
    console.error("[chat] respuesta no-JSON:", response.status, rawText);
    throw new Error(`Respuesta no-JSON (HTTP ${response.status})`);
  }

  if (response.status === 401) {
    handleUnauthorized();
    throw new Error("no autorizado");
  }
  if (!response.ok) {
    const detail = data?.error ? ` - ${data.error}` : "";
    const err = new Error(`HTTP ${response.status}${detail}`);
    err.status = response.status;
    throw err;
  }

  const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
  if (!reply) throw new Error("Respuesta sin 'reply'");
  // El servidor puede haber redirigido a otro cerebro por error 401/429/500.
  // Avisamos al usuario y actualizamos el indicador visual sin perder el flujo.
  if (data?.brainUsed && data.brainUsed !== currentBrain) {
    notifyBrainSwitchedByFallback(currentBrain, data.brainUsed);
  }
  return reply;
}

async function askGemini(userText) {
  const payload = {
    message: userText,
    brain: currentBrain,
    affectionScore,
    history: chatHistory.slice(-HISTORY_WINDOW),
    memory: distilledMemoryForServer(),
    context: buildLocalContext(),
  };
  try {
    return await postChatOnce(payload);
  } catch (err) {
    if (err?.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      return await postChatOnce(payload);
    }
    throw err;
  }
}

async function analyzeWithFiles(userText, attachments) {
  const cameraEmpathy = attachments.some(
    (a) => a.fromCamera && (a.mime || "").startsWith("image/"),
  );
  const payload = {
    message: userText,
    brain: currentBrain,
    affectionScore,
    memory: distilledMemoryForServer(),
    context: buildLocalContext(),
    cameraEmpathy,
    files: attachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      data: a.base64,
    })),
  };
  const response = await fetch(ANALYZE_ENDPOINT, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401) {
    handleUnauthorized();
    throw new Error("no autorizado");
  }
  if (!response.ok) {
    const detail = data?.error ? ` - ${data.error}` : "";
    const err = new Error(`HTTP ${response.status}${detail}`);
    err.status = response.status;
    throw err;
  }
  const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
  if (!reply) throw new Error("Respuesta sin 'reply'");
  if (data?.brainUsed && data.brainUsed !== currentBrain && !data?.forcedGemini) {
    notifyBrainSwitchedByFallback(currentBrain, data.brainUsed);
  }
  return reply;
}

async function requestSummary() {
  const recent = chatHistory.slice(-6);
  if (recent.length < 2) return;
  try {
    const response = await fetch(SUMMARIZE_ENDPOINT, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        history: recent,
        userName: memory.profile?.name || "el usuario",
      }),
    });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    const summary =
      typeof data?.summary === "string" ? data.summary.trim() : "";
    if (!summary) return;
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

// =============================================================================
// FLUJO PRINCIPAL DE MENSAJES
// =============================================================================

async function handleUserMessage(text) {
  const trimmed = text.trim();
  if (!trimmed && pendingAttachments.length === 0) return;
  if (!authToken) {
    showLockOverlay("Necesitas escribir la frase clave para hablar con Hina.");
    return;
  }

  primeSpeech();
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  stopLipSync();

  // FASE 6 · /musica — totalmente local, no toca a Gemini
  const music = detectMusicCommand(trimmed);
  if (music && pendingAttachments.length === 0) {
    appendMessage(trimmed, "user");
    chatInput.value = "";
    if (music.action === "off") {
      closeMusicOverlay();
      const r = "Apagué la música. Sigamos.";
      appendMessage(r, "bot");
      pushHistory("model", r);
      speakResponse(r);
    } else {
      openMusicOverlay(music.query);
      const r = music.query
        ? `Pongo "${music.query}" para acompañarte.`
        : "Pongo lofi para estudiar. Tú concéntrate, yo te acompaño.";
      appendMessage(r, "bot");
      pushHistory("model", r);
      speakResponse(r);
    }
    return;
  }

  const attachments = pendingAttachments.splice(0, pendingAttachments.length);
  renderAttachmentChips();

  registerInteraction(trimmed);

  const visibleAttachments = attachments.map((a) => ({
    name: a.name,
    size: a.size,
    previewUrl: a.previewUrl,
  }));

  appendMessage(trimmed || "(sin texto)", "user", {
    attachments: visibleAttachments,
  });
  chatInput.value = "";
  pushHistory(
    "user",
    attachments.length
      ? `${trimmed || "(sin texto)"} [adjuntos: ${attachments.map((a) => a.name).join(", ")}]`
      : trimmed,
  );

  memory.totalUserMessages = (memory.totalUserMessages || 0) + 1;
  persistMemory();

  // FASE 4 · /regalar
  const gift = detectGiftCommand(trimmed);
  if (gift && attachments.length === 0) {
    if (gift.isFood) {
      bumpAffection(AFFECT_GIFT_DELTA, `regalo: ${gift.item}`);
      playGesture("alegria");
      reactHappy(2400);
      const reply = `¡${gift.item}! Mmm, gracias… eso me alegra muchísimo.`;
      appendMessage(reply, "bot");
      pushHistory("model", reply);
      speakResponse(reply);
    } else {
      const reply = `Mm, ¿"${gift.item}"? Lo aprecio, pero hoy me apetece algo dulce o de comer.`;
      appendMessage(reply, "bot");
      pushHistory("model", reply);
      speakResponse(reply);
    }
    return;
  }

  // FASE 8 · "cámbiate a X" → carga estricta del .vrm completo
  const loadTarget = detectVrmLoadCommand(trimmed);
  if (loadTarget && attachments.length === 0) {
    if (loadTarget === currentOutfit) {
      const r = `Pero si ya soy esa.`;
      appendMessage(r, "bot");
      pushHistory("model", r);
      speakResponse(r);
      return;
    }
    const def = WARDROBE[loadTarget];
    const r = `Voy, me cambio a ${def.label.toLowerCase()}.`;
    appendMessage(r, "bot");
    pushHistory("model", r);
    speakResponse(r);
    loadOutfit(loadTarget);
    return;
  }

  // FASE 7+ · "préstame la ropa de X" / "ponte la ropa de X" → solo textura
  const borrowSource = detectTextureBorrow(trimmed);
  if (borrowSource && attachments.length === 0) {
    const def = WARDROBE[borrowSource];
    const r = `A ver, te enseño cómo me queda lo de ${def.label.toLowerCase()}.`;
    appendMessage(r, "bot");
    pushHistory("model", r);
    speakResponse(r);
    borrowTexturesFrom(borrowSource).then((ok) => {
      if (!ok) {
        appendMessage("(*No pude tomar prestada esa textura.*)", "system");
      }
    });
    return;
  }

  // FASE 7 · cambio de armario por sinónimo o comando explícito.
  // Si en el mismo mensaje viene además una acción, encadenamos:
  //   "ponte el cosplay y salúdame" → cargar cosplay → esperar → playGesture("saluda")
  const lower = trimmed.toLowerCase();
  const wardrobePick = detectWardrobeCommand(lower);
  const combinedAction = detectActionCommand(lower);
  if (wardrobePick && attachments.length === 0) {
    if (wardrobePick === currentOutfit && !combinedAction) {
      const r = `Pero si ya llevo eso puesto. ¿Quieres otra cosa?`;
      appendMessage(r, "bot");
      pushHistory("model", r);
      speakResponse(r);
      return;
    }
    const def = WARDROBE[wardrobePick];
    let reply;
    if (wardrobePick === currentOutfit && combinedAction) {
      reply = "Listo, voy.";
    } else if (combinedAction) {
      reply = `Bien, me cambio a ${def.label.toLowerCase()} y enseguida te lo enseño.`;
    } else {
      reply = `Bien, me cambio a ${def.label.toLowerCase()}.`;
    }
    appendMessage(reply, "bot");
    pushHistory("model", reply);
    speakResponse(reply);
    // promesa: detener gesto actual → cargar VRM → ejecutar acción cuando esté listo
    if (activeGesture) {
      // se interrumpe el gesto actual de forma suave
      activeGesture = null;
    }
    (async () => {
      const ok = wardrobePick === currentOutfit ? true : await loadOutfit(wardrobePick);
      if (ok && combinedAction) {
        // pequeño respiro para que la barra desaparezca antes del gesto
        setTimeout(() => playGesture(combinedAction), 250);
      }
    })();
    return;
  }

  // FASE 4/7 · acciones (sin cambio de ropa)
  const action = detectActionCommand(trimmed.toLowerCase());
  if (action && attachments.length === 0) {
    playGesture(action);
    const responses = {
      saluda: ["¡Hola!", "Te saludo.", "Hey, hola."],
      baila: ["¡A bailar!", "Mira mis pasos.", "¿Qué tal este ritmo?"],
      gira: ["Una vuelta.", "Mírame.", "Lista."],
      ven: ["Voy.", "Aquí estoy.", "Acércate tú también."],
      heart: ["Para ti.", "Mi corazón es tuyo.", "Te lo mando.", "Toma."],
      pensativa: ["Mmm…", "Déjame pensarlo.", "A ver…"],
    };
    const list = responses[action] || ["Hecho."];
    const reply = list[Math.floor(Math.random() * list.length)];
    appendMessage(reply, "bot");
    pushHistory("model", reply);
    speakResponse(reply);
    return;
  }

  // FASE 6 · vitalidad: cada turno que va a Gemini consume energía
  consumeEnergyForMessage();

  const thinkingBubble = appendMessage("Hina está pensando…", "bot");

  // FASE 7 · si la consulta es larga (probablemente "difícil"), juega "pensativa"
  // mientras Gemini procesa. Para preguntas cortas, no la dispares (sería ruido).
  if (!activeGesture && (trimmed.length > 80 || /\?/.test(trimmed))) {
    playGesture("pensativa");
  }

  try {
    const replyRaw = attachments.length
      ? await analyzeWithFiles(trimmed, attachments)
      : await askGemini(trimmed);

    // Si está cansada, agrega una sugerencia de descanso y bosteza
    let reply = replyRaw;
    const restHint = buildRestSuggestion();
    if (restHint) reply = `${replyRaw}\n\n${restHint}`;
    const yawned = maybeYawnIfTired();

    if (thinkingBubble) setBubbleText(thinkingBubble, reply);
    else appendMessage(reply, "bot");
    pushHistory("model", reply);
    if (!yawned) reactHappy(3000);
    speakResponse(reply);

    if (memory.totalUserMessages % SUMMARY_EVERY_N_USER_MSGS === 0) {
      requestSummary();
    }
  } catch (error) {
    console.error("Error consultando a Gemini:", error);
    let errorText;
    if (error?.status === 429) {
      errorText = "Demasiados mensajes seguidos, dame un respiro un momento.";
    } else if (error?.message === "no autorizado") {
      errorText = "Sesión expirada. Vuelve a escribir la frase clave.";
    } else {
      const detail = error?.message ? ` (${error.message})` : "";
      errorText = `Hina tuvo un pequeño problema de conexión${detail}`;
    }
    if (thinkingBubble) setBubbleText(thinkingBubble, errorText);
    else appendMessage(errorText, "bot");
  }
}

function showInitialGreeting() {
  if (!chatLog) return;
  const lvl = affectionLevel(affectionScore);
  let greeting;
  if (!memory.profile?.name) {
    greeting =
      "Hola. No sé quién eres todavía. Si quieres, dime tu nombre.";
  } else if (lvl === "distant") {
    greeting = `Hola, ${memory.profile.name}. Sigo sin conocerte bien, así que iré con calma.`;
  } else if (lvl === "confidant") {
    greeting = `Hola, ${memory.profile.name}. Me alegra verte por aquí.`;
  } else if (lvl === "affectionate") {
    greeting = `Hola, ${memory.profile.name}. ¿Cómo va tu día? Me preocupo por ti.`;
  } else {
    greeting = `¡${memory.profile.name}! Te estaba esperando.`;
  }

  // FASE 7 · menciona el clima de Piura si lo tenemos
  if (Number.isFinite(piuraContext.tempC)) {
    const cond = piuraContext.conditionEs || "estable";
    greeting += ` Aquí en Piura ahora hay ${piuraContext.tempC}°C, ${cond}.`;
    // FASE 7+ · sugerencia por calor
    if (piuraContext.tempC > 30) {
      greeting += " Hace un calor pesado, ¿quieres que me ponga algo más fresco?";
    }
  }

  appendMessage(greeting, "bot");
  pushHistory("model", greeting);

  // FASE 7 · saludo automático al iniciar sesión
  playGesture("saluda");

  // FASE 7 · auto-Lofi si el clima es tranquilo
  maybeAutoplayLofi();
}

// FASE 7 · si el clima de Piura está tranquilo, abre el reproductor lofi
const CALM_WEATHER_CODES = new Set([0, 1, 2, 3, 45, 48]); // despejado/nublado/neblina
let lofiAutoplayed = false;
function maybeAutoplayLofi() {
  if (lofiAutoplayed) return;
  if (!Number.isFinite(piuraContext.conditionCode)) return;
  if (!CALM_WEATHER_CODES.has(piuraContext.conditionCode)) return;
  // si la temperatura es muy alta (>32) tampoco lo lances solo, no encaja
  if (Number.isFinite(piuraContext.tempC) && piuraContext.tempC > 32) return;
  lofiAutoplayed = true;
  // delay para no cortar el saludo TTS
  setTimeout(() => openMusicOverlay(""), 1500);
}

// =============================================================================
// EVENTOS UI
// =============================================================================

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

const unlockOnFirstTouch = () => primeSpeech();
window.addEventListener("pointerdown", unlockOnFirstTouch, { once: true });
window.addEventListener("keydown", unlockOnFirstTouch, { once: true });

// =============================================================================
// LOCK OVERLAY (frase clave)
// =============================================================================

const lockOverlay = document.getElementById("lock-overlay");
const lockForm = document.getElementById("lock-form");
const lockInput = document.getElementById("lock-input");
const lockBtn = document.getElementById("lock-btn");
const lockError = document.getElementById("lock-error");

function showLockOverlay(message = "") {
  if (!lockOverlay) return;
  lockOverlay.classList.remove("hidden");
  if (lockError) lockError.textContent = message || "";
  if (lockInput) {
    lockInput.value = "";
    setTimeout(() => lockInput.focus(), 50);
  }
}

function hideLockOverlay() {
  if (lockOverlay) lockOverlay.classList.add("hidden");
}

function handleUnauthorized() {
  authToken = null;
  persistAuth(null);
  showLockOverlay("Sesión expirada. Vuelve a escribir la frase clave.");
}

async function attemptUnlock(passphrase) {
  if (!passphrase) {
    if (lockError) lockError.textContent = "Escribe la frase clave.";
    return;
  }
  lockBtn.disabled = true;
  if (lockError) lockError.textContent = "";
  try {
    const token = await verifyPassphrase(passphrase);
    authToken = token;
    persistAuth(token);
    hideLockOverlay();
    if (info) info.textContent = "Hina lista";
    if (chatLog && chatLog.children.length === 0) showInitialGreeting();
  } catch (err) {
    console.warn("[auth] fallo:", err);
    if (lockError) {
      lockError.textContent = err?.message || "Acceso denegado.";
    }
    authToken = null;
    persistAuth(null);
  } finally {
    lockBtn.disabled = false;
  }
}

if (lockForm) {
  lockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    attemptUnlock(lockInput?.value || "");
  });
}

async function bootstrapAuth() {
  loadStoredAuth();
  if (!authToken) {
    showLockOverlay();
    return;
  }
  // Validate stored token
  try {
    const ok = await verifyPassphrase(authToken);
    authToken = ok;
    persistAuth(ok);
    hideLockOverlay();
    if (chatLog && chatLog.children.length === 0) showInitialGreeting();
  } catch (err) {
    console.warn("[auth] token guardado inválido:", err);
    authToken = null;
    persistAuth(null);
    showLockOverlay();
  }
}

// FASE 6 · botón de cierre del reproductor
const musicCloseBtn = document.getElementById("music-close");
if (musicCloseBtn) {
  musicCloseBtn.addEventListener("click", () => closeMusicOverlay());
}

bootstrapAuth();

// =============================================================================
// LOOP DE RENDERIZADO (idle: respiración + parpadeo + gestos)
// =============================================================================

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.elapsedTime;

  if (currentVrm) {
    const spine = currentVrm.humanoid?.getNormalizedBoneNode("spine");
    if (spine && !activeGesture) {
      // respiración idle (solo si no estamos en un gesto activo)
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

    tickGesture();

    currentVrm.update(delta);
  }

  // FASE 7 · cámara anclada al hueso de la cabeza (J_Bip_C_Head)
  // así no se pierde la vista frontal al bailar, girar o cambiar de ropa.
  if (headBoneRef) {
    const worldPos = new THREE.Vector3();
    headBoneRef.getWorldPosition(worldPos);
    worldPos.add(HEAD_OFFSET);
    // suavizado para que el cambio de outfit no haga "brincar" la cámara
    controls.target.lerp(worldPos, 0.18);
  }

  // FASE 7 · animaciones autónomas (cada 45s, mientras esté quieta)
  tickAutonomousAnimations();

  controls.update();
  renderer.render(scene, camera);
}

animate();
