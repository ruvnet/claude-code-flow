//! Pane-as-agent implementations. One module per pane keeps each
//! `Agent` implementation under 200 lines and lets independent workers
//! own disjoint files.
//!
//! v0.1 panes (active):
//!   `quote`, `chart`, `watchlist`, `oracle`,
//!   `news`, `macro_pane`, `yields`, `fx`, `options`, `insider`,
//!   `financials`, `crypto`, `risk`, `corpact`, `inbox`, `export`.

pub mod quote;
pub mod chart;
pub mod watchlist;
pub mod oracle;

pub mod news;
pub mod macro_pane;
pub mod yields;
pub mod fx;
pub mod options;
pub mod insider;
pub mod financials;
pub mod crypto;
pub mod risk;
pub mod corpact;
pub mod inbox;
pub mod export;

pub mod earnings;
pub mod movers;
pub mod screen;
pub mod members;
pub mod ivol;
pub mod tech;
pub mod corr;
pub mod filings;
pub mod order;
pub mod sentiment;

pub use quote::QuotePane;
pub use chart::ChartPane;
pub use watchlist::WatchlistPane;
pub use oracle::OraclePane;

pub use news::NewsPane;
pub use macro_pane::MacroPane;
pub use yields::YieldsPane;
pub use fx::FxPane;
pub use options::OptionsPane;
pub use insider::InsiderPane;
pub use financials::FinancialsPane;
pub use crypto::CryptoPane;
pub use risk::RiskPane;
pub use corpact::CorpactPane;
pub use inbox::InboxPane;
pub use export::ExportPane;

pub use earnings::EarningsPane;
pub use movers::MoversPane;
pub use screen::ScreenPane;
pub use members::MembersPane;
pub use ivol::IvolPane;
pub use tech::TechPane;
pub use corr::CorrPane;
pub use filings::FilingsPane;
pub use order::OrderPane;
pub use sentiment::SentimentPane;

#[cfg(test)]
pub(crate) mod test_helpers {
    use aperture_swarm::{Envelope, MessageType, Priority};
    use serde_json::{json, Value};

    pub fn req(verb_s: &str, extra: Value) -> Envelope {
        let mut payload = json!({"verb": verb_s});
        if let (Some(p), Some(extra_obj)) = (payload.as_object_mut(), extra.as_object()) {
            for (k, v) in extra_obj {
                p.insert(k.clone(), v.clone());
            }
        }
        Envelope {
            id: "test-1".into(),
            message_type: MessageType::Direct,
            from: "aperture:cmdbar".into(),
            to: "aperture:pane.x".into(),
            payload,
            timestamp: "2026-05-10T15:04:05.000Z".into(),
            priority: Priority::Normal,
            requires_ack: false,
            ttl_ms: 5000,
            correlation_id: Some("corr-1".into()),
        }
    }
}
