import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// FASE 8.4.1 · LAZY LOADING — el FBXLoader (~70 KB + dep fflate) y el parser
// VMD se cargan sólo cuando el usuario realmente sube un archivo de animación.
// Esto evita que el arranque del visor dependa de módulos pesados que pueden
// fallar en CDN y dejar a Hina inalcanzable (boot loop / 502 percibido).
let _fbxLoaderPromise = null;
function loadFbxLoaderLazy() {
  if (!_fbxLoaderPromise) {
    _fbxLoaderPromise = import("three/addons/loaders/FBXLoader.js")
      .then((m) => m.FBXLoader)
      .catch((err) => {
        _fbxLoaderPromise = null; // permite reintento si falla la red
        throw err;
      });
  }
  return _fbxLoaderPromise;
}

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

// =============================================================================
// FASE 8.4 · MODO TUTORA UNIVERSAL DE IDIOMAS (estado en cliente)
// =============================================================================
// Se persiste en localStorage. Se manda al servidor en cada /chat y /analyze.
// Si está en "off", no se cambia nada del prompt.
const TUTOR_STORAGE_KEY = "hina.tutor.v1";
const TUTOR_CYCLE = ["off", "auto", "ja", "ko", "en", "zh", "ru", "de", "fr", "it", "pt", "ar"];
const TUTOR_LABELS = {
  off:  "OFF",
  auto: "Auto",
  ja:   "日本語",
  ko:   "한국어",
  en:   "English",
  zh:   "中文",
  ru:   "Русский",
  de:   "Deutsch",
  fr:   "Français",
  it:   "Italiano",
  pt:   "Português",
  ar:   "العربية",
};
let tutorLanguage = "off";
function loadStoredTutor() {
  try {
    const v = localStorage.getItem(TUTOR_STORAGE_KEY);
    if (TUTOR_CYCLE.includes(v)) tutorLanguage = v;
  } catch {}
}
function persistTutor() {
  try { localStorage.setItem(TUTOR_STORAGE_KEY, tutorLanguage); } catch {}
}
function tutorPayloadForServer() {
  if (tutorLanguage === "off") return null;
  return { mode: true, language: tutorLanguage };
}
function refreshTutorToggleUi() {
  const btn = document.getElementById("tutor-toggle-btn");
  if (!btn) return;
  btn.dataset.tutor = tutorLanguage;
  btn.textContent = `🎓 Tutora: ${TUTOR_LABELS[tutorLanguage] || tutorLanguage}`;
  btn.title = tutorLanguage === "off"
    ? "Modo Tutora desactivado · click para elegir idioma"
    : `Tutora activa (${TUTOR_LABELS[tutorLanguage]}) · click para cambiar idioma`;
}
function cycleTutor() {
  const i = TUTOR_CYCLE.indexOf(tutorLanguage);
  const next = TUTOR_CYCLE[(i + 1) % TUTOR_CYCLE.length];
  tutorLanguage = next;
  persistTutor();
  refreshTutorToggleUi();
  if (typeof appendMessage === "function") {
    if (next === "off") {
      appendMessage("(*Tutora de idiomas: desactivada.*)", "system");
    } else {
      appendMessage(`(*Tutora de idiomas: ${TUTOR_LABELS[next]}. Hina enseña con traducción y pronunciación.*)`, "system");
    }
  }
}
loadStoredTutor();

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

// FASE 8.3 · Emanuel es el dueño del proyecto: su nombre se siembra por
// defecto para que Hina lo recuerde aunque sea su primera vez en el navegador.
const DEFAULT_MEMORY = {
  profile: {
    name: "Emanuel",
  },
  highestAffectionReached: AFFECT_INITIAL,
  highestLevelReached: "distant",
  summaries: [],
  totalUserMessages: 0,
  lastSeenAt: null,
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

// FASE 8.2.1 · Inicialización defensiva del renderer.
// En algunos navegadores (Xiaomi con "ahorro de datos", Chrome sin GPU,
// pestañas que ya consumieron sus contextos WebGL) el primer intento puede
// fallar. Probamos primero con calidad alta y degradamos a un perfil mínimo.
function createRendererSafe() {
  // perfil 1: calidad alta
  try {
    return new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: false,
    });
  } catch (e) {
    console.warn("[renderer] perfil alto falló, probando bajo:", e);
  }
  // perfil 2: ahorro (sin AA, sin alpha)
  try {
    return new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: false,
      precision: "mediump",
    });
  } catch (e) {
    console.error("[renderer] WebGL no disponible:", e);
    return null;
  }
}

const renderer = createRendererSafe();
if (!renderer) {
  // muestra un mensaje claro al usuario en lugar de quedar en negro;
  // el chat y el resto de la UI siguen funcionando.
  const banner = document.createElement("div");
  banner.style.cssText =
    "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
    "max-width:340px;padding:18px;border-radius:12px;z-index:9999;" +
    "background:rgba(20,20,35,.95);color:#fff;border:1px solid rgba(255,255,255,.18);" +
    "font:13px/1.4 system-ui;text-align:center;backdrop-filter:blur(10px);";
  banner.innerHTML =
    "<b>WebGL no disponible</b><br><br>" +
    "Tu navegador no pudo crear el contexto 3D para mostrar a Hina. " +
    "Cierra otras pestañas pesadas, desactiva el modo ahorro de datos " +
    "y vuelve a entrar.<br><br>El chat sigue funcionando.";
  document.body.appendChild(banner);
  throw new Error("WebGL context creation failed");
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// si el contexto WebGL se pierde más tarde (RAM agotada en Xiaomi al cargar
// otro modelo), avisamos en consola en lugar de quedar en negro.
renderer.domElement.addEventListener("webglcontextlost", (ev) => {
  ev.preventDefault();
  console.warn("[renderer] contexto WebGL perdido");
});
renderer.domElement.addEventListener("webglcontextrestored", () => {
  console.log("[renderer] contexto WebGL restaurado");
});

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
// FASE 8.4 · BIBLIOTECA DE ANIMACIONES EXTERNAS (.vmd / .fbx)
// -----------------------------------------------------------------------------
// El usuario sube archivos .vmd (MikuMikuDance) o .fbx (Mixamo y similares).
// Se guardan offline en IndexedDB para que sobrevivan a recargas, y se mapean
// automáticamente al esqueleto humanoide del VRM activo.
// Disparo por voz/texto: "baila baile_kpop" o "anima saludo_grande" etc.
// =============================================================================

// --- Mapas de retargeting ---------------------------------------------------
// MMD usa nombres japoneses; los mapeamos a huesos humanoides VRM.
const MMD_TO_VRM_BONE = {
  "全ての親":   null,            // master, lo ignoramos
  "センター":   "hips",           // center → cadera (incluye traslación)
  "上半身":     "spine",
  "上半身2":    "chest",
  "首":         "neck",
  "頭":         "head",
  "左肩":       "leftShoulder",
  "左腕":       "leftUpperArm",
  "左ひじ":     "leftLowerArm",
  "左手首":     "leftHand",
  "右肩":       "rightShoulder",
  "右腕":       "rightUpperArm",
  "右ひじ":     "rightLowerArm",
  "右手首":     "rightHand",
  "左足":       "leftUpperLeg",
  "左ひざ":     "leftLowerLeg",
  "左足首":     "leftFoot",
  "左つま先":   "leftToes",
  "右足":       "rightUpperLeg",
  "右ひざ":     "rightLowerLeg",
  "右足首":     "rightFoot",
  "右つま先":   "rightToes",
};

// FBX (Mixamo y rigs equivalentes) → VRM. Toleramos prefijos como "mixamorig:".
const FBX_TO_VRM_BONE = {
  Hips:           "hips",
  Spine:          "spine",
  Spine1:         "chest",
  Spine2:         "upperChest",
  Neck:           "neck",
  Head:           "head",
  LeftShoulder:   "leftShoulder",
  LeftArm:        "leftUpperArm",
  LeftForeArm:    "leftLowerArm",
  LeftHand:       "leftHand",
  RightShoulder:  "rightShoulder",
  RightArm:       "rightUpperArm",
  RightForeArm:   "rightLowerArm",
  RightHand:      "rightHand",
  LeftUpLeg:      "leftUpperLeg",
  LeftLeg:        "leftLowerLeg",
  LeftFoot:       "leftFoot",
  LeftToeBase:    "leftToes",
  RightUpLeg:     "rightUpperLeg",
  RightLeg:       "rightLowerLeg",
  RightFoot:      "rightFoot",
  RightToeBase:   "rightToes",
};

function stripFbxPrefix(name) {
  // "mixamorig:Hips", "mixamorig1:Hips", "Armature|Hips" → "Hips"
  let n = String(name || "");
  n = n.replace(/^mixamorig\d*:/i, "");
  n = n.replace(/^Armature\|/i, "");
  return n;
}

// --- Parser binario VMD (sin dependencias externas) -------------------------
// Formato VMD: header 30b + nombre modelo 20b + nº motions u32 LE +
// motions[110b] = boneName(15b SJIS) + frame u32 + pos(3·f32) + rot(4·f32) + curva(64b).
// MMD usa coordenadas left-handed → invertimos Z en posición y signos en y/z del quat.
let _sjisDecoder = null;
function getSjisDecoder() {
  if (_sjisDecoder) return _sjisDecoder;
  try { _sjisDecoder = new TextDecoder("shift-jis", { fatal: false }); }
  catch { _sjisDecoder = new TextDecoder("utf-8", { fatal: false }); }
  return _sjisDecoder;
}

function parseVmd(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const dec = getSjisDecoder();
  if (arrayBuffer.byteLength < 50) throw new Error("VMD demasiado corto");
  const head = dec.decode(new Uint8Array(arrayBuffer, 0, 30));
  if (!head.startsWith("Vocaloid Motion Data")) {
    throw new Error("No parece un .vmd válido");
  }
  let off = 50;
  const motionCount = view.getUint32(off, true); off += 4;
  const motions = [];
  for (let i = 0; i < motionCount; i++) {
    if (off + 111 > arrayBuffer.byteLength) break;
    const nameBytes = new Uint8Array(arrayBuffer, off, 15);
    let nl = 0;
    while (nl < 15 && nameBytes[nl] !== 0) nl++;
    const boneName = dec.decode(nameBytes.slice(0, nl));
    off += 15;
    const frame = view.getUint32(off, true); off += 4;
    const px = view.getFloat32(off, true); off += 4;
    const py = view.getFloat32(off, true); off += 4;
    const pz = view.getFloat32(off, true); off += 4;
    const qx = view.getFloat32(off, true); off += 4;
    const qy = view.getFloat32(off, true); off += 4;
    const qz = view.getFloat32(off, true); off += 4;
    const qw = view.getFloat32(off, true); off += 4;
    off += 64; // skip interpolation curve
    motions.push({ boneName, frame, px, py, pz, qx, qy, qz, qw });
  }
  return { motions };
}

// Convierte VMD parseado → AnimationClip aplicado al VRM activo.
// Sólo retargeteamos huesos cuyo nombre japonés exista en el mapa, así no
// rompemos físicas/cabello del VRM.
function buildClipFromVmd(vmd, vrm) {
  if (!vrm?.humanoid) throw new Error("VRM sin humanoid");
  const FPS = 30;
  // Agrupamos motions por bone target VRM
  const byVrmBone = new Map();
  for (const m of vmd.motions) {
    const vrmBoneName = MMD_TO_VRM_BONE[m.boneName];
    if (!vrmBoneName) continue;
    let arr = byVrmBone.get(vrmBoneName);
    if (!arr) { arr = []; byVrmBone.set(vrmBoneName, arr); }
    arr.push(m);
  }
  const tracks = [];
  let maxTime = 0;
  for (const [vrmBoneName, list] of byVrmBone) {
    const bone = vrm.humanoid.getRawBoneNode(vrmBoneName);
    if (!bone) continue;
    list.sort((a, b) => a.frame - b.frame);
    const times = new Float32Array(list.length);
    const quats = new Float32Array(list.length * 4);
    let needsPosition = vrmBoneName === "hips";
    const pos = needsPosition ? new Float32Array(list.length * 3) : null;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const t = m.frame / FPS;
      times[i] = t;
      if (t > maxTime) maxTime = t;
      // MMD → Three: invertir Z (left-handed → right-handed)
      quats[i*4 + 0] = m.qx;
      quats[i*4 + 1] = -m.qy;
      quats[i*4 + 2] = -m.qz;
      quats[i*4 + 3] = m.qw;
      if (pos) {
        // MMD trabaja en ~8 unidades = 1 metro (modelo PMX típico). Escalamos
        // y sumamos la posición de descanso del hueso para no teletransportar
        // a Hina al origen del mundo.
        const SCALE = 0.08;
        pos[i*3 + 0] = bone.position.x + m.px * SCALE;
        pos[i*3 + 1] = bone.position.y + m.py * SCALE;
        pos[i*3 + 2] = bone.position.z + (-m.pz) * SCALE;
      }
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, quats));
    if (pos) {
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, pos));
    }
  }
  if (!tracks.length) throw new Error("VMD no contiene huesos compatibles con el rig");
  return new THREE.AnimationClip("vmd_clip", maxTime > 0 ? maxTime : -1, tracks);
}

