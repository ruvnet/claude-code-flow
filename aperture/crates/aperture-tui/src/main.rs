mod agent_runner;
mod app;
mod keymap_native;

use anyhow::{anyhow, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    // Headless agent mode: when `--agent=<id>` is passed, the binary speaks
    // newline-delimited `Envelope` JSON on stdio and never enters ratatui.
    if let Some(agent_id) = args.iter().find_map(|a| a.strip_prefix("--agent=")) {
        let matched = agent_runner::dispatch(agent_id).await?;
        if !matched {
            return Err(anyhow!(
                "unknown --agent=<id>: `{agent_id}` (known: {})",
                agent_runner::KNOWN_AGENTS.join(", ")
            ));
        }
        return Ok(());
    }

    let provider = args
        .iter()
        .find_map(|a| a.strip_prefix("--provider="))
        .unwrap_or("memory");
    app::run(provider).await
}
