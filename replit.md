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

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
