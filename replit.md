# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

- **vrm-viewer** (`/`): Vanilla HTML + JS Three.js viewer for the `personaje.vrm` model with a glassmorphism chat backed by Gemini.
  - `index.html` declares an importmap that loads `three`, `three/addons/`, and `@pixiv/three-vrm` from jsDelivr. It contains:
    - `#lock-overlay` (z-index 200) — passphrase gate (Phase 1 / acceso privado)
    - `#start-overlay` (z-index 100) — first-tap audio unlock for SpeechSynthesis
    - `#chat-bar` with camera, file (paperclip) and mic buttons; hidden `#camera-input` and `#file-input` for upload pickers
    - `#attachment-preview` chip strip showing pending attachments before send
  - `script.js` (served from `public/`) sets up the scene, lights, camera, OrbitControls, the VRM loader plugin, blink/breathing/lookAt, the chat UI and:
    - Calls `POST /auth` to validate the passphrase, stores the token in `localStorage` (`hina.auth.token.v1`), and sends it as `Authorization: Bearer <token>` on every protected request.
    - Tracks affection in `localStorage` (`hina.affection.v2`) using a 4-tier model: distant 0-25, confidant 26-40, affectionate 41-75, girlfriend 76-100. Affection only increases (kind words +2, gifts +10) and decays slowly with inactivity. There are no insulting words anywhere in the system.
    - Memory in `localStorage` (`hina.memory.v2`) starts blank — Hina has no profile data and discovers the user from scratch.
    - File attachments → `POST /analyze`; text-only messages → `POST /chat`.
    - Action commands: typing `saluda`, `baila`, `gira`, `ven` triggers a procedural bone animation (`GESTURES` map) on the VRM rig.
    - Gift command: `/regalar <item>` — if the item is recognized as food/sweets it bumps affection +10, plays the `alegria` gesture and a happy expression.
  - `server.js` exports `createApiApp()`: an Express 5 app that:
    - Sanitizes secrets via `sanitizeSecret()` (strips BOM, zero-width characters and trims whitespace) before reading `GEMINI_API_KEY` and `HINA_PASSPHRASE`.
    - `POST /auth` — `crypto.timingSafeEqual` comparison against `HINA_PASSPHRASE`, returns the token used by the client for subsequent calls.
    - `authMiddleware` protects `/chat`, `/summarize` and `/analyze`.
    - `POST /chat` — proxies to `gemini-flash-latest` with the new 4-tier `PERSONALITY_HEADERS` (no insults, no offensive nicknames in any tier).
    - `POST /analyze` — multimodal endpoint. Inline data (images, PDF, audio, plain text) goes straight to Gemini; Office documents are extracted on the server using `mammoth` (.docx → text), `xlsx` (.xlsx → CSV per sheet) and `adm-zip` (.pptx → slide XML text), then appended to the prompt.
    - `POST /summarize` — distils long-term memory summaries.
    - `GET /health` — reports `hasGeminiKey` / `hasPassphrase` for quick diagnostics.
  - `vite.config.ts` mounts `createApiApp()` as Vite middleware (`configureServer` and `configurePreviewServer`) at the artifact's `BASE_PATH`, so dev and preview both run on a single port.
  - `GEMINI_API_KEY` and `HINA_PASSPHRASE` are stored as Replit Secrets (not in code).
  - The VRM file lives at `public/personaje.vrm`.
  - PWA: `public/manifest.json`, `public/sw.js` (cache-first for same-origin and jsDelivr/unpkg, bypasses `/chat`, `/auth`, `/analyze`, `/summarize`, `/health`), and `public/icon.svg`. The cache version is bumped to `hina-v3` so older caches are evicted on the next visit.
  - The endpoints are mounted at `/chat`, `/auth`, `/analyze`, `/summarize`, `/health` (not under `/api`) because the `api-server` artifact owns `paths = ["/api"]` and the Replit proxy would route any `/api/*` request to it instead of the vrm-viewer artifact.
  - Dependencies added for multimodal: `mammoth`, `xlsx`, `adm-zip`.

### Phase 7 — Armario, animaciones, cámara y atmósfera (April 2026)