// Convierte un AnimationClip de FBX (ya cargado por FBXLoader) en un clip
// reescrito para los huesos del VRM. Mapeamos nombres y descartamos tracks
// de huesos que no existan en el rig humanoide.
function retargetFbxClip(clip, vrm) {
  if (!vrm?.humanoid) throw new Error("VRM sin humanoid");
  const newTracks = [];
  for (const track of clip.tracks) {
    // track.name = "<boneName>.<property>" o "<boneName>.<property>[<index>]"
    const dot = track.name.indexOf(".");
    if (dot < 0) continue;
    const rawBoneName = stripFbxPrefix(track.name.slice(0, dot));
    const propPart = track.name.slice(dot); // ".quaternion" / ".position"
    const vrmBoneName = FBX_TO_VRM_BONE[rawBoneName];
    if (!vrmBoneName) continue;
    // Sólo cadera puede mover posición — el resto sólo rota.
    if (propPart.startsWith(".position") && vrmBoneName !== "hips") continue;
    const bone = vrm.humanoid.getRawBoneNode(vrmBoneName);
    if (!bone) continue;
    let cloned = track.clone();
    cloned.name = `${bone.name}${propPart}`;
    if (propPart.startsWith(".position") && vrmBoneName === "hips") {
      // Mixamo suele exportar en cm (1 unidad ≈ 1 cm). Escalamos a metros y
      // re-anclamos sobre la posición de descanso del hueso real.
      const SCALE = 0.01;
      const v = cloned.values;
      for (let i = 0; i < v.length; i += 3) {
        v[i + 0] = bone.position.x + v[i + 0] * SCALE;
        v[i + 1] = bone.position.y + v[i + 1] * SCALE;
        v[i + 2] = bone.position.z + v[i + 2] * SCALE;
      }
    }
    newTracks.push(cloned);
  }
  if (!newTracks.length) throw new Error("FBX no contiene huesos compatibles con el rig");
  return new THREE.AnimationClip("fbx_clip", clip.duration, newTracks);
}

// --- Persistencia offline en IndexedDB --------------------------------------
const ANIM_DB_NAME = "hina-anim-lib";
const ANIM_DB_STORE = "animations";
const ANIM_DB_VERSION = 1;
let _animDbPromise = null;

// FASE 8.4.1 · SAFE-LOAD — cualquier cuelgue / bloqueo del IndexedDB del
// navegador (modo privado, cuota llena, perfil corrupto) NO debe impedir que el
// visor arranque. Por eso openAnimDb() tiene timeout duro de 4 s y todos los
// callers ya envuelven en try/catch + warn (la app sigue funcional sin lib).
function openAnimDb() {
  if (_animDbPromise) return _animDbPromise;
  _animDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB no disponible"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      _animDbPromise = null; // permite reintento manual luego
      reject(new Error("IndexedDB tardó demasiado en abrir (timeout 4 s)"));
    }, 4000);
    let req;
    try {
      req = indexedDB.open(ANIM_DB_NAME, ANIM_DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      _animDbPromise = null;
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(ANIM_DB_STORE)) {
          db.createObjectStore(ANIM_DB_STORE, { keyPath: "name" });
        }
      } catch (err) {
        console.warn("[anim-lib] upgrade falló", err);
      }
    };
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _animDbPromise = null;
      reject(req.error || new Error("IndexedDB error"));
    };
    req.onblocked = () => {
      console.warn("[anim-lib] IndexedDB blocked (otra pestaña tiene una versión vieja)");
    };
  });
  return _animDbPromise;
}

async function idbSaveAnim(record) {
  const db = await openAnimDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ANIM_DB_STORE, "readwrite");
    tx.objectStore(ANIM_DB_STORE).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbListAnims() {
  const db = await openAnimDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ANIM_DB_STORE, "readonly");
    const out = [];
    const cursor = tx.objectStore(ANIM_DB_STORE).openCursor();
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        const v = c.value;
        out.push({ name: v.name, type: v.type, size: v.bytes?.byteLength || 0 });
        c.continue();
      } else {
        resolve(out);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

async function idbGetAnim(name) {
  const db = await openAnimDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ANIM_DB_STORE, "readonly");
    const req = tx.objectStore(ANIM_DB_STORE).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDeleteAnim(name) {
  const db = await openAnimDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ANIM_DB_STORE, "readwrite");
    tx.objectStore(ANIM_DB_STORE).delete(name);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// --- AnimationMixer + ciclo de vida -----------------------------------------
let currentMixer = null;
let currentAction = null;
let currentMixerVrm = null;
let customAnimPlaying = false;

function disposeCurrentMixer() {
  if (!currentMixer) return;
  try {
    currentMixer.stopAllAction();
    if (currentMixerVrm?.scene) currentMixer.uncacheRoot(currentMixerVrm.scene);
    if (currentAction?.getClip) currentMixer.uncacheClip(currentAction.getClip());
  } catch (err) {
    console.warn("[mixer] dispose:", err);
  }
  currentMixer = null;
  currentAction = null;
  currentMixerVrm = null;
  customAnimPlaying = false;
}

function playClipOnVrm(clip, vrm, { name = "custom", loop = false } = {}) {
  if (!clip || !vrm) return false;
  disposeCurrentMixer();
  // Detén cualquier gesto procedural; el mixer toma el control de los huesos.
  activeGesture = null;
  currentMixer = new THREE.AnimationMixer(vrm.scene);
  currentMixerVrm = vrm;
  const action = currentMixer.clipAction(clip);
  action.reset();
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
  action.clampWhenFinished = false;
  action.enabled = true;
  action.play();
  currentAction = action;
  customAnimPlaying = true;
  // Cuando termine, libera el mixer para devolver a Hina sus poses idle.
  const onFinish = () => {
    currentMixer?.removeEventListener("finished", onFinish);
    disposeCurrentMixer();
    // suaviza vuelta a la pose de descanso si seguimos con la misma Hina
    try { if (currentVrm) applyDefaultRestPose(currentVrm); } catch {}
  };
  currentMixer.addEventListener("finished", onFinish);
  console.log(`[anim] playing "${name}" (loop=${loop})`);
  return true;
}

// Carga desde un File (input del usuario) o un ArrayBuffer (desde IndexedDB).
async function loadAnimationFromBytes(name, type, bytes, vrm, opts = {}) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (type === "vmd") {
    const vmd = parseVmd(buf);
    const clip = buildClipFromVmd(vmd, vrm);
    return playClipOnVrm(clip, vrm, { name, loop: opts.loop ?? false });
  }
  if (type === "fbx") {
    let FBXLoaderCtor;
    try {
      FBXLoaderCtor = await loadFbxLoaderLazy();
    } catch (err) {
      throw new Error("No pude descargar el cargador FBX (revisa tu conexión).");
    }
    const fbxLoader = new FBXLoaderCtor();
    const obj = fbxLoader.parse(buf, "");
    const sourceClip = obj.animations?.[0];
    if (!sourceClip) throw new Error("FBX sin animaciones");
    const clip = retargetFbxClip(sourceClip, vrm);
    return playClipOnVrm(clip, vrm, { name, loop: opts.loop ?? false });
  }
  throw new Error(`Tipo desconocido: ${type}`);
}

