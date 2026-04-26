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
  - `index.html` declares an importmap that loads `three`, `three/addons/`, and `@pixiv/three-vrm` from jsDelivr.
  - `script.js` (served from `public/` so Vite ships it untouched) sets up the scene, lights, camera, OrbitControls, the VRM loader plugin, blink/breathing/lookAt, and the chat UI. It POSTs `{ message }` to `/chat`.
  - `server.js` exports `createApiApp()`: an Express app with `POST /chat` that reads `process.env.GEMINI_API_KEY` and proxies to `gemini-flash-latest`. The browser never sees the key.
  - `vite.config.ts` mounts `createApiApp()` as Vite middleware (`configureServer` and `configurePreviewServer`) at the artifact's `BASE_PATH`, so dev and preview both run on a single port.
  - `GEMINI_API_KEY` is stored as a Replit Secret (not in code).
  - The VRM file lives at `public/personaje.vrm`.
  - PWA: `public/manifest.json`, `public/sw.js` (cache-first for same-origin and jsDelivr/unpkg, bypasses `/chat`), and `public/icon.svg`. `index.html` includes `<link rel="manifest">`, theme-color, apple-mobile-web-app meta tags, and registers the service worker on load.
  - The endpoint is mounted at `/chat` (not `/api/chat`) because the `api-server` artifact owns `paths = ["/api"]` and the Replit proxy would route any `/api/*` request to it instead of the vrm-viewer artifact.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
