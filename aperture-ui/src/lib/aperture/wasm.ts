import type { ApertureApp, ApertureModule } from "./types";

/// Lazy-load the wasm-pack `aperture_wasm` artifact. The artifact is built
/// out-of-band by `plugins/ruflo-aperture/scripts/build-wasm.sh` and copied
/// into `public/aperture/`. If the artifact is missing the loader rejects
/// so the page can render a friendly "build required" notice.

const ARTIFACT_PATH = "/aperture/aperture_wasm.js";

let cached: { mod: ApertureModule; app: ApertureApp } | null = null;
let inflight: Promise<{ mod: ApertureModule; app: ApertureApp }> | null = null;

export async function loadAperture(): Promise<{ mod: ApertureModule; app: ApertureApp }> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    // @vite-ignore: artifact is generated at build time, not under src/
    const m = (await import(/* @vite-ignore */ ARTIFACT_PATH)) as ApertureModule;
    await m.default();
    m.start("aperture-mount");
    const app = new m.App();
    cached = { mod: m, app };
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export const ARTIFACT_BUILD_HINT =
  "plugins/ruflo-aperture/scripts/build-wasm.sh && cp -r aperture/crates/aperture-wasm/pkg aperture-ui/public/aperture";