// Registry en memoria (refresca botón con el conteo).
const animRegistry = new Map(); // name → { type, size }
function refreshAnimUiBadge() {
  const btn = document.getElementById("anim-upload-btn");
  if (!btn) return;
  const n = animRegistry.size;
  if (n > 0) {
    btn.classList.add("has-anims");
    btn.textContent = `💃 Animaciones (${n})`;
    btn.title = `${n} animación(es) guardadas. Click para añadir más. Para reproducirla di "baila <nombre>".`;
  } else {
    btn.classList.remove("has-anims");
    btn.textContent = "💃 Cargar Animación";
    btn.title = "Subir animación .vmd o .fbx (se guarda offline)";
  }
}

async function reloadAnimRegistry() {
  try {
    const items = await idbListAnims();
    animRegistry.clear();
    for (const it of items) animRegistry.set(it.name, { type: it.type, size: it.size });
    refreshAnimUiBadge();
  } catch (err) {
    console.warn("[anim-lib] no se pudo leer IndexedDB:", err);
  }
}

// "anim_baile_kpop.vmd" → "baile_kpop". Se normaliza para hacer match suave.
function deriveAnimName(filename) {
  const dot = filename.lastIndexOf(".");
  let base = dot > 0 ? filename.slice(0, dot) : filename;
  base = base.replace(/^anim[_-]/i, "").trim();
  return base.toLowerCase().replace(/\s+/g, "_");
}
function detectAnimExtension(filename) {
  const m = /\.(vmd|fbx)$/i.exec(filename || "");
  return m ? m[1].toLowerCase() : null;
}

// Subir una o varias animaciones.
async function importAnimationFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const files = Array.from(fileList);
  let saved = 0, failed = 0;
  for (const file of files) {
    const ext = detectAnimExtension(file.name);
    if (!ext) { failed++; continue; }
    try {
      showLoadBar(`Procesando ${file.name}…`);
      const buf = await file.arrayBuffer();
      // Validación rápida: intentamos parsear contra un VRM ficticio sólo para
      // VMD (el binario es estricto y rápido). Si falla, no guardamos basura.
      if (ext === "vmd") {
        try { parseVmd(buf); }
        catch (e) { throw new Error(`VMD inválido: ${e.message}`); }
      }
      const name = deriveAnimName(file.name);
      await idbSaveAnim({ name, type: ext, bytes: buf, addedAt: Date.now() });
      animRegistry.set(name, { type: ext, size: buf.byteLength });
      saved++;
      appendMessage(
        `(*Animación guardada como "${name}". Para reproducirla di: "baila ${name}".*)`,
        "system",
      );
    } catch (err) {
      console.error("[anim-lib] no se pudo guardar", file.name, err);
      failed++;
      appendMessage(`(*No pude guardar "${file.name}": ${err.message}*)`, "system");
    } finally {
      hideLoadBar(400);
    }
  }
  refreshAnimUiBadge();
  // Si solo subió una y existe currentVrm, la reproducimos al toque.
  if (saved === 1 && failed === 0 && currentVrm) {
    const lastName = deriveAnimName(files[files.length - 1].name);
    playSavedAnimation(lastName).catch(() => {});
  }
}

async function playSavedAnimation(name) {
  if (!currentVrm) {
    appendMessage("(*No hay modelo cargado para animar.*)", "system");
    return false;
  }
  const norm = String(name || "").toLowerCase().replace(/\s+/g, "_");
  // match exacto, luego match parcial
  let key = animRegistry.has(norm) ? norm : null;
  if (!key) {
    for (const k of animRegistry.keys()) {
      if (k.includes(norm) || norm.includes(k)) { key = k; break; }
    }
  }
  if (!key) {
    appendMessage(`(*No encuentro la animación "${name}". Súbela primero o di "qué animaciones tengo".*)`, "system");
    return false;
  }
  const meta = animRegistry.get(key);
  try {
    showLoadBar(`Cargando animación "${key}"…`);
    const rec = await idbGetAnim(key);
    if (!rec) throw new Error("registro vacío");
    await loadAnimationFromBytes(key, meta.type, rec.bytes, currentVrm, { loop: false });
    hideLoadBar(300);
    return true;
  } catch (err) {
    console.error("[anim-lib] play falló", err);
    hideLoadBar(400);
    appendMessage(`(*No pude reproducir "${key}": ${err.message}*)`, "system");
    return false;
  }
}

// Detector de comando: "baila baile_kpop", "anima saludo_grande",
// "/anim baile_kpop", "reproduce baile_kpop".
// FASE 8.5 · Triggers ampliados — además de "baila X" / "anima X" / "/anim X"
// reconocemos "haz la X", "muestra la X", "ponme la X", "ejecuta la X" para que
// frases como "haz la PoseC" o "muestra Kpop" disparen la animación correcta
// sin importar el modelo activo.
const ANIM_TRIGGERS = [
  /\b(?:baila|b[aá]ilame|danza|bailar)\s+([\p{L}0-9_\- ]{2,40})/iu,
  /\b(?:anima|animaci[oó]n|reproduce|pon|ponme|p[óo]n(?:te|me)?)\s+(?:la\s+animaci[oó]n\s+|la\s+|el\s+)?([\p{L}0-9_\- ]{2,40})/iu,
  /\b(?:haz(?:me)?|hacer|ejecuta|muestra(?:me)?|ens[eé][ñn]ame)\s+(?:la\s+|el\s+|una\s+)?([\p{L}0-9_\- ]{2,40})/iu,
  /^\/anim(?:aci[oó]n)?\s+([\p{L}0-9_\- ]{2,40})/iu,
];

// Lista pública de animaciones guardadas (la consume el cliente para enviarla
// al servidor en el payload, así Hina sabe en tiempo real qué tiene Emanuel).
function listSavedAnimNames() {
  try { return Array.from(animRegistry.keys()); } catch { return []; }
}

