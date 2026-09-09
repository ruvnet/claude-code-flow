import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import path from "path";

// Aperture UI build config.
// The widget-mode + Supabase Edge plumbing from upstream goal_ui has been
// dropped; this is a single SPA whose React Router app lives at `/aperture`
// and which mounts the `aperture-wasm` artifact (loaded from
// `/aperture/aperture_wasm.js`) and posts swarm-bus envelopes via
// `window.postMessage`.

// The `aperture-wasm` artifact (`aperture_wasm.js` + `aperture_wasm_bg.wasm`)
// is built out-of-band by `plugins/ruflo-aperture/scripts/build-wasm.sh` and
// staged into `public/aperture/`. It must be served *raw* — the wasm-bindgen
// glue is already valid ESM, and Vite's dev transform refuses to process any
// `.js` resolved into `public/` ("this file is in /public ... should not be
// imported from source code"). This plugin intercepts requests for the
// artifact *files* ahead of Vite's transform middleware and streams them from
// disk; for a missing artifact it returns a plain 404 (so `loadAperture()`
// shows its "build required" notice instead of tripping the HMR error
// overlay). It deliberately does NOT touch the bare `/aperture` document
// route or any other path — those fall through to Vite's normal handling /
// the SPA fallback.
const ARTIFACT_FILE = /\.(js|mjs|wasm|ts|json)$/;

function apertureWasmStatic(): Plugin {
  const dir = path.resolve(__dirname, "public", "aperture");
  const types: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".ts": "text/javascript",
    ".json": "application/json",
  };
  return {
    name: "aperture-wasm-static",
    configureServer(server) {
      // Registered directly in `configureServer` → runs *before* Vite's
      // internal middlewares (including the JS transform middleware).
      server.middlewares.use("/aperture", (req, res, next) => {
        const rel = (req.url ?? "").split("?")[0].replace(/^\/+/, "");
        // Only handle requests for an artifact file. The SPA document route
        // (`/aperture`), client-side sub-routes, and anything that isn't a
        // built artifact filename all fall through to Vite.
        if (!rel || !ARTIFACT_FILE.test(rel)) return next();
        const file = path.join(dir, rel);
        if (!file.startsWith(dir + path.sep)) return next();
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "no-cache");
          fs.createReadStream(file).pipe(res).on("error", next);
          return;
        }
        // The artifact path was requested but hasn't been built — a plain
        // 404 (not a Vite transform error → no overlay) lets `loadAperture()`
        // catch it and render its "run build-wasm.sh" notice.
        res.statusCode = 404;
        res.end("aperture-wasm artifact not built (run plugins/ruflo-aperture/scripts/build-wasm.sh)");
      });
    },
  };
}

export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [apertureWasmStatic(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