- **Armario (9 outfits)**: VRM models live in `public/wardrobe/` — `hina.vrm` (default 9 MB), 3 casuales (`casual1-3.vrm`), `pijama.vrm`, `maid.vrm`, `cosplay.vrm`, `sexy1.vrm`, `sexy2.vrm`. **Lazy-loaded** — never preload all (~135 MB total). The `WARDROBE` map in `script.js` stores label/path/category for each.
  - `loadOutfit(name, opts)` swaps VRM in-place via `disposeVrm()` + GLTFLoader, preserves rest pose with `captureRestPose()`, re-anchors the camera to the new head bone, and persists the choice in `localStorage` (`hina.outfit.v1`).
  - **Initial outfit**: `bootInitialOutfit()` (deferred via `setTimeout 0` to avoid TDZ on `piuraContext`) waits up to ~1 s for the first weather fetch, then picks: stored outfit > `pijama` if Piura local time ≥ 22 h or < 6 h > random `casual1-3`.
  - **Floating quick-pick** (`#wardrobe-overlay`, top-right) renders one button per outfit; current outfit gets the `.current` class.
  - **Synonym detection** in `WARDROBE_SYNONYMS` recognises voice/chat phrases without invoking Gemini: "ropa de baño / bikini / playa" → `sexy1`; "ponte algo cómodo / pijama / vamos a dormir" → `pijama`; "maid / mucama / sirvienta" → `maid`; "cosplay / disfraz" → `cosplay`; "cámbiate / otra ropa / casual" → random casual; explicit `casual 1/2/3`, `sexy 2`, `modo default` also work. Detection runs in `handleUserMessage` *before* `ACTION_TRIGGERS` and *before* `askGemini`, so it's instant and doesn't consume energy.
- **Animaciones por contexto (4 .vmd)**: raw MMD motion files saved in `public/animations/` (saludo, pensativa, alternativo, posec). They're kept for a future MMD→VRM retargeter; for now `VMD_TO_GESTURE` maps each name to a procedural bone gesture in `GESTURES` so it works on every outfit at zero CPU cost on a Xiaomi.
  - New procedural gestures added: `pensativa` (mano al mentón, fires while Gemini processes long/question prompts), `alternativo` (idle sway), `posec` (pose tímida), `heart` (manos al pecho + happy expression, triggered by "te quiero / te amo / dame amor / /heart").
  - **Saludo automático**: `showInitialGreeting()` plays the `saluda` gesture right after the first auth-success greeting.
  - **Animaciones autónomas**: `tickAutonomousAnimations()` runs every frame, throttled to 45 s, picks randomly from `["alternativo", "posec"]` while she's idle (no active gesture, no outfit loading, not currently speaking).
- **Cámara anclada al hueso de la cabeza**: `anchorCameraToHead(vrm)` stores `headBoneRef` from `humanoid.getRawBoneNode("head")`. The render loop reads `headBoneRef.getWorldPosition()` each frame, adds a small `HEAD_OFFSET (0, 0.05, 0)`, and `controls.target.lerp(worldPos, 0.18)` so the focus stays on her face during outfit changes, dances and turns without snapping.
- **Barra de progreso de carga** (`#load-bar`, top-center, blurred pill): `showLoadBar(label)`, `updateLoadBar(loaded, total)`, `hideLoadBar(delay)` are called from each `loader.load()` progress callback. Shows "Cargando <Outfit>… N%" with gradient fill; falls back to MB downloaded when total is unknown.
- **Lofi automático en clima tranquilo**: `maybeAutoplayLofi()` opens the music overlay 1.5 s after the greeting if `piuraContext.conditionCode ∈ {0,1,2,3,45,48}` (despejado/poca nube/neblina) AND `tempC ≤ 32`. Guarded by `lofiAutoplayed` so it fires only once per session.
- **Saludo enriquecido**: `showInitialGreeting()` appends `"Aquí en Piura ahora hay X°C, <condición>."` when weather is loaded — gives every login a sense of place.
- **Service worker bumped to `hina-v7`** and `personaje.vrm` removed from `PRECACHE_URLS` (the wardrobe is lazy-loaded, precaching 9 MB upfront would slow the first paint on a Xiaomi).
- **Workflow**: `artifacts/vrm-viewer: web` (auto-managed by the artifact registration) runs `pnpm --filter @workspace/vrm-viewer run dev` with `PORT=20034 BASE_PATH=/` injected from `artifact.toml`. The `geminiProxyPlugin` in `vite.config.ts` mounts `createApiApp()` as Vite middleware so Express routes (`/auth`, `/chat`, `/analyze`, `/summarize`, `/health`) and the static front-end share port 20034.