function _normalizeAnimCandidate(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function detectSavedAnimCommand(text) {
  if (!text || animRegistry.size === 0) return null;
  for (const re of ANIM_TRIGGERS) {
    const m = re.exec(text);
    if (!m) continue;
    const candidate = _normalizeAnimCandidate(m[1]);
    if (!candidate) continue;
    if (animRegistry.has(candidate)) return candidate;
    for (const k of animRegistry.keys()) {
      if (k.includes(candidate) || candidate.includes(k)) return k;
    }
  }
  // Último recurso: alguna animación guardada aparece como palabra completa
  // dentro del texto (p. ej. "puedes mostrarme posec por favor").
  const lower = text.toLowerCase();
  for (const k of animRegistry.keys()) {
    if (k.length < 3) continue;
    const safe = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${safe}\\b`).test(lower)) return k;
  }
  return null;
}

// FASE 8.4.1 · Pre-carga el registry al arrancar de forma DEFENSIVA: si IndexedDB
// está bloqueado/lleno/no disponible, sólo registramos en consola y seguimos.
// Bajo NINGUNA circunstancia este try debe poder tirar el visor.
try {
  Promise.resolve()
    .then(() => reloadAnimRegistry())
    .catch((err) => console.warn("[anim-lib] boot:", err?.message || err));
} catch (err) {
  console.warn("[anim-lib] boot sync fail:", err?.message || err);
}

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
  // FASE 8.4 · Si había una animación externa montada sobre este VRM, la
  // detenemos y desreferenciamos antes de tirar el modelo. Si no, el mixer
  // queda apuntando a un Object3D huérfano y se acumula RAM al cambiar de
  // outfit varias veces.
  if (currentMixerVrm === vrm) {
    disposeCurrentMixer();
  }
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
  // 3) refresca matrices del rig por si VRM o three las recalculan tarde
  vrm.scene.updateMatrixWorld(true);
}

// FASE 8.2 · PoseGuard (anti-T-pose universal):
// loop que ejecuta normalizeToHinaPose CADA 50 ms durante 4 segundos tras la
// carga de CUALQUIER VRM. Garantiza que los brazos bajen incluso en archivos
// con constraints internas, animaciones embebidas o springbones que tiran de
// los huesos antes de estabilizarse. Se autocancela si:
//   • el usuario cambia de modelo antes de los 4 s
//   • hay un gesto activo (saluda/baila) → no pisamos animaciones reales
let _poseGuardId = null;
function startPoseGuard(vrm, { intervalMs = 50, durationMs = 4000 } = {}) {
  if (_poseGuardId) {
    clearInterval(_poseGuardId);
    _poseGuardId = null;
  }
  const start = Date.now();
  // primera aplicación inmediata, en el mismo tick
  normalizeToHinaPose(vrm);
  const id = setInterval(() => {
    if (currentVrm !== vrm || Date.now() - start > durationMs) {
      clearInterval(id);
      if (_poseGuardId === id) _poseGuardId = null;
      return;
    }
    if (typeof activeGesture !== "undefined" && activeGesture) return;
    normalizeToHinaPose(vrm);
  }, intervalMs);
  _poseGuardId = id;
}
// alias retrocompatible (la versión anterior se llamaba así)
const forcePoseFor3Seconds = startPoseGuard;

// FASE 8.2 · MOTOR DE PELO Y ROPA (VRM SpringBones)
// three-vrm v2 carga springbones automáticamente vía VRMLoaderPlugin y los
// actualiza en cada `vrm.update(delta)`. Esta función:
//   1) loguea la cantidad de joints/colliders detectados (debug en Xiaomi).
//   2) llama a `reset()` para que pelo y ropa caigan a su posición de reposo.
//   3) baja `stiffness` y sube `dragForce` ligeramente cuando son extremos,
//      así el pelo no queda rígido como casco al bailar.
function activateSpringBones(vrm) {
  const mgr = vrm.springBoneManager || vrm.springBoneManager0;
  if (!mgr) {
    console.log("[springbones] modelo sin springbones — pelo estático");
    return;
  }
  try {
    if (typeof mgr.reset === "function") mgr.reset();
    const joints = mgr.joints || mgr.springBoneJoints || [];
    const colliders = mgr.colliderGroups || [];
    let tuned = 0;
    for (const j of joints) {
      const s = j.settings || j;
      if (s && typeof s.stiffness === "number" && s.stiffness > 4) {
        s.stiffness = 4;
        tuned += 1;
      }
      if (s && typeof s.dragForce === "number" && s.dragForce < 0.2) {
        s.dragForce = 0.25;
        tuned += 1;
      }
    }
    console.log(
      `[springbones] activado · joints=${joints.length || joints.size || "?"} colliderGroups=${colliders.length || colliders.size || 0} tuned=${tuned}`,
    );
  } catch (err) {
    console.warn("[springbones] no se pudo afinar:", err);
  }
}

// FASE 8.2 · ANALIZADOR DE EMOCIONES POR BLENDSHAPES
// Lee el texto que va a decir Hina y enciende la expresión que mejor lo
// representa: happy / sad / angry / surprised / relaxed / neutral.
// Usa keywords (rápido y sin llamada a API) y va degradando la expresión.
const EMOTION_KEYWORDS = {
  happy: [
    "jaja", "jeje", "feliz", "alegr", "encanta", "me gusta", "qué lindo",
    "que lindo", "genial", "increíble", "increible", "amo", "te quiero",
    "❤", "💕", "🥰", "😊", "😄",
  ],
  sad: [
    "triste", "lo siento", "perdón", "perdon", "extrañ", "extran",
    "duele", "lloro", "😢", "😞", "💔",
  ],
  angry: [
    "molest", "enoj", "celosa", "celos", "no me gusta que", "ya basta",
    "😠", "😤",
  ],
  surprised: [
    "¿en serio?", "en serio?", "¡qué", "¡que", "wow", "guau", "no puedo creer",
    "😮", "😲", "¡!",
  ],
  relaxed: [
    "tranquil", "descans", "relaj", "respira", "dulces sueños", "buenas noches",
  ],
};

const EMOTION_CHANNELS = ["happy", "sad", "angry", "surprised", "relaxed", "neutral"];

function detectEmotion(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [emo, kws] of Object.entries(EMOTION_KEYWORDS)) {
    let score = 0;
    for (const kw of kws) if (lower.includes(kw)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = emo;
    }
  }
  return best;
}

let _emotionDecayId = null;
function applyEmotion(emo, intensity = 0.85, holdMs = 2200) {
  if (!currentVrm || !currentVrm.expressionManager) return;
  const em = currentVrm.expressionManager;
  // apaga las otras emociones
  for (const ch of EMOTION_CHANNELS) {
    if (ch !== emo) {
      try { em.setValue(ch, 0); } catch {}
    }
  }
  if (!emo) return;
  try { em.setValue(emo, intensity); } catch {}
  if (_emotionDecayId) clearTimeout(_emotionDecayId);
  _emotionDecayId = setTimeout(() => {
    if (!currentVrm || !currentVrm.expressionManager) return;
    try { currentVrm.expressionManager.setValue(emo, 0); } catch {}
  }, holdMs);
}

function expressFromText(text) {
  const emo = detectEmotion(text);
  if (emo) applyEmotion(emo);
}

// FASE 8.2 · APLICAR UNA IMAGEN COMO TEXTURA (.png/.jpg subido por el usuario)
// Aplica el png/jpg sobre TODOS los materiales de ropa del modelo activo.
// Limpia la textura anterior con dispose() y fuerza needsUpdate.
function applyImageAsTexture(imageUrl) {
  if (!currentVrm) return Promise.resolve(false);
  return new Promise((resolve) => {
    const tl = new THREE.TextureLoader();
    tl.load(
      imageUrl,
      (tex) => {
        tex.flipY = false; // VRM/glTF usan flipY=false
        tex.colorSpace = THREE.SRGBColorSpace;
        let count = 0;
        const touched = new Set();
        currentVrm.scene.traverse((obj) => {
          if (!obj.material) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (!m.name) continue;
            touched.add(m);
            if (!isClothMaterial(m.name)) continue;
            if (m.map && m.map !== tex) {
              try { m.map.dispose(); } catch {}
            }
            if (m.shadeMultiplyTexture) {
              try { m.shadeMultiplyTexture.dispose(); } catch {}
              m.shadeMultiplyTexture = null;
            }
            if (m.emissiveMap) {
              try { m.emissiveMap.dispose(); } catch {}
              m.emissiveMap = null;
            }
            m.map = tex;
            m.map.needsUpdate = true;
            m.needsUpdate = true;
            count += 1;
          }
        });
        // marca recompilación en TODO lo demás también
        for (const m of touched) {
          m.needsUpdate = true;
          if (m.map) m.map.needsUpdate = true;
        }
        console.log(`[texture-upload] aplicada en ${count} materiales`);
        resolve(count > 0);
      },
      undefined,
      (err) => {
        console.error("[texture-upload] error", err);
        resolve(false);
      },
    );
  });
}

// FASE 8.2 · CARGAR UN .vrm SUBIDO POR EL USUARIO (reemplaza al modelo activo)
async function loadCustomVrmFromFile(file) {
  if (!file) return false;
  const url = URL.createObjectURL(file);
  const label = `Cargando ${file.name}…`;
  showLoadBar(label);
  if (info) info.textContent = label;
  return new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        if (!vrm) {
          console.error("[vrm-upload] el archivo no es un VRM válido");
          if (info) info.textContent = "Archivo no es un VRM válido";
          hideLoadBar(1500);
          URL.revokeObjectURL(url);
          resolve(false);
          return;
        }
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);
        vrm.scene.traverse((obj) => { obj.frustumCulled = false; });
        VRMUtils.rotateVRM0(vrm);
        if (currentVrm) disposeVrm(currentVrm);
        scene.add(vrm.scene);
        currentVrm = vrm;
        currentOutfit = `__custom__:${file.name}`;
        applyDefaultRestPose(vrm);
        if (vrm.lookAt) vrm.lookAt.target = lookAtTarget;
        captureRestPose(vrm);
        startPoseGuard(vrm, { intervalMs: 50, durationMs: 4000 });
        activateSpringBones(vrm);
        anchorCameraToHead(vrm);
        // FASE 8.5 · Resetea posición/rotación + reconfigura wander para el VRM externo.
        resetWanderForNewVrm(vrm);
        renderWardrobeButtons();
        if (info) info.textContent = `Hina lista (${file.name})`;
        hideLoadBar(500);
        appendMessage(`(*Hina ahora lleva un modelo personalizado: ${file.name}*)`, "system");
        URL.revokeObjectURL(url);
        resolve(true);
      },
      (p) => updateLoadBar(p.loaded || 0, p.total || 0, label),
      (err) => {
        console.error("[vrm-upload] error", err);
        if (info) info.textContent = `Error al cargar ${file.name}`;
        hideLoadBar(1500);
        URL.revokeObjectURL(url);
        resolve(false);
      },
    );
  });
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

// FASE 8.1 · Aplica texturas de un modelo fuente sobre el modelo activo.
// REGLAS DE LIMPIEZA:
//   1) Antes de pisar el `map` actual, llamamos a `dispose()` sobre la textura
//      previa (libera GPU memory en Xiaomi).
//   2) Forzamos `texture.needsUpdate = true` y `material.needsUpdate = true`
//      en TODOS los materiales del modelo, no solo los swapped, para que el
//      VRM recompile shaders y las texturas nuevas se suban a la GPU.
//   3) Si el material es MToon (VRM), también limpiamos `emissiveMap` y
//      `shadeColorTexture` que algunos VRoid usan en lugar de `map`.
function applyClothTextures(vrm, source) {
  if (!source || !source.length) return 0;
  let count = 0;
  const touchedMaterials = new Set();

  vrm.scene.traverse((obj) => {
    if (!obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m.name) continue;
      touchedMaterials.add(m);
      if (!isClothMaterial(m.name)) continue;

      // 1) match exacto por nombre de material
      let pick = source.find((s) => s.materialName === m.name);
      // 2) fallback por categoría (tops/bottoms/dress/...)
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
      if (!pick) continue;

      // 3) dispose() de la textura anterior antes de pisar
      if (m.map && m.map !== pick.texture) {
        try { m.map.dispose(); } catch {}
      }
      m.map = pick.texture;
      m.map.needsUpdate = true;

      if (m.color && pick.color) m.color.copy(pick.color);
      // MToon: limpia mapas auxiliares para que el shader use el nuevo `map`
      if (m.shadeMultiplyTexture) {
        try { m.shadeMultiplyTexture.dispose(); } catch {}
        m.shadeMultiplyTexture = null;
      }
      if (m.emissiveMap) {
        try { m.emissiveMap.dispose(); } catch {}
        m.emissiveMap = null;
      }
      count += 1;
    }
  });

  // Forzamos recompilación de TODOS los materiales tocados/visitados:
  // en Xiaomi a veces el shader queda con la textura vieja en cache si
  // no marcamos needsUpdate explícitamente.
  for (const m of touchedMaterials) {
    m.needsUpdate = true;
    if (m.map) m.map.needsUpdate = true;
  }
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

        // FASE 8.2 · PoseGuard universal: 50 ms × 4 s
        startPoseGuard(vrm, { intervalMs: 50, durationMs: 4000 });

        // FASE 8.2 · Activación explícita de SpringBones (pelo + ropa suelta)
        activateSpringBones(vrm);

        // ancla la cámara al hueso de la cabeza (J_Bip_C_Head)
        anchorCameraToHead(vrm);

        // FASE 8.5 · Resetea posición/rotación a (0,0,0) y reconfigura el
        // motor de Wander para el nuevo modelo (evita que aparezca fuera de
        // cámara o conserve la posición que dejó el modelo anterior).
        resetWanderForNewVrm(vrm);

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

// FASE 8.2 · BOTÓN PANTALLA COMPLETA (modo solo-modelo)
const fullscreenBtn = document.getElementById("fullscreen-toggle");
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    document.body.classList.toggle("solo-modelo");
    const isSolo = document.body.classList.contains("solo-modelo");
    fullscreenBtn.textContent = isSolo ? "⤢" : "⛶";
    fullscreenBtn.title = isSolo ? "Mostrar la interfaz" : "Mostrar solo el modelo 3D";
  });
}

// FASE 8.2 · BOTÓN CARGAR VRM EXTERNO
const vrmUploadBtn = document.getElementById("vrm-upload-btn");
const vrmFileInput = document.getElementById("vrm-file-input");
if (vrmUploadBtn && vrmFileInput) {
  vrmUploadBtn.addEventListener("click", () => vrmFileInput.click());
  vrmFileInput.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    await loadCustomVrmFromFile(f);
    vrmFileInput.value = "";
  });
}

// FASE 8.4 · BOTÓN CARGAR ANIMACIÓN EXTERNA (.vmd / .fbx)
const animUploadBtn = document.getElementById("anim-upload-btn");
const animFileInput = document.getElementById("anim-file-input");
if (animUploadBtn && animFileInput) {
  animUploadBtn.addEventListener("click", () => animFileInput.click());
  animFileInput.addEventListener("change", async (e) => {
    const files = e.target.files;
    if (files && files.length) await importAnimationFiles(files);
    animFileInput.value = "";
  });
  refreshAnimUiBadge();
}

// FASE 8.4 · BOTÓN MODO TUTORA UNIVERSAL DE IDIOMAS
const tutorToggleBtn = document.getElementById("tutor-toggle-btn");
if (tutorToggleBtn) {
  tutorToggleBtn.addEventListener("click", () => cycleTutor());
  refreshTutorToggleUi();
}

// FASE 8.5 · BOTÓN WANDER (paseo autónomo)
const wanderToggleBtn = document.getElementById("wander-toggle-btn");
if (wanderToggleBtn) {
  wanderToggleBtn.addEventListener("click", () => setWanderEnabled(!wanderEnabled));
  refreshWanderUi();
  // Si quedó activado en una sesión previa y ya hay modelo cargado, arranca.
  if (wanderEnabled && currentVrm) {
    setupWanderForVrm(currentVrm);
  }
}

// FASE 8.2 · BOTÓN CARGAR TEXTURA EXTERNA
const textureUploadBtn = document.getElementById("texture-upload-btn");
const textureFileInput = document.getElementById("texture-file-input");
if (textureUploadBtn && textureFileInput) {
  textureUploadBtn.addEventListener("click", () => textureFileInput.click());
  textureFileInput.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const ok = await applyImageAsTexture(url);
    URL.revokeObjectURL(url);
    appendMessage(
      ok
        ? `(*Hina ahora lleva la textura: ${f.name}*)`
        : `No pude aplicar "${f.name}" como textura.`,
      "system",
    );
    textureFileInput.value = "";
  });
}

// FASE 8.2 · GESTOR DE CLAVES DE API (modal)
const keysModal = document.getElementById("keys-modal");
const keysManagerBtn = document.getElementById("keys-manager-btn");
const keysCancel = document.getElementById("keys-cancel");
const keysSave = document.getElementById("keys-save");
const keyGeminiInput = document.getElementById("key-gemini");
const keyGroqInput = document.getElementById("key-groq");
const keyGeminiStatus = document.getElementById("key-gemini-status");
const keyGroqStatus = document.getElementById("key-groq-status");

function _keyStatusLabel(s) {
  if (!s || !s.present) return "vacía";
  return s.source === "runtime" ? "activa (runtime)" : "activa (Secret)";
}
async function refreshKeysStatus() {
  try {
    const r = await fetch("/keys/status", {
      headers: authHeaders(),
    });
    if (!r.ok) throw new Error("status " + r.status);
    const j = await r.json();
    if (keyGeminiStatus) keyGeminiStatus.textContent = "Gemini: " + _keyStatusLabel(j.gemini);
    if (keyGroqStatus) keyGroqStatus.textContent = "Groq: " + _keyStatusLabel(j.groq);
  } catch (err) {
    if (keyGeminiStatus) keyGeminiStatus.textContent = "Gemini: ?";
    if (keyGroqStatus) keyGroqStatus.textContent = "Groq: ?";
  }
}
if (keysManagerBtn && keysModal) {
  keysManagerBtn.addEventListener("click", () => {
    keysModal.classList.add("visible");
    if (keyGeminiInput) keyGeminiInput.value = "";
    if (keyGroqInput) keyGroqInput.value = "";
    refreshKeysStatus();
  });
}
if (keysCancel && keysModal) {
  keysCancel.addEventListener("click", () => keysModal.classList.remove("visible"));
}
if (keysSave) {
  keysSave.addEventListener("click", async () => {
    const payload = {};
    if (keyGeminiInput) payload.gemini = keyGeminiInput.value.trim();
    if (keyGroqInput) payload.groq = keyGroqInput.value.trim();
    try {
      const r = await fetch("/keys", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("status " + r.status);
      await refreshKeysStatus();
      appendMessage("(*Claves de API actualizadas en memoria.*)", "system");
      setTimeout(() => keysModal.classList.remove("visible"), 600);
    } catch (err) {
      console.error("[keys] error", err);
      appendMessage("No pude guardar las claves.", "system");
    }
  });
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
// FASE 8.5 · MOTOR DE WANDER UNIVERSAL (caminar autónomo + crossfade)
// =============================================================================
//
// Cualquier modelo VRM cargado (default, casual, sexy, pijama, custom, etc.)
// puede pasear por un área segura de 2.5 m con clips procedurales generados a
// partir de su propio rig humanoide. Idle ↔ Walk se mezclan con un crossfade
// de 0.5 s en un AnimationMixer dedicado, separado del mixer de animaciones
// subidas (.vmd / .fbx) para que ambos sistemas no se pisen.

const WANDER_STORAGE_KEY = "hina.wander.v1";
const WANDER_SAFE_RADIUS = 2.5;       // metros desde el origen (escenario)
const WANDER_SPEED = 0.55;            // m/s (paso humano relajado)
const WANDER_CROSSFADE_S = 0.5;
const WANDER_ARRIVE_DIST = 0.18;      // m

let wanderEnabled = false;
const wanderState = {
  mixer: null,
  vrm: null,
  idleAction: null,
  walkAction: null,
  mode: "idle",                       // "idle" | "walk"
  target: new THREE.Vector3(),
  pauseUntil: 0,
};

try {
  wanderEnabled = localStorage.getItem(WANDER_STORAGE_KEY) === "1";
} catch {}

function _quaternionAroundAxis(axis, angle) {
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

// Construye un clip de respiración mínima (idle) sobre el rig actual. No
// depende del modelo: usa los huesos humanoid normalizados del propio VRM.
function buildIdleClipForVrm(vrm) {
  if (!vrm?.humanoid) return null;
  const tracks = [];
  const spine = vrm.humanoid.getRawBoneNode("spine");
  if (spine) {
    const q0 = spine.quaternion.clone();
    const qUp = q0.clone().multiply(_quaternionAroundAxis(new THREE.Vector3(1, 0, 0), 0.025));
    const qDn = q0.clone().multiply(_quaternionAroundAxis(new THREE.Vector3(1, 0, 0), -0.005));
    tracks.push(new THREE.QuaternionKeyframeTrack(
      `${spine.name}.quaternion`,
      [0, 1.2, 2.4],
      [
        q0.x, q0.y, q0.z, q0.w,
        qUp.x, qUp.y, qUp.z, qUp.w,
        q0.x, q0.y, q0.z, q0.w,
      ],
    ));
    void qDn; // reservado para futuras micro-respiraciones
  }
  if (!tracks.length) {
    // fallback: clip vacío de 1 s — necesario para que el AnimationMixer corra
    return new THREE.AnimationClip("hina_idle", 1, []);
  }
  return new THREE.AnimationClip("hina_idle", 2.4, tracks);
}

// Construye un clip de caminar de 1 s en bucle. Mueve piernas y brazos en
// oposición, con un pequeño rebote en la cadera. Se reconstruye por modelo.
function buildWalkClipForVrm(vrm) {
  if (!vrm?.humanoid) return null;
  const tracks = [];
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);

  function addBoneSwing(boneName, axis, magnitude, phaseOffset = 0) {
    const bone = vrm.humanoid.getRawBoneNode(boneName);
    if (!bone) return;
    const q0 = bone.quaternion.clone();
    const qPos = q0.clone().multiply(_quaternionAroundAxis(axis, magnitude));
    const qNeg = q0.clone().multiply(_quaternionAroundAxis(axis, -magnitude));
    // 4 keyframes: 0=fwd, 0.5=back, 1=fwd → loop continuo
    let kfPos = qPos, kfMid = q0, kfNeg = qNeg;
    if (phaseOffset === 0.5) { kfPos = qNeg; kfNeg = qPos; }
    tracks.push(new THREE.QuaternionKeyframeTrack(
      `${bone.name}.quaternion`,
      [0, 0.5, 1],
      [
        kfPos.x, kfPos.y, kfPos.z, kfPos.w,
        kfNeg.x, kfNeg.y, kfNeg.z, kfNeg.w,
        kfPos.x, kfPos.y, kfPos.z, kfPos.w,
      ],
    ));
    void kfMid;
  }

  // Piernas (alternadas)
  addBoneSwing("leftUpperLeg", X, 0.55, 0);
  addBoneSwing("rightUpperLeg", X, 0.55, 0.5);
  // Rodilla (siempre flexión positiva al pisar)
  const lLow = vrm.humanoid.getRawBoneNode("leftLowerLeg");
  const rLow = vrm.humanoid.getRawBoneNode("rightLowerLeg");
  if (lLow) {
    const q0 = lLow.quaternion.clone();
    const qBend = q0.clone().multiply(_quaternionAroundAxis(X, -0.4));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${lLow.name}.quaternion`, [0, 0.25, 0.5, 0.75, 1], [
      q0.x, q0.y, q0.z, q0.w,
      q0.x, q0.y, q0.z, q0.w,
      qBend.x, qBend.y, qBend.z, qBend.w,
      q0.x, q0.y, q0.z, q0.w,
      q0.x, q0.y, q0.z, q0.w,
    ]));
  }
  if (rLow) {
    const q0 = rLow.quaternion.clone();
    const qBend = q0.clone().multiply(_quaternionAroundAxis(X, -0.4));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${rLow.name}.quaternion`, [0, 0.25, 0.5, 0.75, 1], [
      qBend.x, qBend.y, qBend.z, qBend.w,
      q0.x, q0.y, q0.z, q0.w,
      q0.x, q0.y, q0.z, q0.w,
      q0.x, q0.y, q0.z, q0.w,
      qBend.x, qBend.y, qBend.z, qBend.w,
    ]));
  }
  // Brazos (en contrafase con la pierna del mismo lado)
  addBoneSwing("leftUpperArm", X, 0.32, 0.5);
  addBoneSwing("rightUpperArm", X, 0.32, 0);
  // Antebrazos: flexión leve constante (codos relajados)
  const lFA = vrm.humanoid.getRawBoneNode("leftLowerArm");
  const rFA = vrm.humanoid.getRawBoneNode("rightLowerArm");
  for (const fa of [lFA, rFA]) {
    if (!fa) continue;
    const q0 = fa.quaternion.clone();
    const qBend = q0.clone().multiply(_quaternionAroundAxis(Z, -0.25));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${fa.name}.quaternion`, [0, 1], [
      qBend.x, qBend.y, qBend.z, qBend.w,
      qBend.x, qBend.y, qBend.z, qBend.w,
    ]));
  }
  // Cadera: pequeño rebote vertical cada paso
  const hips = vrm.humanoid.getRawBoneNode("hips");
  if (hips) {
    const baseY = hips.position.y;
    const baseX = hips.position.x;
    const baseZ = hips.position.z;
    tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, [0, 0.25, 0.5, 0.75, 1], [
      baseX, baseY, baseZ,
      baseX, baseY + 0.018, baseZ,
      baseX, baseY, baseZ,
      baseX, baseY + 0.018, baseZ,
      baseX, baseY, baseZ,
    ]));
  }
  return new THREE.AnimationClip("hina_walk", 1, tracks);
}

