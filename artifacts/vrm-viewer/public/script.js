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
  const headHeight = currentVrm ? controls.target.y : 1.4;
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
    if (leftUpperArm) leftUpperArm.rotation.z = THREE.MathUtils.degToRad(70);
    if (rightUpperArm) rightUpperArm.rotation.z = THREE.MathUtils.degToRad(-70);

    if (vrm.lookAt) vrm.lookAt.target = lookAtTarget;

    captureRestPose(vrm);

    const box = new THREE.Box3().setFromObject(vrm.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const headY = center.y + size.y * 0.35;
    controls.target.set(center.x, headY, center.z);

    const distance = size.y * 1.6;
    camera.position.set(center.x, headY, center.z + distance);
    controls.update();

    if (info) info.textContent = "Hina lista · mueve el cursor";
  },
  (progress) => {
    if (info && progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      info.textContent = `Cargando personaje.vrm… ${pct}%`;
    }
  },
  (error) => {
    console.error("Error cargando el modelo VRM:", error);
    if (info) info.textContent = "Error al cargar personaje.vrm";
  },
);

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
  saluda: ["saluda", "salúdame", "saludame", "/saluda", "saludo"],
  baila: ["baila", "danza", "/baila", "bailame"],
  gira: ["gira", "/gira", "da una vuelta", "vuélta", "vuelta"],
  ven: ["ven", "/ven", "ven aquí", "ven aqui", "acércate", "acercate"],
};

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

async function addFilesToAttachments(filesList) {
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
    await addFilesToAttachments(files);
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

// Audio recording (mic button)
let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;

async function startRecording() {
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
  micBtn?.classList.add("recording");
  micBtn?.setAttribute("aria-label", "Detener grabación");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  micBtn?.classList.remove("recording");
  micBtn?.setAttribute("aria-label", "Grabar audio");
}

if (micBtn) {
  micBtn.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
    else startRecording();
  });
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
      await new Promise((r) => setTimeout(r, 2000));
      return await postChatOnce(payload);
    }
    throw err;
  }
}

async function analyzeWithFiles(userText, attachments) {
  const payload = {
    message: userText,
    affectionScore,
    memory: distilledMemoryForServer(),
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

  // FASE 4 · acciones
  const action = detectActionCommand(trimmed.toLowerCase());
  if (action && attachments.length === 0) {
    playGesture(action);
    const responses = {
      saluda: ["Hola.", "Te saludo.", "Hey, hola."],
      baila: ["¡A bailar!", "Mira mis pasos.", "¿Qué tal este ritmo?"],
      gira: ["Una vuelta.", "Mírame.", "Lista."],
      ven: ["Voy.", "Aquí estoy.", "Acércate tú también."],
    };
    const list = responses[action] || ["Hecho."];
    const reply = list[Math.floor(Math.random() * list.length)];
    appendMessage(reply, "bot");
    pushHistory("model", reply);
    speakResponse(reply);
    return;
  }

  const thinkingBubble = appendMessage("Hina está pensando…", "bot");

  try {
    const reply = attachments.length
      ? await analyzeWithFiles(trimmed, attachments)
      : await askGemini(trimmed);
    if (thinkingBubble) setBubbleText(thinkingBubble, reply);
    else appendMessage(reply, "bot");
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
  appendMessage(greeting, "bot");
  pushHistory("model", greeting);
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

  controls.update();
  renderer.render(scene, camera);
}

animate();