### Phase 7.5 — Arquitectura de Intercambio Universal y Herencia de ADN (April 2026)

- **Pose normalization (kill-T-pose)**: `normalizeToHinaPose(vrm)` is now called on every model load (replacing the partial `applyDefaultRestPose`). Steps: (1) `vrm.humanoid.resetNormalizedPose()` zeroes every humanoid bone, then (2) the canonical `HINA_REST_POSE` dictionary is applied bone-by-bone (shoulders, upper/lower arms in A-pose, hands, spine/chest/neck curl, legs at rest). Every outfit inherits exactly the same rest posture so the T-pose never appears, even for one frame.
- **Combined action handler with promises**: `handleUserMessage` now detects wardrobe + action together. Phrases like "ponte el cosplay y salúdame" trigger an async chain: bot acknowledges → `await loadOutfit(target)` → `setTimeout(playGesture(action), 250)`. `loadOutfit` already returns `Promise<boolean>`, and `activeGesture` is cleared first so the previous gesture stops cleanly.
- **Universal texture exchange**: new functions `extractClothTextures(vrm)` / `applyClothTextures(target, source)` / `borrowTexturesFrom(sourceName)`. Borrowing loads the source VRM headlessly (never added to scene), reads cloth materials by VRoid naming convention (Tops / Bottoms / Onepiece / Outerwear / FootWear / Skirt / Dress / Cloth / Swimwear), copies their `map` and `color` onto the active model's matching materials (exact name first, category fallback second), then disposes the source while keeping the borrowed textures alive (UUID keeper Set). Trigger phrases in `TEXTURE_BORROW_TRIGGERS`: "préstame la ropa de X", "usa la textura de X", "intercambia ropa con X", "toma prestada la ropa de X".
- **Hot-weather suggestion (>30 °C)**: `pickInitialOutfit` now reads `piuraContext.tempC`; if > 30 °C and not stored/night, there is a 50 % chance she boots wearing `sexy1`, `sexy2` or `cosplay` instead of casual. The greeting also appends "Hace un calor pesado, ¿quieres que me ponga algo más fresco?" when `tempC > 30`.
- **Voice mic input**: confirmed wired (Web `SpeechRecognition` / `webkitSpeechRecognition` in `script.js` lines 1692–1854 with classic-recording fallback). The mic button toggles between `startSpeechRecognition()` and `stopSpeechRecognition()`.
- **404 / 401**: no `/assets/models/` references exist in the current codebase (paths are `wardrobe/*.vrm`); the 401 is resolved by the `GEMINI_API_KEY` and `HINA_PASSPHRASE` Replit Secrets (the `/health` endpoint reports both `true`).
- **Service worker bumped to `hina-v7-5`** so existing PWA installs (Xiaomi browser) evict the old cache on next open.

### Phase 8 — Sistema de IA Híbrido y Soporte Académico Avanzado (April 2026)