function disposeWanderMixer() {
  if (!wanderState.mixer) return;
  try {
    wanderState.mixer.stopAllAction();
    if (wanderState.vrm?.scene) wanderState.mixer.uncacheRoot(wanderState.vrm.scene);
  } catch (err) {
    console.warn("[wander] dispose mixer:", err);
  }
  wanderState.mixer = null;
  wanderState.vrm = null;
  wanderState.idleAction = null;
  wanderState.walkAction = null;
  wanderState.mode = "idle";
  wanderState.pauseUntil = 0;
}

function setupWanderForVrm(vrm) {
  if (!vrm) return false;
  disposeWanderMixer();
  try {
    const mixer = new THREE.AnimationMixer(vrm.scene);
    const idleClip = buildIdleClipForVrm(vrm);
    const walkClip = buildWalkClipForVrm(vrm);
    if (!idleClip || !walkClip) {
      console.warn("[wander] no se pudieron construir los clips para este modelo");
      return false;
    }
    const idleAction = mixer.clipAction(idleClip);
    idleAction.setLoop(THREE.LoopRepeat, Infinity);
    idleAction.weight = 1;
    idleAction.play();
    const walkAction = mixer.clipAction(walkClip);
    walkAction.setLoop(THREE.LoopRepeat, Infinity);
    walkAction.weight = 0;
    walkAction.play();
    wanderState.mixer = mixer;
    wanderState.vrm = vrm;
    wanderState.idleAction = idleAction;
    wanderState.walkAction = walkAction;
    wanderState.mode = "idle";
    wanderState.pauseUntil = performance.now() + 1500 + Math.random() * 2000;
    return true;
  } catch (err) {
    console.warn("[wander] setup falló:", err);
    disposeWanderMixer();
    return false;
  }
}

