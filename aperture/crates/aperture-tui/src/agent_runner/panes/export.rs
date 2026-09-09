//! Export pane — EXPORT verb (bare) → EXPORT.RESULT.
//!
//! v0.1 contract: the host hands the export pane a snapshot in
//! `payload.snapshot` and an output `payload.format` (`json`, `csv`, `ndjson`).
//! The pane formats and replies with the rendered string. The host writes
//! to disk / clipboard / download.

use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct ExportPane {
    id: &'static str,
}

impl ExportPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.export",
        }
    }
}

impl Agent for ExportPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("EXPORT") => {
                let format = env
                    .payload
                    .get("format")
                    .and_then(Value::as_str)
                    .unwrap_or("json")
                    .to_ascii_lowercase();
                let snapshot = env.payload.get("snapshot").cloned().unwrap_or(json!({}));
                let body = match format.as_str() {
                    "json" => serde_json::to_string_pretty(&snapshot).unwrap_or_default(),
                    "ndjson" => render_ndjson(&snapshot),
                    "csv" => render_csv(&snapshot),
                    _ => return vec![reply(
                        &env,
                        json!({"verb": "EXPORT.RESULT", "error": format!("unsupported format: {format}")}),
                    )],
                };
                vec![reply(
                    &env,
                    json!({"verb": "EXPORT.RESULT", "format": format, "body": body}),
                )]
            }
            _ => vec![],
        }
    }
}

fn render_ndjson(snapshot: &Value) -> String {
    if let Some(arr) = snapshot.as_array() {
        let mut lines = Vec::with_capacity(arr.len());
        for v in arr {
            lines.push(serde_json::to_string(v).unwrap_or_default());
        }
        lines.join("\n")
    } else {
        serde_json::to_string(snapshot).unwrap_or_default()
    }
}

fn render_csv(snapshot: &Value) -> String {
    let Some(arr) = snapshot.as_array() else {
        return String::new();
    };
    if arr.is_empty() {
        return String::new();
    }
    // Take column order from the first row's object keys.
    let Some(first) = arr[0].as_object() else {
        return String::new();
    };
    let cols: Vec<String> = first.keys().cloned().collect();
    let mut out = cols.join(",");
    for row in arr {
        let mut cells = Vec::with_capacity(cols.len());
        for c in &cols {
            let cell = row
                .get(c)
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            // Naive escape: wrap in quotes if it contains a comma, double-up internal quotes.
            let needs_quote = cell.contains(',') || cell.contains('"') || cell.contains('\n');
            if needs_quote {
                cells.push(format!("\"{}\"", cell.replace('"', "\"\"")));
            } else {
                cells.push(cell);
            }
        }
        out.push('\n');
        out.push_str(&cells.join(","));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runner::panes::test_helpers::req;
    use serde_json::json;

    #[tokio::test]
    async fn json_round_trip() {
        let mut p = ExportPane::new();
        let snapshot = json!({"focus": "AAPL", "panes": ["quote", "chart"]});
        let outs = p
            .handle(req(
                "EXPORT",
                json!({"format": "json", "snapshot": snapshot}),
            ))
            .await;
        assert_eq!(outs[0].payload["format"], "json");
        let body = outs[0].payload["body"].as_str().unwrap();
        assert!(body.contains("AAPL"));
    }

    #[tokio::test]
    async fn csv_renders_header_and_rows() {
        let mut p = ExportPane::new();
        let snapshot = json!([
            {"symbol": "AAPL", "last": 243.6},
            {"symbol": "TSLA", "last": 250.0},
        ]);
        let outs = p
            .handle(req(
                "EXPORT",
                json!({"format": "csv", "snapshot": snapshot}),
            ))
            .await;
        let body = outs[0].payload["body"].as_str().unwrap();
        let lines: Vec<&str> = body.lines().collect();
        // Column order comes from serde_json::Map iteration (alphabetical
        // when the `preserve_order` feature is off, which is our default).
        // Assert both columns are present without pinning ordering.
        let header_cols: std::collections::HashSet<_> = lines[0].split(',').collect();
        assert_eq!(
            header_cols,
            std::collections::HashSet::from(["symbol", "last"])
        );
        assert_eq!(lines.len(), 3);
    }

    #[tokio::test]
    async fn rejects_unsupported_format() {
        let mut p = ExportPane::new();
        let outs = p
            .handle(req(
                "EXPORT",
                json!({"format": "xlsx", "snapshot": {}}),
            ))
            .await;
        assert!(outs[0].payload["error"].is_string());
    }
}
