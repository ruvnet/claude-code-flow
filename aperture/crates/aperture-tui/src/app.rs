//! Native shell. v0.1 wires four panes (Quote, Chart, Watchlist, Oracle) to
//! a single `DataSource` directly. Phase B replaces the direct calls with
//! `aperture-swarm` `Envelope` traffic.

use std::io;
use std::time::Duration;

use anyhow::Result;
use aperture_core::{parse, Verb};
use aperture_data::{DataSource, MemoryDataSource};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;

use crate::keymap_native::handle_key;

pub async fn run(provider: &str) -> Result<()> {
    let source: Box<dyn DataSource> = match provider {
        "memory" => Box::new(MemoryDataSource),
        #[cfg(feature = "provider-claude")]
        "claude" => Box::new(aperture_providers_claude::ClaudeResearcher::new(
            MemoryDataSource,
        )),
        #[cfg(not(feature = "provider-claude"))]
        "claude" => anyhow::bail!(
            "provider `claude` requires building with `--features provider-claude`"
        ),
        #[cfg(feature = "provider-managed-agents")]
        "managed-agents" => {
            // Reads ANTHROPIC_API_KEY then ANTHROPIC_KEY. Surface the
            // helpful error when neither is set.
            let cfg = aperture_providers_managed_agents::Config::from_env()
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Box::new(aperture_providers_managed_agents::ManagedAgentsResearcher::new(
                MemoryDataSource, cfg,
            ))
        }
        #[cfg(not(feature = "provider-managed-agents"))]
        "managed-agents" => anyhow::bail!(
            "provider `managed-agents` requires building with `--features provider-managed-agents`"
        ),
        other => anyhow::bail!(
            "unknown provider: {other} \
             (known: `memory`, `claude` [feature `provider-claude`], \
              `managed-agents` [feature `provider-managed-agents`])"
        ),
    };

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut state = AppState::new();

    let result = main_loop(&mut terminal, &mut state, source.as_ref()).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}

pub struct AppState {
    pub input: String,
    pub log: Vec<String>,
    pub focus_symbol: Option<String>,
    pub watchlist: Vec<String>,
    pub quote_lines: Vec<String>,
    pub chart_lines: Vec<String>,
    pub oracle_lines: Vec<String>,
    pub should_quit: bool,
}

impl AppState {
    fn new() -> Self {
        Self {
            input: String::new(),
            log: vec!["Aperture v0.1 — type `HELP GO`".into()],
            focus_symbol: None,
            watchlist: Vec::new(),
            quote_lines: vec!["(no symbol)".into()],
            chart_lines: vec!["(no symbol)".into()],
            oracle_lines: vec!["(idle)".into()],
            should_quit: false,
        }
    }
}

