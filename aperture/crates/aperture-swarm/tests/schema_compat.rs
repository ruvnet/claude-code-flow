//! Cross-check that the Rust `Envelope` is wire-compatible with the
//! TypeScript `Message` struct in `v3/@claude-flow/swarm/src/types.ts`.
//!
//! We hand-write JSON fixtures that exactly mirror what
//! `JSON.stringify(message)` produces on the TS side, then deserialise
//! them into `Envelope`, re-serialise, deserialise again, and assert
//! every step round-trips.
//!
//! Coverage:
//!   * Every `MessageType` variant
//!   * Every `Priority` variant
//!   * `correlationId` present and absent (must be omitted from output
//!     when None — `skip_serializing_if`).
//!   * Malformed JSON produces a serde error, not a panic.

use aperture_swarm::{Envelope, MessageType, Priority};

/// Build a JSON fixture for a given (type, priority) combination.
fn fixture(message_type: &str, priority: &str, with_correlation: bool) -> String {
    let corr = if with_correlation {
        r#","correlationId":"corr-xyz""#
    } else {
        ""
    };
    format!(
        r#"{{"id":"01HXY0000000000000000000K5","type":"{message_type}","from":"aperture:cmdbar","to":"broadcast","payload":{{"verb":"FOCUS","symbol":"AAPL"}},"timestamp":"2026-05-10T15:04:05.123Z","priority":"{priority}","requiresAck":false,"ttlMs":3000{corr}}}"#
    )
}