- **Cerebro dual Gemini + Groq con auto-fallback**: `server.js` añade `GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"` (modelo `llama3-70b-8192`), `getGroqKey()` y `pickBrain(requested)`. El wrapper `callWithFallback({ requested, callers })` intenta primero el cerebro pedido; si la respuesta cae en `FALLBACK_STATUSES = [401, 403, 408, 429, 500, 502, 503, 504]` (o lanza error de red), salta automáticamente al otro cerebro disponible y devuelve `{ reply, brainUsed, fellBack }`. `/chat` y `/analyze` están refactorizados para usar el wrapper; `/analyze` fuerza Gemini cuando hay archivos `image/*`, `audio/*` o `video/*` (Llama3 es solo texto) y devuelve `forcedGemini: true` para que el cliente no lo confunda con un fallback. `/health` ahora reporta `hasGroqKey` y `brains: { gemini, groq }`.
- **Toggle de cerebro en la UI** (`#brain-toggle`, esquina superior izquierda, `index.html` + CSS): píldora con `data-brain` que cambia color (azul Gemini, naranja Groq). El estado se persiste en `localStorage` (`hina.brain.v1`) y se envía como `brain` en cada `POST /chat` y `POST /analyze`. Click → `toggleBrain()` → `setBrain()` la cambia y Hina dice "Cambiando a procesador de alta velocidad para ayudarte mejor." (a Groq) o "Vuelvo al cerebro Gemini, tengo más contexto multimodal aquí." Si el servidor cae al otro cerebro por error 401/429/500, `notifyBrainSwitchedByFallback()` muestra un mensaje de sistema, sincroniza el toggle con la realidad y aplica anti-spam de 5 s.
- **Soporte académico (paso a paso)**: `/analyze` ahora añade al system prompt una instrucción para resolver matemáticas, física y química en pasos numerados, citando definiciones y verificando el resultado. La memoria/afecto se mantienen aunque cambies de cerebro porque ambos endpoints reciben `affectionScore`, `memory` y `context` desde el cliente.
- **Separación estricta de comandos de vestuario**:
  - `"ponte la ropa de [maid/cosplay/...]"` → `TEXTURE_BORROW_TRIGGERS` añade `/ponte\s+la\s+ropa\s+de\s+(la\s+|el\s+)?(\w+)/i` → solo intercambia textura sobre el modelo actual (no recarga VRM).
  - `"cámbiate a [outfit]"` / `"cambia al modelo X"` / `"carga el modelo X"` → nuevo `VRM_LOAD_TRIGGERS` + `detectVrmLoadCommand()` → carga el `.vrm` completo. Se ejecuta antes que `detectTextureBorrow` y `detectWardrobeCommand` en `handleUserMessage`.
- **Watcher anti-T-pose para outfits problemáticos** (`casual2/3`, `pijama`, `cosplay`): tras `loadOutfit` se vuelve a llamar `normalizeToHinaPose(vrm)` durante 5 frames con `requestAnimationFrame` y otra vez a 100 ms y 300 ms — solo si `currentVrm === vrm` (evita sobreescribir si el usuario cambió de outfit en medio).
- **Service worker bumped to `hina-v8`** para evictar el caché viejo en navegadores Xiaomi.
- **Secrets requeridos**: `GEMINI_API_KEY`, `GROQ_API_KEY`, `HINA_PASSPHRASE` (los tres ya configurados; `/health` los reporta todos `true`).

### Phase 8.1 — Hotfix de cerebro dual, T-pose universal y limpieza de texturas (April 2026)

- **Fix HTTP 404 en Groq** (`server.js`): el modelo `llama3-70b-8192` fue retirado por Groq. Ahora usamos **`llama-3.3-70b-versatile`** (128 k de contexto, mejor en español). Verificado con un POST directo a la API: `HTTP 200 OK`.
- **Fix HTTP 400 en Groq**: `geminiContentsToOpenAiMessages()` reescrito con reglas estrictas OpenAI Chat Completions:
  - `content` nunca puede estar vacío (se descarta el mensaje).
  - El `system` solo se añade si tiene contenido.
  - Garantiza al menos un mensaje `user` (Groq lo rechaza si solo hay `system`).
  - El payload ya no incluye parámetros propios de Gemini; sólo `model`, `messages`, `temperature` (clamp 0–2), `max_tokens` (clamp ≤ 8192), `stream:false`.
- **Anti-T-pose UNIVERSAL por fuerza bruta** (`script.js`): nueva función `forcePoseFor3Seconds(vrm)` que ejecuta `normalizeToHinaPose(vrm)` cada 100 ms durante 3 s tras CUALQUIER `loadOutfit`. El bucle se autocancela si el usuario cambia de modelo a mitad de camino o si hay un gesto activo (saluda/baila), para no pisar las animaciones reales. `normalizeToHinaPose` también llama a `vrm.scene.updateMatrixWorld(true)` para forzar el refresco del rig.
- **Intercambio de texturas Omni-Render** (`applyClothTextures`):
  - Llama `dispose()` sobre la textura previa antes de pisar `material.map` (libera memoria de GPU en Xiaomi).
  - Marca `texture.needsUpdate = true` Y `material.needsUpdate = true` en TODOS los materiales del modelo, no solo los swapped — fuerza recompilación de shader MToon.
  - Limpia `shadeMultiplyTexture` y `emissiveMap` (mapas auxiliares de MToon que algunos VRoid usan en lugar de `map`).
