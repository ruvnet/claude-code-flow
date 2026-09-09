//! WASM transport: JS `postMessage` to a host worker that forwards into the
//! ruflo swarm `message-bus.ts`.

use crate::envelope::Envelope;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = window, js_name = postMessage)]
    fn window_post_message(msg: JsValue);
}

/// Serialise an envelope and post it on `window`. The host SvelteKit page is
/// expected to install a `MessageChannel` listener that relays the payload to
/// `message-bus.ts`.
pub fn send(env: &Envelope) -> Result<(), JsValue> {
    let v = serde_wasm_bindgen::to_value(env).map_err(|e| JsValue::from_str(&e.to_string()))?;
    window_post_message(v);
    Ok(())
}

/// Decode an inbound `MessageEvent.data` JS value into an [`Envelope`].
pub fn decode(data: JsValue) -> Result<Envelope, JsValue> {
    serde_wasm_bindgen::from_value(data).map_err(|e| JsValue::from_str(&e.to_string()))
}