#[test]
fn every_message_type_round_trips() {
    let cases: &[(&str, MessageType)] = &[
        ("task_assign", MessageType::TaskAssign),
        ("task_complete", MessageType::TaskComplete),
        ("task_fail", MessageType::TaskFail),
        ("heartbeat", MessageType::Heartbeat),
        ("status_update", MessageType::StatusUpdate),
        ("consensus_propose", MessageType::ConsensusPropose),
        ("consensus_vote", MessageType::ConsensusVote),
        ("consensus_commit", MessageType::ConsensusCommit),
        ("topology_update", MessageType::TopologyUpdate),
        ("agent_join", MessageType::AgentJoin),
        ("agent_leave", MessageType::AgentLeave),
        ("broadcast", MessageType::Broadcast),
        ("direct", MessageType::Direct),
    ];

    for (wire, expected) in cases {
        let json = fixture(wire, "normal", false);
        let env: Envelope = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("failed to deserialize {wire}: {e}"));
        assert_eq!(env.message_type, *expected, "MessageType mismatch for {wire}");

        // Re-serialize and confirm the wire token is exactly what we sent.
        let s = serde_json::to_string(&env).unwrap();
        assert!(
            s.contains(&format!(r#""type":"{wire}""#)),
            "re-serialized output missing type token {wire:?}: {s}"
        );

        // Round-trip a second time.
        let env2: Envelope = serde_json::from_str(&s).unwrap();
        assert_eq!(env, env2, "second round-trip diverged for {wire}");
    }
}

#[test]
fn every_priority_round_trips() {
    let cases: &[(&str, Priority)] = &[
        ("urgent", Priority::Urgent),
        ("high", Priority::High),
        ("normal", Priority::Normal),
        ("low", Priority::Low),
    ];
    for (wire, expected) in cases {
        let json = fixture("direct", wire, false);
        let env: Envelope = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("failed to deserialize priority {wire}: {e}"));
        assert_eq!(env.priority, *expected, "Priority mismatch for {wire}");

        let s = serde_json::to_string(&env).unwrap();
        assert!(
            s.contains(&format!(r#""priority":"{wire}""#)),
            "re-serialized output missing priority token {wire:?}: {s}"
        );

        let env2: Envelope = serde_json::from_str(&s).unwrap();
        assert_eq!(env, env2, "second round-trip diverged for priority {wire}");
    }
}

#[test]
fn correlation_id_present_round_trips() {
    let json = fixture("direct", "high", true);
    let env: Envelope = serde_json::from_str(&json).unwrap();
    assert_eq!(env.correlation_id.as_deref(), Some("corr-xyz"));

    let s = serde_json::to_string(&env).unwrap();
    assert!(
        s.contains(r#""correlationId":"corr-xyz""#),
        "correlationId must be emitted when Some: {s}"
    );
    let env2: Envelope = serde_json::from_str(&s).unwrap();
    assert_eq!(env, env2);
}

#[test]
fn correlation_id_absent_deserialises_as_none_and_is_omitted_on_output() {
    let json = fixture("broadcast", "normal", false);
    // Sanity: the input itself does NOT mention correlationId.
    assert!(!json.contains("correlationId"), "fixture should not contain correlationId");

    let env: Envelope = serde_json::from_str(&json).unwrap();
    assert!(
        env.correlation_id.is_none(),
        "absent correlationId must deserialise to None"
    );

    let s = serde_json::to_string(&env).unwrap();
    assert!(
        !s.contains("correlationId"),
        "None correlation_id must be skipped on output: {s}"
    );

    // Round-trip again to confirm idempotence.
    let env2: Envelope = serde_json::from_str(&s).unwrap();
    assert_eq!(env, env2);
    assert!(env2.correlation_id.is_none());
}

#[test]
fn all_required_fields_present_in_output() {
    // For a direct message with correlationId, every required wire field
    // must be present in the JSON. This catches accidental rename or skip
    // mistakes on the Rust side.
    let json = fixture("direct", "high", true);
    let env: Envelope = serde_json::from_str(&json).unwrap();
    let s = serde_json::to_string(&env).unwrap();
    for needle in [
        r#""id":"#,
        r#""type":"#,
        r#""from":"#,
        r#""to":"#,
        r#""payload":"#,
        r#""timestamp":"#,
        r#""priority":"#,
        r#""requiresAck":"#,
        r#""ttlMs":"#,
        r#""correlationId":"#,
    ] {
        assert!(
            s.contains(needle),
            "expected {needle} in serialized envelope: {s}"
        );
    }
}

#[test]
fn malformed_json_returns_serde_error_not_panic() {
    // Missing `type` field.
    let bad1 = r#"{"id":"x","from":"a","to":"b","payload":{},"timestamp":"t","priority":"low","requiresAck":false,"ttlMs":1}"#;
    assert!(
        serde_json::from_str::<Envelope>(bad1).is_err(),
        "missing type should error"
    );

    // Wrong type for `requiresAck` (string instead of bool).
    let bad2 = r#"{"id":"x","type":"direct","from":"a","to":"b","payload":{},"timestamp":"t","priority":"low","requiresAck":"yes","ttlMs":1}"#;
    assert!(
        serde_json::from_str::<Envelope>(bad2).is_err(),
        "wrong type should error"
    );

    // Unknown MessageType value.
    let bad3 = r#"{"id":"x","type":"frobnicate","from":"a","to":"b","payload":{},"timestamp":"t","priority":"low","requiresAck":false,"ttlMs":1}"#;
    assert!(
        serde_json::from_str::<Envelope>(bad3).is_err(),
        "unknown MessageType should error"
    );

    // Outright garbage.
    let bad4 = "{not even valid json";
    assert!(
        serde_json::from_str::<Envelope>(bad4).is_err(),
        "garbage JSON should error"
    );
}

#[test]
fn payload_is_a_passthrough_serde_json_value() {
    // Payload is `serde_json::Value`, so any JSON shape (including arrays
    // and unicode) must round-trip.
    let json = r#"{"id":"x","type":"task_assign","from":"orchestrator","to":"agent.coder","payload":["a",{"k":"v"},42,null],"timestamp":"2026-05-10T15:04:05.123Z","priority":"urgent","requiresAck":true,"ttlMs":60000,"correlationId":"task-001"}"#;
    let env: Envelope = serde_json::from_str(json).unwrap();
    assert_eq!(env.message_type, MessageType::TaskAssign);
    assert_eq!(env.priority, Priority::Urgent);
    assert!(env.requires_ack);
    assert_eq!(env.ttl_ms, 60_000);
    assert_eq!(env.correlation_id.as_deref(), Some("task-001"));

    let s = serde_json::to_string(&env).unwrap();
    let env2: Envelope = serde_json::from_str(&s).unwrap();
    assert_eq!(env, env2);
}

#[test]
fn broadcast_to_all_round_trips() {
    // Mirrors the literal example in the architecture plan: a FOCUS
    // broadcast on `SYMBOL VERB GO`.
    let json = r#"{"id":"01","type":"broadcast","from":"aperture:cmdbar","to":"broadcast","payload":{"verb":"FOCUS","symbol":"AAPL","panes":["pane.quote#1","pane.chart#1"]},"timestamp":"2026-05-10T15:04:05.123Z","priority":"normal","requiresAck":false,"ttlMs":3000}"#;
    let env: Envelope = serde_json::from_str(json).unwrap();
    assert_eq!(env.message_type, MessageType::Broadcast);
    assert_eq!(env.to, "broadcast");
    assert_eq!(env.priority, Priority::Normal);
    assert!(env.correlation_id.is_none());
    let s = serde_json::to_string(&env).unwrap();
    let env2: Envelope = serde_json::from_str(&s).unwrap();
    assert_eq!(env, env2);
}
