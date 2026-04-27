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
- **Workflow**: `Start application` runs `PORT=20034 BASE_PATH=/ pnpm --filter @workspace/vrm-viewer run dev`. The `geminiProxyPlugin` in `vite.config.ts` mounts `createApiApp()` as Vite middleware so Express routes (`/auth`, `/chat`, `/analyze`, `/summarize`, `/health`) and the static front-end share port 20034. External port 80 → localPort 20034 is configured in `.replit`.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
