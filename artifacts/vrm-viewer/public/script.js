import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const CHAT_ENDPOINT = "/chat";

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
  msg.textContent = text;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msg;
}

let happyTimeoutId = null;
let lipSyncRafId = null;
let lipSyncStartedAt = 0;

function stopLipSync() {
  if (lipSyncRafId !== null) {
    cancelAnimationFrame(lipSyncRafId);
    lipSyncRafId = null;
  }
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
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
  } catch (err) {
    console.warn("[speech] no se pudo desbloquear el audio:", err);
  }
  speechPrimed = true;
}

function speakResponse(text) {
  if (typeof speechSynthesis === "undefined") return;

  speechSynthesis.cancel();
  stopLipSync();

  if (!text) return;

  const utter = new SpeechSynthesisUtterance(text);
  const voice = pickSpanishFemaleVoice();
  if (voice) utter.voice = voice;
  utter.lang = voice?.lang || "es-ES";
  utter.rate = 1.0;
  utter.pitch = 1.1;

  utter.onstart = () => simulateLipSync();
  utter.onend = () => stopLipSync();
  utter.onerror = (event) => {
    console.warn("[speech] error de síntesis:", event.error);
    stopLipSync();
  };

  speechSynthesis.speak(utter);
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

async function askGemini(userText) {
  const requestBody = JSON.stringify({ message: userText });
  console.log("Petición al servidor:", { url: CHAT_ENDPOINT, body: requestBody });

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
    throw new Error(`HTTP ${response.status}${detail}`);
  }

  const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
  if (!reply) {
    throw new Error("El servidor respondió 200 pero sin campo 'reply'");
  }
  return reply;
}

async function handleUserMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  primeSpeech();
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
  stopLipSync();

  appendMessage(trimmed, "user");
  chatInput.value = "";

  const thinkingBubble = appendMessage("Hina está pensando...", "bot");

  try {
    const reply = await askGemini(trimmed);
    if (thinkingBubble) {
      thinkingBubble.textContent = reply;
    } else {
      appendMessage(reply, "bot");
    }
    reactHappy(3000);
    speakResponse(reply);
  } catch (error) {
    console.error("Error consultando a Gemini:", error);
    const detail = error?.message ? ` (${error.message})` : "";
    const errorText = `Hina tuvo un pequeño problema de conexión${detail}`;
    if (thinkingBubble) {
      thinkingBubble.textContent = errorText;
    } else {
      appendMessage(errorText, "bot");
    }
  }
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