function _wanderPickTarget() {
  const r = (0.4 + Math.random() * 0.55) * WANDER_SAFE_RADIUS;
  const theta = Math.random() * Math.PI * 2;
  wanderState.target.set(Math.cos(theta) * r, 0, Math.sin(theta) * r);
}

function _wanderCrossfade(toWalk) {
  if (!wanderState.idleAction || !wanderState.walkAction) return;
  const target = toWalk ? "walk" : "idle";
  if (wanderState.mode === target) return;
  wanderState.mode = target;
  try {
    if (toWalk) {
      wanderState.walkAction.reset();
      wanderState.walkAction.enabled = true;
      wanderState.idleAction.crossFadeTo(wanderState.walkAction, WANDER_CROSSFADE_S, false);
    } else {
      wanderState.idleAction.reset();
      wanderState.idleAction.enabled = true;
      wanderState.walkAction.crossFadeTo(wanderState.idleAction, WANDER_CROSSFADE_S, false);
    }
  } catch (err) {
    console.warn("[wander] crossfade:", err);
  }
}

function tickWander(delta) {
  if (!wanderEnabled) return;
  if (!wanderState.mixer || !wanderState.vrm) return;
  if (wanderState.vrm !== currentVrm) return;
  // Si hay otra animación tomando control de los huesos, suspendemos wander
  // para no pisar gestos / clips subidos / cargas en curso.
  if (customAnimPlaying || activeGesture || isOutfitLoading) return;

  // El mixer global de wander avanza cada frame
  try { wanderState.mixer.update(delta); } catch (err) {
    console.warn("[wander] mixer update:", err);
    return;
  }

  const sceneObj = wanderState.vrm.scene;
  const pos = sceneObj.position;
  const now = performance.now();

  // Límite del escenario: 2.5 m. Si se sale, gira 180° hacia el centro.
  const distFromOrigin = Math.hypot(pos.x, pos.z);
  if (distFromOrigin > WANDER_SAFE_RADIUS) {
    sceneObj.rotation.y = Math.atan2(-pos.x, -pos.z);
    wanderState.target.set(0, 0, 0);
    wanderState.pauseUntil = 0;
    _wanderCrossfade(true);
  }

  if (wanderState.mode === "idle") {
    if (now >= wanderState.pauseUntil) {
      _wanderPickTarget();
      _wanderCrossfade(true);
    }
    return;
  }

  // Modo walk: avanza hacia el target
  const dx = wanderState.target.x - pos.x;
  const dz = wanderState.target.z - pos.z;
  const distToTarget = Math.hypot(dx, dz);
  if (distToTarget < WANDER_ARRIVE_DIST) {
    _wanderCrossfade(false);
    wanderState.pauseUntil = now + 1800 + Math.random() * 3000;
    return;
  }
  // Rotación suave hacia el target
  const desiredAngle = Math.atan2(dx, dz);
  let diff = desiredAngle - sceneObj.rotation.y;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  sceneObj.rotation.y += diff * Math.min(1, delta * 4);
  // Avanza en la dirección actual
  const stepX = Math.sin(sceneObj.rotation.y) * WANDER_SPEED * delta;
  const stepZ = Math.cos(sceneObj.rotation.y) * WANDER_SPEED * delta;
  pos.x += stepX;
  pos.z += stepZ;
}

// FASE 8.5 · Reseteo total al cambiar de modelo: posición, rotación, mixer.
// Se llama desde loadOutfit y loadCustomVrmFromFile justo después de añadir
// el nuevo VRM a la escena.
function resetWanderForNewVrm(newVrm) {
  if (!newVrm) return;
  try {
    newVrm.scene.position.set(0, 0, 0);
    newVrm.scene.rotation.set(0, 0, 0);
  } catch {}
  disposeWanderMixer();
  if (wanderEnabled) {
    setupWanderForVrm(newVrm);
  }
}

function setWanderEnabled(on) {
  wanderEnabled = !!on;
  try { localStorage.setItem(WANDER_STORAGE_KEY, wanderEnabled ? "1" : "0"); } catch {}
  refreshWanderUi();
  if (wanderEnabled && currentVrm) {
    setupWanderForVrm(currentVrm);
  } else if (!wanderEnabled) {
    _wanderCrossfade(false);
    // dejamos al modelo en su sitio, no lo teletransportamos
  }
}

function refreshWanderUi() {
  const btn = document.getElementById("wander-toggle-btn");
  if (!btn) return;
  if (wanderEnabled) {
    btn.classList.add("active");
    btn.textContent = "🚶 Pasear: ON";
    btn.title = "Hina pasea sola (área de 2.5 m). Click para detener.";
  } else {
    btn.classList.remove("active");
    btn.textContent = "🚶 Pasear: OFF";
    btn.title = "Activa el paseo autónomo: Hina caminará por el escenario.";
  }
}

// =============================================================================
// CHAT UI
// =============================================================================

const chatLog = document.getElementById("chat-log");
const chatBar = document.getElementById("chat-bar");
const chatInput = document.getElementById("chat-input");

