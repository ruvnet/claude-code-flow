//! Hand-written `window.fetch` wrapper. We deliberately avoid `gloo-net` /
//! `reqwest` to keep this crate's dep count low. All requests are routed via
//! the SvelteKit `/api/aperture/fetch?u=...` proxy so API keys stay in
//! `.env` server-side and never reach the WASM bundle.

use js_sys::{Function, Object, Promise, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortController, Response};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = window, js_name = fetch)]
    fn window_fetch(input: &JsValue, init: &JsValue) -> Promise;

    #[wasm_bindgen(js_namespace = window, js_name = setTimeout)]
    fn window_set_timeout(handler: &Function, timeout_ms: u32) -> i32;

    #[wasm_bindgen(js_namespace = window, js_name = clearTimeout)]
    fn window_clear_timeout(id: i32);
}

/// Path of the SvelteKit CORS proxy. Always relative — the WASM bundle is
/// served from the same origin as ruvocal.
const PROXY_PATH: &str = "/api/aperture/fetch";

/// Hard ceiling on a single fetch. The proxy enforces its own upstream
/// timeout; this is defence-in-depth so a hung browser-side connection can't
/// block a pane indefinitely.
const FETCH_TIMEOUT_MS: u32 = 30_000;

/// Fetch JSON from `upstream_url` via the proxy. Returns the response body as
/// a UTF-8 string; the caller decides how to parse it.
///
/// Defence-in-depth on top of the SvelteKit proxy:
///   * a 30s `AbortController`-backed timeout, and
///   * content-type validation: only `application/json` or `text/*` bodies
///     are accepted.
pub async fn fetch_json(upstream_url: &str) -> Result<String, JsValue> {
    let proxied = format!("{PROXY_PATH}?u={}", encode_uri_component(upstream_url));

    let controller = AbortController::new()?;
    let signal = controller.signal();

    let init = Object::new();
    Reflect::set(
        &init,
        &JsValue::from_str("method"),
        &JsValue::from_str("GET"),
    )?;
    Reflect::set(&init, &JsValue::from_str("signal"), &signal)?;

    // Schedule abort after FETCH_TIMEOUT_MS. Closure must outlive the await
    // point; we drop it after `clearTimeout`.
    let abort_controller = controller.clone();
    let abort_cb = Closure::once(move || {
        abort_controller.abort();
    });
    let timeout_id = window_set_timeout(abort_cb.as_ref().unchecked_ref(), FETCH_TIMEOUT_MS);

    let promise = window_fetch(&JsValue::from_str(&proxied), &init);
    let resp_result = JsFuture::from(promise).await;

    // Race resolved (either way) — cancel the pending timeout and let the
    // closure drop.
    window_clear_timeout(timeout_id);
    drop(abort_cb);

    let resp_val = resp_result.map_err(|e| {
        // Aborts surface as DOMException("AbortError"); re-wrap with a
        // human-readable hint so panes can show something useful.
        JsValue::from_str(&format!(
            "aperture fetch: request failed or timed out after {}ms ({:?})",
            FETCH_TIMEOUT_MS, e
        ))
    })?;
    let resp: Response = resp_val.dyn_into()?;
    if !resp.ok() {
        return Err(JsValue::from_str(&format!(
            "aperture fetch: upstream returned {}",
            resp.status()
        )));
    }

    // Defence-in-depth: refuse anything that isn't JSON or text. The proxy
    // already filters but the wasm caller shouldn't trust it blindly.
    if let Ok(Some(ct)) = resp.headers().get("content-type") {
        let ct_lower = ct.to_ascii_lowercase();
        let accepted = ct_lower.starts_with("application/json") || ct_lower.starts_with("text/");
        if !accepted {
            return Err(JsValue::from_str(&format!(
                "aperture fetch: rejected content-type '{}' (expected application/json or text/*)",
                ct
            )));
        }
    }

    let text_promise = resp.text()?;
    let text_val = JsFuture::from(text_promise).await?;
    text_val
        .as_string()
        .ok_or_else(|| JsValue::from_str("aperture fetch: response body was not a string"))
}

/// Browser `encodeURIComponent` shim (sufficient for the URL slot only).
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// NB: unit tests live in `keymap_web` (target-agnostic logic). `fetch_bridge`
// is wasm32-only because it depends on `web_sys::Response`; we exercise it via
// the `wasm-pack test --headless --chrome` suite added in Phase B.
