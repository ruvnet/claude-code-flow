//! TTL cache keyed by (method, args). Reduces `claude -p` budget churn
//! when the same pane is queried repeatedly within the freshness window.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

#[derive(Debug, Default)]
pub struct TtlCache {
    inner: Mutex<HashMap<String, (Instant, Value)>>,
}

impl TtlCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str, ttl: Duration) -> Option<Value> {
        let mut guard = self.inner.lock().ok()?;
        if let Some((stored_at, value)) = guard.get(key) {
            if stored_at.elapsed() < ttl {
                return Some(value.clone());
            }
            guard.remove(key);
        }
        None
    }

    pub fn put(&self, key: String, value: Value) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(key, (Instant::now(), value));
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::thread::sleep;

    #[test]
    fn returns_value_within_ttl() {
        let c = TtlCache::new();
        c.put("k".into(), json!({"v": 1}));
        assert_eq!(c.get("k", Duration::from_secs(60)), Some(json!({"v": 1})));
    }

    #[test]
    fn evicts_after_ttl() {
        let c = TtlCache::new();
        c.put("k".into(), json!({"v": 1}));
        sleep(Duration::from_millis(20));
        assert!(c.get("k", Duration::from_millis(10)).is_none());
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn distinct_keys_isolated() {
        let c = TtlCache::new();
        c.put("a".into(), json!(1));
        c.put("b".into(), json!(2));
        assert_eq!(c.get("a", Duration::from_secs(60)), Some(json!(1)));
        assert_eq!(c.get("b", Duration::from_secs(60)), Some(json!(2)));
    }
}