function appendMessage(text, sender, opts = {}) {
  if (!chatLog) return null;
  // FASE 8.2 · Si es respuesta de Hina, dispara la expresión facial coincidente
  if (sender === "bot") {
    try { expressFromText(text); } catch {}
  }
  const msg = document.createElement("div");
  msg.className = `chat-message ${sender}`;
  // FASE 8.5 · soporte opcional de id (lo usan los generadores img/doc para
  // poder reemplazar el mensaje "pensando" con el resultado).
  if (opts && typeof opts.id === "string" && opts.id) msg.id = opts.id;

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
  // FASE 8.2 · MAPEO EXACTO: los explícitos VAN PRIMERO. Si esto se pone
  // después del patrón genérico "casual", el regex `\bcasual\b` matchea antes
  // y termina cargando un casual aleatorio en lugar del que pediste.
  { outfit: "casual1", patterns: ["casual 1", "casual1", "outfit 1"] },
  { outfit: "casual2", patterns: ["casual 2", "casual2", "outfit 2"] },
  { outfit: "casual3", patterns: ["casual 3", "casual3", "outfit 3"] },
  // casual aleatorio (solo si NO se pidió un número específico)
  { outfit: "__casual_random__", patterns: [
    "ropa casual", "casual", "ponte casual", "ropa de calle",
    "ropa de estudio", "ropa cómoda", "ropa comoda", "cámbiate", "cambiate",
    "cambio de ropa", "otra ropa",
  ]},
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
    tutor: tutorPayloadForServer(),
    // FASE 8.5 · enviamos las animaciones guardadas para que Hina las conozca
    availableAnimations: listSavedAnimNames(),
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
    tutor: tutorPayloadForServer(),
    // FASE 8.5 · también enviamos las animaciones guardadas en el modo análisis
    availableAnimations: listSavedAnimNames(),
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

// =============================================================================
// FASE 8.5 · GENERACIÓN DE IMÁGENES (Pollinations.ai) y DOCUMENTOS (.txt/.md)
// =============================================================================
//
// Pollinations es 100 % gratis y NO requiere clave: simplemente pedimos
// `https://image.pollinations.ai/prompt/<prompt-codificado>?width=...&nologo=true`
// y devuelve una imagen PNG. La mostramos en el chat con un botón de descarga.
// Para documentos, generamos el contenido con Hina (Gemini/Groq) y lo servimos
// como Blob descargable .txt o .md según el formato pedido.

const IMG_GEN_TRIGGERS = [
  /\b(?:dibuja(?:me)?|p[ií]ntame|p[ií]nta|crea|gen[eé]rame|gen[eé]rame?|gen[eé]ra(?:me)?|hazme|haz)\s+(?:una\s+|un\s+)?(?:imagen|foto|ilustraci[oó]n|dibujo|render|cuadro|poster|p[oó]ster)\s+(?:de|del|sobre|que muestre|con)\s+([\s\S]{3,200})/iu,
  /\b(?:imagen|foto|ilustraci[oó]n|dibujo|render)\s+(?:de|del|sobre|que muestre|con)\s+([\s\S]{3,200})/iu,
  /^\/img(?:agen)?\s+([\s\S]{3,200})/iu,
];

function detectImageGenCommand(text) {
  if (!text) return null;
  for (const re of IMG_GEN_TRIGGERS) {
    const m = re.exec(text);
    if (!m) continue;
    const prompt = String(m[1] || "").trim().replace(/[.\?!]+$/, "");
    if (prompt.length >= 3) return { prompt };
  }
  return null;
}

async function runImageGeneration({ prompt }) {
  const thinkingId = `img-${Date.now()}`;
  appendMessage(`(*Hina pinta para ti: "${prompt}"…*)`, "system", { id: thinkingId });
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
    // Verificamos cargando la imagen antes de mostrarla, para detectar fallos.
    await new Promise((resolve, reject) => {
      const probe = new Image();
      probe.crossOrigin = "anonymous";
      probe.onload = () => resolve();
      probe.onerror = () => reject(new Error("Pollinations no respondió"));
      probe.src = url;
      // timeout 25 s
      setTimeout(() => reject(new Error("timeout")), 25000);
    });
    // Reemplazamos el "pensando" por la imagen + descarga
    const node = document.getElementById(thinkingId);
    if (node) node.remove();
    const safeName = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "hina_imagen";
    const html = `
      <div class="hina-genimg">
        <figure>
          <img src="${url}" alt="${prompt.replace(/"/g, "&quot;")}" loading="lazy" />
          <figcaption>${prompt}</figcaption>
        </figure>
        <a class="hina-genimg-download" href="${url}" download="${safeName}.png" target="_blank" rel="noopener">⬇️ Descargar</a>
      </div>`;
    appendMessageHtml(`Aquí tienes lo que pinté: <em>${prompt}</em>`, "bot", { html });
    const reply = `Listo, te dibujé "${prompt}". Si quieres otra versión, pídemela 💕`;
    pushHistory("model", reply);
    speakResponse(reply);
  } catch (err) {
    console.warn("[img-gen] falló", err);
    const node = document.getElementById(thinkingId);
    if (node) node.remove();
    const fallback = "No pude generar la imagen ahora mismo (Pollinations no respondió). ¿Probamos otra descripción más simple?";
    appendMessage(fallback, "bot");
    pushHistory("model", fallback);
    speakResponse(fallback);
  }
}

// Documentos (.txt / .md) — el contenido lo genera el cerebro actual.
const DOC_GEN_TRIGGERS = [
  /\b(?:gen[eé]rame|gen[eé]ra(?:me)?|cr[eé]a(?:me)?|hazme|escr[ií]beme?|escribe(?:me)?|red[aá]ctame?)\s+(?:un\s+|una\s+)?(archivo|documento|texto|markdown|md|nota|apuntes?|gu[ií]a|tutorial|resumen|ensayo|carta|poema|cuento|informe|reporte)\s+([\s\S]{3,300})/iu,
  /^\/doc(?:umento)?\s+(txt|md)\s+([\s\S]{3,300})/iu,
];

function detectDocGenCommand(text) {
  if (!text) return null;
  // /doc md|txt <tema>
  const slashMatch = /^\/doc(?:umento)?\s+(txt|md)\s+([\s\S]{3,300})/iu.exec(text);
  if (slashMatch) {
    return { format: slashMatch[1].toLowerCase(), topic: slashMatch[2].trim() };
  }
  for (const re of DOC_GEN_TRIGGERS) {
    const m = re.exec(text);
    if (!m) continue;
    const kind = String(m[1] || "").toLowerCase();
    const topic = String(m[2] || "").trim().replace(/[.\?!]+$/, "");
    if (topic.length < 3) continue;
    const format = /(markdown|md|gu[ií]a|tutorial|apuntes?|informe|reporte|ensayo)/i.test(kind) ? "md" : "txt";
    return { format, topic };
  }
  return null;
}

