//! Agent runtime: drives a single `Agent` over `StdioReader`/`StdioWriter`.
//!
//! A pane process is invoked with `--agent=<id>`; it reads newline-delimited
//! `Envelope` JSON from stdin, dispatches each one to the agent's `handle`
//! method, and writes any returned envelopes back on stdout. EOF terminates
//! cleanly.
//!
//! Helper functions (`make_id`, `now_iso`, `reply`) keep envelope construction
//! out of every pane impl and avoid pulling `chrono`/`ulid` into the workspace.

use crate::envelope::{Envelope, MessageType, Priority};
use crate::native_stdio::{StdioReader, StdioWriter, TransportError};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// A pane or service that consumes inbound envelopes and emits outbound
/// envelopes. Implementors are spawned by `run_agent`.
pub trait Agent {
    fn id(&self) -> &str;
    fn handle(
        &mut self,
        env: Envelope,
    ) -> impl Future<Output = Vec<Envelope>> + Send;
}

/// Drive an `Agent` over stdio until EOF. Each inbound line is one
/// `Envelope`; each outbound `Envelope` from `handle` is written as one
/// line. Malformed lines are reported on stderr and skipped.
pub async fn run_agent<A>(mut agent: A) -> Result<(), TransportError>
where
    A: Agent + Send,
{
    let mut reader = StdioReader::new();
    let mut writer = StdioWriter::new();

    loop {
        match reader.next().await {
            Ok(env) => {
                let outs = agent.handle(env).await;
                for out in outs {
                    writer.send(&out).await?;
                }
            }
            Err(TransportError::Eof) => return Ok(()),
            Err(TransportError::Json(e)) => {
                eprintln!("aperture-swarm: skipping malformed envelope: {e}");
                continue;
            }
            Err(TransportError::LineTooLong) => {
                eprintln!("aperture-swarm: skipping oversized line");
                continue;
            }
            Err(TransportError::Io(e)) => return Err(TransportError::Io(e)),
        }
    }
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Generate a sortable, process-local unique id. Format is
/// `<unix-millis-base36>-<pid-base36>-<counter-base36>` — sortable by time,
/// unique within and across processes started at different milliseconds.
/// Not cryptographic; not a true ULID, but stable, dependency-free, and
/// sufficient for the wire protocol.
pub fn make_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}-{}-{}",
        to_base36(millis),
        to_base36(pid),
        to_base36(n)
    )
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const ALPHA: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::with_capacity(13);
    while n > 0 {
        out.push(ALPHA[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Format the current UTC time as ISO-8601 with millisecond precision and a
/// trailing `Z`, e.g. `2026-05-10T15:04:05.123Z`. Implemented by hand from
/// `SystemTime::now()` to avoid the `chrono`/`time` dependency.
pub fn now_iso() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_iso_millis(dur.as_secs() as i64, dur.subsec_millis())
}

fn format_iso_millis(unix_secs: i64, millis: u32) -> String {
    let (y, mo, d, h, mi, s) = unix_to_civil(unix_secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, h, mi, s, millis
    )
}

/// Howard Hinnant's days-from-civil inverse: convert unix seconds to civil
/// (year, month, day, hour, minute, second). Public-domain algorithm,
/// well-known and verified against `chrono` for 1970..2100.
fn unix_to_civil(unix_secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400) as u32;
    let h = secs_of_day / 3600;
    let mi = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;

    // Days since 1970-01-01 -> civil date (Hinnant).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let mo = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = y + if mo <= 2 { 1 } else { 0 };

    (y as i32, mo as u32, d as u32, h, mi, s)
}

/// Build a direct reply to `req`: swaps `from`/`to`, copies `correlation_id`,
/// fresh `id`/`timestamp`. Priority and ttl inherit from the request so a
/// caller's deadline survives the round trip.
pub fn reply(req: &Envelope, payload: serde_json::Value) -> Envelope {
    Envelope {
        id: make_id(),
        message_type: MessageType::Direct,
        from: req.to.clone(),
        to: req.from.clone(),
        payload,
        timestamp: now_iso(),
        priority: req.priority,
        requires_ack: false,
        ttl_ms: req.ttl_ms,
        correlation_id: req.correlation_id.clone().or_else(|| Some(req.id.clone())),
    }
}

/// Build a fresh outbound envelope (no inbound to reply to).
pub fn envelope(
    from: impl Into<String>,
    to: impl Into<String>,
    payload: serde_json::Value,
    priority: Priority,
) -> Envelope {
    Envelope {
        id: make_id(),
        message_type: MessageType::Direct,
        from: from.into(),
        to: to.into(),
        payload,
        timestamp: now_iso(),
        priority,
        requires_ack: false,
        ttl_ms: 5_000,
        correlation_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn make_id_is_unique() {
        let a = make_id();
        let b = make_id();
        assert_ne!(a, b);
        assert!(!a.is_empty());
    }

    #[test]
    fn now_iso_format() {
        let s = now_iso();
        assert_eq!(s.len(), 24, "expected `YYYY-MM-DDTHH:MM:SS.mmmZ`, got {s}");
        assert!(s.ends_with('Z'));
        assert!(s.chars().nth(4) == Some('-'));
        assert!(s.chars().nth(10) == Some('T'));
    }

    #[test]
    fn unix_to_civil_known_dates() {
        // 2026-05-10 15:04:05 UTC = 1778425445
        let (y, mo, d, h, mi, s) = unix_to_civil(1_778_425_445);
        assert_eq!((y, mo, d, h, mi, s), (2026, 5, 10, 15, 4, 5));
        // 1970-01-01 00:00:00
        assert_eq!(unix_to_civil(0), (1970, 1, 1, 0, 0, 0));
        // 2000-02-29 leap day
        let (y, mo, d, _, _, _) = unix_to_civil(951_782_400);
        assert_eq!((y, mo, d), (2000, 2, 29));
    }

    #[test]
    fn reply_swaps_from_to_and_keeps_correlation() {
        let req = Envelope {
            id: "req-1".into(),
            message_type: MessageType::Direct,
            from: "aperture:cmdbar".into(),
            to: "aperture:pane.quote".into(),
            payload: json!({"verb": "DESC", "symbol": "AAPL"}),
            timestamp: "2026-05-10T15:04:05.000Z".into(),
            priority: Priority::High,
            requires_ack: true,
            ttl_ms: 3000,
            correlation_id: Some("corr-9".into()),
        };
        let r = reply(&req, json!({"verb": "QUOTE.RESULT"}));
        assert_eq!(r.from, "aperture:pane.quote");
        assert_eq!(r.to, "aperture:cmdbar");
        assert_eq!(r.correlation_id.as_deref(), Some("corr-9"));
        assert_eq!(r.priority, Priority::High);
        assert_eq!(r.ttl_ms, 3000);
        assert_eq!(r.message_type, MessageType::Direct);
    }

    #[test]
    fn reply_without_correlation_uses_request_id() {
        let req = Envelope {
            id: "req-2".into(),
            message_type: MessageType::Direct,
            from: "a".into(),
            to: "b".into(),
            payload: json!({}),
            timestamp: "t".into(),
            priority: Priority::Normal,
            requires_ack: false,
            ttl_ms: 0,
            correlation_id: None,
        };
        let r = reply(&req, json!({}));
        assert_eq!(r.correlation_id.as_deref(), Some("req-2"));
    }
}
