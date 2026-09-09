use serde::{Deserialize, Serialize};

/// Field-identical to `v3/@claude-flow/swarm/src/types.ts:Message`.
///
/// `timestamp` is serialised as an ISO-8601 string because TypeScript
/// `JSON.stringify(Date)` emits ISO-8601; we keep it as `String` to avoid
/// pulling a date-time crate into both targets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    pub id: String,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    pub from: String,
    pub to: String,
    pub payload: serde_json::Value,
    pub timestamp: String,
    pub priority: Priority,
    #[serde(rename = "requiresAck")]
    pub requires_ack: bool,
    #[serde(rename = "ttlMs")]
    pub ttl_ms: u64,
    #[serde(rename = "correlationId", skip_serializing_if = "Option::is_none", default)]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    TaskAssign,
    TaskComplete,
    TaskFail,
    Heartbeat,
    StatusUpdate,
    ConsensusPropose,
    ConsensusVote,
    ConsensusCommit,
    TopologyUpdate,
    AgentJoin,
    AgentLeave,
    Broadcast,
    Direct,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Urgent,
    High,
    Normal,
    Low,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_direct() {
        let env = Envelope {
            id: "01HXY".into(),
            message_type: MessageType::Direct,
            from: "aperture:pane.chart#1".into(),
            to: "aperture:agent.data".into(),
            payload: json!({"verb": "OHLCV", "symbol": "AAPL", "period": "1D"}),
            timestamp: "2026-05-10T15:04:05.123Z".into(),
            priority: Priority::High,
            requires_ack: false,
            ttl_ms: 5000,
            correlation_id: Some("chart-load-7".into()),
        };
        let s = serde_json::to_string(&env).unwrap();
        assert!(s.contains(r#""type":"direct""#));
        assert!(s.contains(r#""requiresAck":false"#));
        assert!(s.contains(r#""ttlMs":5000"#));
        assert!(s.contains(r#""correlationId":"chart-load-7""#));

        let back: Envelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back, env);
    }

    #[test]
    fn correlation_id_omitted_when_none() {
        let env = Envelope {
            id: "01".into(),
            message_type: MessageType::Broadcast,
            from: "aperture:cmdbar".into(),
            to: "broadcast".into(),
            payload: json!({"verb": "FOCUS", "symbol": "AAPL"}),
            timestamp: "2026-05-10T15:04:05.123Z".into(),
            priority: Priority::Normal,
            requires_ack: false,
            ttl_ms: 3000,
            correlation_id: None,
        };
        let s = serde_json::to_string(&env).unwrap();
        assert!(!s.contains("correlationId"));
    }
}