async function runDocGeneration({ format, topic }) {
  const thinkingId = `doc-${Date.now()}`;
  appendMessage(`(*Hina redacta tu ${format.toUpperCase()}: "${topic}"…*)`, "system", { id: thinkingId });
  const fmtLabel = format === "md" ? "Markdown" : "texto plano";
  const docPrompt = format === "md"
    ? `Escribe un documento en MARKDOWN bien estructurado sobre: "${topic}". Usa títulos (##), subtítulos (###), listas y, si aplica, bloques de código. Sé claro, completo y útil. Devuelve SOLO el markdown, sin meta-comentarios ni envoltorios.`
    : `Escribe un documento en TEXTO PLANO claro y útil sobre: "${topic}". Sin markdown, sin asteriscos. Devuelve SOLO el contenido del documento.`;
  try {
    const content = await askGemini(docPrompt);
    const node = document.getElementById(thinkingId);
    if (node) node.remove();
    const safeName = topic.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "documento_hina";
    const fullName = `${safeName}.${format}`;
    const blob = new Blob([content], {
      type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const previewText = content.length > 500 ? content.slice(0, 500) + "…" : content;
    const html = `
      <div class="hina-gendoc">
        <div class="hina-gendoc-meta">📄 <strong>${fullName}</strong> · ${fmtLabel}</div>
        <pre class="hina-gendoc-preview">${escapeHtmlSafe(previewText)}</pre>
        <a class="hina-gendoc-download" href="${url}" download="${fullName}">⬇️ Descargar ${fullName}</a>
      </div>`;
    appendMessageHtml(`Te preparé un ${fmtLabel.toLowerCase()} sobre <em>${topic}</em>:`, "bot", { html });
    const reply = `Listo, tienes tu ${fullName} para descargar 💕`;
    pushHistory("model", reply);
    speakResponse(reply);
    // Liberamos la URL después de 5 minutos (el botón de descarga ya cargó al DOM)
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (err) {
    console.warn("[doc-gen] falló", err);
    const node = document.getElementById(thinkingId);
    if (node) node.remove();
    const fallback = "No pude redactar el documento ahora. ¿Lo intentamos con un tema más concreto?";
    appendMessage(fallback, "bot");
    pushHistory("model", fallback);
    speakResponse(fallback);
  }
}

// Helper local: si appendMessageHtml o escapeHtmlSafe no existen ya, los
// definimos aquí de manera mínima y compatible con appendMessage existente.
if (typeof escapeHtmlSafe !== "function") {
  // eslint-disable-next-line no-var
  var escapeHtmlSafe = function (s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };
}
if (typeof appendMessageHtml !== "function") {
  // eslint-disable-next-line no-var
  var appendMessageHtml = function (text, who, opts = {}) {
    appendMessage(text, who);
    if (!opts.html || !chatLog) return;
    const wrap = document.createElement("div");
    wrap.className = `chat-msg ${who} hina-rich`;
    wrap.innerHTML = opts.html;
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  };
}

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

  // FASE 8.5 · GENERACIÓN DE IMÁGENES (Pollinations) — 100 % gratis, sin clave
  const imgIntent = detectImageGenCommand(trimmed);
  if (imgIntent && pendingAttachments.length === 0) {
    appendMessage(trimmed, "user");
    chatInput.value = "";
    pushHistory("user", trimmed);
    await runImageGeneration(imgIntent);
    return;
  }

  // FASE 8.5 · GENERACIÓN DE DOCUMENTOS (.txt / .md descargables)
  const docIntent = detectDocGenCommand(trimmed);
  if (docIntent && pendingAttachments.length === 0) {
    appendMessage(trimmed, "user");
    chatInput.value = "";
    pushHistory("user", trimmed);
    await runDocGeneration(docIntent);
    return;
  }

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

  // FASE 8.4 · "baila <nombre>" / "anima <nombre>" → animación externa guardada
  // Va ANTES del comando procedural "baila", así si el usuario subió un .vmd
  // llamado "baile_kpop", la frase "baila baile_kpop" reproduce el archivo
  // completo en vez de quedarse en el gesto procedural genérico.
  const savedAnim = detectSavedAnimCommand(trimmed);
  if (savedAnim && attachments.length === 0) {
    const reply = `Va, te enseño "${savedAnim}".`;
    appendMessage(reply, "bot");
    pushHistory("model", reply);
    speakResponse(reply);
    playSavedAnimation(savedAnim).catch((err) => {
      console.error("[anim-lib] dispatch falló", err);
    });
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

// FASE 8.3 · resumen humano del tiempo desde la última visita
function describeTimeSince(lastSeenAt) {
  if (!Number.isFinite(lastSeenAt)) return "";
  const diffMs = Date.now() - lastSeenAt;
  if (diffMs < 60 * 1000) return "";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `Hace ${minutes} min que no nos veíamos.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Hace ${hours} ${hours === 1 ? "hora" : "horas"} que no hablábamos.`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Ayer hablamos por última vez.";
  if (days < 7) return `Hace ${days} días que no aparecías.`;
  const weeks = Math.round(days / 7);
  if (weeks === 1) return "Ya pasó una semana desde la última vez.";
  return `Hace ${weeks} semanas que no nos veíamos.`;
}

function showInitialGreeting() {
  if (!chatLog) return;
  const lvl = affectionLevel(affectionScore);
  // FASE 8.3 · si por alguna razón el perfil quedó vacío, sembramos "Emanuel"
  // para que Hina nunca empiece preguntándole el nombre a su dueño.
  if (!memory.profile) memory.profile = {};
  if (!memory.profile.name) {
    memory.profile.name = "Emanuel";
    persistMemory();
  }
  const userName = memory.profile.name;

  let greeting;
  if (lvl === "distant") {
    greeting = `Hola, ${userName}. Sigo sin conocerte bien, así que iré con calma.`;
  } else if (lvl === "confidant") {
    greeting = `Hola, ${userName}. Me alegra verte por aquí.`;
  } else if (lvl === "affectionate") {
    greeting = `Hola, ${userName}. ¿Cómo va tu día? Me preocupo por ti.`;
  } else {
    greeting = `¡${userName}! Te estaba esperando.`;
  }

  // FASE 8.3 · si tenemos historial previo, recordamos algo concreto:
  //   - tiempo desde la última visita
  //   - máximo nivel de relación alcanzado
  //   - último resumen guardado
  const sinceText = describeTimeSince(memory.lastSeenAt);
  if (sinceText) greeting += ` ${sinceText}`;

  const peakRanking = { distant: 0, confidant: 1, affectionate: 2, girlfriend: 3 };
  if (
    (peakRanking[memory.highestLevelReached] ?? 0) > (peakRanking[lvl] ?? 0)
  ) {
    greeting += ` Recuerdo que llegamos a ser muy cercanos antes — no quiero perder eso.`;
  }

  const lastSummary = Array.isArray(memory.summaries) && memory.summaries.length
    ? memory.summaries[memory.summaries.length - 1]
    : null;
  if (lastSummary && typeof lastSummary === "string" && lastSummary.length > 12) {
    const trimmed = lastSummary.length > 140 ? lastSummary.slice(0, 137) + "…" : lastSummary;
    greeting += ` La última vez hablamos de esto: ${trimmed}`;
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

  // FASE 8.3 · marca la visita actual y persiste para el próximo arranque
  memory.lastSeenAt = Date.now();
  persistMemory();

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
// FASE 8.3 · WIDGET DE RENDIMIENTO + MODO AHORRO
// =============================================================================
//
// Pinta FPS y uso de RAM (solo Chromium expone performance.memory) en una
// píldora central superior. Cuando el FPS cae sosteniblemente por debajo de
// 20, activa un modo ahorro que apaga las springbones (pelo + ropa) — la
// física es lo más caro en un Xiaomi de gama media. El modo se desactiva
// solo cuando el FPS vuelve a subir de 35 durante 4 s seguidos.

const PERF_WIDGET_EL = document.getElementById("perf-widget");
const PERF_FPS_EL = document.getElementById("pw-fps-value");
const PERF_RAM_EL = document.getElementById("pw-ram-value");

const PERF_FPS_LOW = 20;
const PERF_FPS_HIGH = 35;
const PERF_LOW_DWELL_MS = 3000;
const PERF_HIGH_DWELL_MS = 4000;
const PERF_UI_INTERVAL_MS = 500;

let perfFps = 60;
let perfFrames = 0;
let perfLastFpsAt = performance.now();
let perfLastUiAt = 0;
let perfLowSince = 0;
let perfHighSince = 0;
let perfSaverActive = false;
let perfSaverManual = false;

function setPerfSaverMode(active, { manual = false } = {}) {
  if (perfSaverActive === active && perfSaverManual === manual) return;
  perfSaverActive = active;
  perfSaverManual = manual;
  document.body.classList.toggle("perf-saver", active);
  // apaga / reactiva springbones de TODAS las posibles instancias VRM
  if (currentVrm) {
    try {
      const mgr = currentVrm.springBoneManager || currentVrm.springBoneManager0;
      if (mgr) {
        const joints = mgr.joints || mgr.springBoneJoints || [];
        const it = joints.values ? joints.values() : joints;
        for (const j of it) {
          const s = j?.settings || j;
          if (s && typeof s.stiffness === "number") {
            if (active) {
              if (s._origStiffness == null) s._origStiffness = s.stiffness;
              if (s._origDrag == null) s._origDrag = s.dragForce;
              s.stiffness = 0;
              s.dragForce = 1;
            } else if (s._origStiffness != null) {
              s.stiffness = s._origStiffness;
              s.dragForce = s._origDrag ?? s.dragForce;
            }
          }
        }
        if (active && typeof mgr.reset === "function") mgr.reset();
      }
    } catch (err) {
      console.warn("[perf-saver] no se pudo togglear springbones:", err);
    }
  }
  console.log(`[perf-saver] ${active ? "ACTIVADO" : "desactivado"}${manual ? " (manual)" : ""}`);
}

function updatePerfWidget(now) {
  perfFrames++;
  const elapsed = now - perfLastFpsAt;
  if (elapsed >= 1000) {
    perfFps = Math.round((perfFrames * 1000) / elapsed);
    perfFrames = 0;
    perfLastFpsAt = now;

    // Modo ahorro automático: latch con dwell-time para evitar parpadeo
    if (!perfSaverManual) {
      if (perfFps < PERF_FPS_LOW) {
        perfHighSince = 0;
        if (!perfLowSince) perfLowSince = now;
        if (!perfSaverActive && now - perfLowSince >= PERF_LOW_DWELL_MS) {
          setPerfSaverMode(true);
        }
      } else if (perfFps > PERF_FPS_HIGH) {
        perfLowSince = 0;
        if (!perfHighSince) perfHighSince = now;
        if (perfSaverActive && now - perfHighSince >= PERF_HIGH_DWELL_MS) {
          setPerfSaverMode(false);
        }
      } else {
        // zona intermedia: no decidimos nada nuevo
        perfLowSince = 0;
        perfHighSince = 0;
      }
    }
  }

  if (now - perfLastUiAt < PERF_UI_INTERVAL_MS) return;
  perfLastUiAt = now;
  if (PERF_FPS_EL) PERF_FPS_EL.textContent = String(perfFps);
  if (PERF_WIDGET_EL) {
    PERF_WIDGET_EL.dataset.fps =
      perfFps >= 45 ? "good" : perfFps >= 25 ? "ok" : "bad";
  }
  if (PERF_RAM_EL) {
    const mem = performance && performance.memory;
    if (mem && mem.usedJSHeapSize) {
      PERF_RAM_EL.textContent = `${Math.round(mem.usedJSHeapSize / 1048576)}MB`;
    } else {
      PERF_RAM_EL.textContent = "n/a";
    }
  }
}

// Click en la píldora → toggle manual del modo ahorro (ignora el automático
// hasta el próximo ciclo de FPS).
if (PERF_WIDGET_EL) {
  PERF_WIDGET_EL.addEventListener("click", () => {
    setPerfSaverMode(!perfSaverActive, { manual: !perfSaverActive });
  });
}

// =============================================================================
// LOOP DE RENDERIZADO (idle: respiración + parpadeo + gestos)
// =============================================================================
//
// FASE 8.3 · todo el cuerpo del loop está envuelto en try/catch para que un
// error puntual (p. ej. una textura corrupta de un VRM externo) NO mate el
// `requestAnimationFrame`. El loop sigue y la app no se cuelga.

let lastRenderError = 0;

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();

  try {
    const delta = clock.getDelta();
    const elapsed = clock.elapsedTime;

    if (currentVrm) {
      // FASE 8.4 · Si hay animación externa (.vmd / .fbx) corriendo en el
      // mixer, ÉL es quien manda sobre los huesos: saltamos respiración idle
      // y gestos procedurales para que no peleen contra la animación.
      if (currentMixer && currentMixerVrm === currentVrm) {
        currentMixer.update(delta);
      } else {
        const spine = currentVrm.humanoid?.getNormalizedBoneNode("spine");
        if (spine && !activeGesture) {
          // respiración idle (solo si no estamos en un gesto activo)
          spine.rotation.x = Math.sin(elapsed * 1.5) * 0.025;
        }
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

      // Los gestos procedurales sólo se ejecutan si el mixer NO está activo.
      if (!customAnimPlaying) tickGesture();

      // FASE 8.5 · Motor de Wander universal — sólo si no hay animación
      // externa, gesto activo o carga en curso (tickWander ya lo verifica).
      tickWander(delta);

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
  } catch (err) {
    // Throttle: no inundamos la consola si el error se repite cada frame.
    if (now - lastRenderError > 2000) {
      console.warn("[render-loop] error capturado, sigo vivo:", err);
      lastRenderError = now;
    }
  }

  // El widget de FPS/RAM debe seguir actualizando aunque el render falle,
  // así el usuario ve claramente que algo está pasando.
  try {
    updatePerfWidget(now);
  } catch (err) {
    if (now - lastRenderError > 2000) {
      console.warn("[perf-widget] error:", err);
      lastRenderError = now;
    }
  }
}

animate();