async fn main_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut AppState,
    source: &dyn DataSource,
) -> Result<()> {
    while !state.should_quit {
        terminal.draw(|f| draw(f, state))?;

        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    handle_key(state, key.code).await;
                    if let KeyCode::Enter = key.code {
                        let line = std::mem::take(&mut state.input);
                        execute_line(state, source, &line).await;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn execute_line(state: &mut AppState, source: &dyn DataSource, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    state.log.push(format!("> {trimmed}"));

    match parse(trimmed) {
        Err(e) => state.log.push(format!("error: {e}")),
        Ok(cmd) => match cmd.verb {
            Verb::Help => {
                state.log.push(
                    "verbs: HELP CLS EXIT LIST  DESC CHART WATCH UNWATCH ASK CRYPTO".into(),
                );
                state.log.push("form: `SYMBOL VERB ARG* GO`".into());
            }
            Verb::Cls => state.log.clear(),
            Verb::Exit => state.should_quit = true,
            Verb::List => {
                state.log.push(if state.watchlist.is_empty() {
                    "watchlist empty".into()
                } else {
                    format!("watchlist: {}", state.watchlist.join(", "))
                });
            }
            Verb::Watch => {
                if let Some(s) = cmd.symbol.clone() {
                    if !state.watchlist.contains(&s) {
                        state.watchlist.push(s.clone());
                    }
                    state.log.push(format!("watching {s}"));
                }
            }
            Verb::Unwatch => {
                if let Some(s) = cmd.symbol.clone() {
                    state.watchlist.retain(|x| x != &s);
                    state.log.push(format!("unwatched {s}"));
                }
            }
            Verb::Desc | Verb::Chart | Verb::Crypto => {
                let Some(sym) = cmd.symbol.clone() else {
                    state.log.push("error: verb requires a symbol".into());
                    return;
                };
                state.focus_symbol = Some(sym.clone());
                match source.quote(&sym).await {
                    Ok(q) => {
                        state.quote_lines = vec![
                            format!("{}  last {:.2}  ({:+.2}%)", q.symbol, q.last, q.change_pct),
                            format!(
                                "bid {}  ask {}",
                                q.bid.map(|x| format!("{:.2}", x)).unwrap_or_else(|| "-".into()),
                                q.ask.map(|x| format!("{:.2}", x)).unwrap_or_else(|| "-".into())
                            ),
                        ];
                    }
                    Err(e) => state.quote_lines = vec![format!("quote error: {e}")],
                }
                if matches!(cmd.verb, Verb::Chart) {
                    let range = cmd.args.first().map(|a| a.as_str()).unwrap_or("1M");
                    match source.ohlcv(&sym, range).await {
                        Ok(candles) => {
                            state.chart_lines = render_ascii_chart(&candles);
                        }
                        Err(e) => state.chart_lines = vec![format!("ohlcv error: {e}")],
                    }
                }
            }
            Verb::Ask => {
                let prompt = cmd
                    .args
                    .first()
                    .map(|a| a.as_str().to_string())
                    .unwrap_or_default();
                state.oracle_lines = vec![
                    format!("Q: {prompt}"),
                    "A: (oracle pane will route to ruflo-neural-trader in Phase C)".into(),
                ];
            }
            Verb::News
            | Verb::Macro
            | Verb::Yields
            | Verb::Fx
            | Verb::Options
            | Verb::Insider
            | Verb::Financials
            | Verb::Risk
            | Verb::Corpact
            | Verb::Inbox
            | Verb::Export
            | Verb::Earnings
            | Verb::Movers
            | Verb::Screen
            | Verb::Members
            | Verb::Ivol
            | Verb::Tech
            | Verb::Corr
            | Verb::Filings
            | Verb::Order
            | Verb::Blotter
            | Verb::Sentiment => {
                // Wide capability surface — these verbs are served by the
                // dedicated `--agent=pane.<id>` processes via the swarm bus.
                // The in-process ratatui shell only renders the four core
                // panes; the WASM/SvelteKit host renders the full grid.
                state
                    .log
                    .push(format!("verb {:?} → pane.{} (use --agent=pane.{} or browser shell)",
                        cmd.verb,
                        verb_route(&cmd.verb),
                        verb_route(&cmd.verb),
                    ));
            }
        },
    }
}

fn verb_route(v: &Verb) -> &'static str {
    match v {
        Verb::News => "news",
        Verb::Macro => "macro",
        Verb::Yields => "yields",
        Verb::Fx => "fx",
        Verb::Options => "options",
        Verb::Insider => "insider",
        Verb::Financials => "financials",
        Verb::Risk => "risk",
        Verb::Corpact => "corpact",
        Verb::Inbox => "inbox",
        Verb::Export => "export",
        Verb::Earnings => "earnings",
        Verb::Movers => "movers",
        Verb::Screen => "screen",
        Verb::Members => "members",
        Verb::Ivol => "ivol",
        Verb::Tech => "tech",
        Verb::Corr => "corr",
        Verb::Filings => "filings",
        Verb::Order | Verb::Blotter => "order",
        Verb::Sentiment => "sentiment",
        _ => "?",
    }
}

fn render_ascii_chart(candles: &[aperture_data::Candle]) -> Vec<String> {
    if candles.is_empty() {
        return vec!["(no data)".into()];
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for c in candles {
        lo = lo.min(c.l);
        hi = hi.max(c.h);
    }
    let rows = 8usize;
    let cols = candles.len().min(60);
    // Flat byte grid: one allocation total instead of `rows + 1` Vecs of chars.
    // Every cell is ASCII (' ', '|', '*'), so a UTF-8-safe slice is a 1-byte slice.
    let mut grid = vec![b' '; rows * cols];
    let scale = |v: f64| -> usize {
        if hi == lo {
            rows / 2
        } else {
            let n = (v - lo) / (hi - lo);
            ((1.0 - n) * (rows as f64 - 1.0)).round() as usize
        }
    };
    for (x, c) in candles.iter().take(cols).enumerate() {
        let high_y = scale(c.h);
        let low_y = scale(c.l);
        let close_y = scale(c.c);
        for y in high_y..=low_y {
            grid[y * cols + x] = b'|';
        }
        if close_y < rows {
            grid[close_y * cols + x] = b'*';
        }
    }
    let mut out: Vec<String> = (0..rows)
        .map(|r| {
            // Safe: all bytes written are ASCII.
            let row = &grid[r * cols..(r + 1) * cols];
            std::str::from_utf8(row).expect("ascii").to_owned()
        })
        .collect();
    out.push(format!("range hi {:.2}  lo {:.2}", hi, lo));
    out
}

fn draw(f: &mut ratatui::Frame, state: &AppState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(8),
            Constraint::Length(3),
        ])
        .split(f.area());

    let header = Paragraph::new(format!(
        " Aperture · focus: {} · panes: 4 ",
        state.focus_symbol.as_deref().unwrap_or("-")
    ))
    .style(Style::default().add_modifier(Modifier::REVERSED));
    f.render_widget(header, chunks[0]);

    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(chunks[1]);
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(body[0]);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(body[1]);

    pane(f, left[0], "Quote", &state.quote_lines);
    pane(f, left[1], "Chart", &state.chart_lines);
    pane(f, right[0], "Watchlist", watchlist_lines(state));
    pane(f, right[1], "Oracle", &state.oracle_lines);

    let cmd = Paragraph::new(format!("> {}", state.input))
        .block(Block::default().borders(Borders::ALL).title("Command"));
    f.render_widget(cmd, chunks[2]);
}

fn watchlist_lines(state: &AppState) -> &[String] {
    // Lazily constructed once; subsequent draws hand back the same slice.
    use std::sync::OnceLock;
    static EMPTY: OnceLock<Vec<String>> = OnceLock::new();
    if state.watchlist.is_empty() {
        EMPTY.get_or_init(|| vec!["(empty)".into(), "use `AAPL WATCH GO`".into()])
    } else {
        &state.watchlist
    }
}

fn pane(f: &mut ratatui::Frame, area: Rect, title: &str, lines: &[String]) {
    // Borrow the strings instead of cloning them; `body`'s lifetime is tied
    // to `lines` and is consumed within this function.
    let body: Vec<Line> = lines.iter().map(|s| Line::from(s.as_str())).collect();
    let p = Paragraph::new(body).block(Block::default().borders(Borders::ALL).title(title));
    f.render_widget(p, area);
}