- **Preservado intacto**: `anchorCameraToHead(vrm)` (cámara al hueso `J_Bip_C_Head`), sistema de baile (`GESTURES`, `tickAutonomousAnimations`), análisis multimodal de SENATI (PDFs/fotos siguen forzando Gemini en `/analyze`).
- **Service worker bumped to `hina-v8-1`**.

## Phase 8.2 — SpringBones, PoseGuard, Emociones, Uploads y Gestor de APIs

- **Motor de pelo y ropa** (`activateSpringBones`): tras la carga de cada VRM se llama a `vrm.springBoneManager.reset()` y se afinan `stiffness`/`dragForce` para que pelo y partes sueltas reaccionen a la gravedad y al baile sin atravesar el cuerpo (los colliders del .vrm ya vienen registrados por `VRMLoaderPlugin`). Loguea cantidad de joints y collider-groups en consola para depurar en Xiaomi.
- **PoseGuard universal** (`startPoseGuard`): el bucle reaplica la A-pose CADA 50 ms durante 4 s tras CUALQUIER carga (50 ms × 4 s en lugar de 100 ms × 3 s de la 8.1). Garantiza que TODOS los modelos (incluyendo los importados por el usuario) bajen los brazos. Se autocancela ante un cambio de modelo o un gesto activo. Alias retrocompatible `forcePoseFor3Seconds`.
- **Mapeo exacto de outfits** (`WARDROBE_SYNONYMS`): los patrones explícitos `casual 1/2/3` se MUEVEN ARRIBA del patrón genérico `casual` para que `\bcasual\b` no matchee primero y devuelva un casual aleatorio cuando el usuario pidió uno específico.
- **Analizador de emociones por BlendShapes** (`detectEmotion` + `applyEmotion` + `expressFromText`): scanner de keywords sobre el texto que va a decir Hina (jaja/triste/celosa/wow/tranquila…) → enciende la expresión `happy/sad/angry/surprised/relaxed` durante 2.2 s y la apaga. Hookeado en `appendMessage` cuando `sender === "bot"`.
- **Carga de VRM externos** (`loadCustomVrmFromFile`): botón "📦 Cargar VRM" en el tool-stack. Acepta un `.vrm` cualquiera, ejecuta `URL.createObjectURL`, lo carga con el mismo loader, dispone del modelo anterior, ancla la cámara a la cabeza y arranca PoseGuard + SpringBones.
- **Carga de texturas externas** (`applyImageAsTexture`): botón "🎨 Cargar Textura". Aplica un `.png/.jpg/.webp` a TODOS los materiales de ropa del modelo activo. Hace `dispose()` sobre la textura anterior y limpia `shadeMultiplyTexture`/`emissiveMap` (anti z-fighting).
- **Gestor de claves de API** (modal `#keys-modal` + endpoints `GET /keys/status` y `POST /keys`): permite actualizar `GROQ_API_KEY` y `GEMINI_API_KEY` desde la interfaz. Las claves se guardan en memoria (`_runtimeKeys`) en el proceso Node — NO se persisten a disco y se borran al reiniciar. `getApiKey()`/`getGroqKey()` priorizan el override sobre el Secret de Replit. Endpoints protegidos por `authMiddleware` (HINA_PASSPHRASE).
- **Pantalla completa** (`#fullscreen-toggle` + clase `body.solo-modelo`): oculta chat, armario, brain-toggle, tool-stack, info y reproductor de música. Solo queda el modelo 3D y el botón ⤢ para volver.
- **Preservado intacto**: `anchorCameraToHead`, sistema de gestos/baile y `tickAutonomousAnimations`.
- **Service worker bumped to `hina-v8-2`**.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
