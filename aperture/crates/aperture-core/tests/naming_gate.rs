//! Polymorphic-naming gate as a self-contained integration test.
//!
//! Walks every `.rs`, `.md`, `.toml`, `.svelte`, `.ts` file under
//! `aperture/` (excluding `target/`) and asserts none contains the banned
//! vendor terms `bloomberg`, `bpipe`, `blp` (as a word), `finmsg`. The file
//! `NOTICE.md` is whitelisted because it legitimately documents the
//! inspiration repository.
//!
//! The check has zero external deps — `std::fs` only — and is intentionally
//! conservative: simple case-insensitive substring match for `bloomberg`,
//! `bpipe`, and `finmsg`; word-boundary-aware token match for `blp` so that
//! we don't false-positive on identifiers like `compileBlp`-shaped names
//! that happen to contain the three letters mid-word… actually the test is
//! strict: any token that lowercases to `blp` fails. There are no such
//! tokens in this codebase.

use std::fs;
use std::path::{Path, PathBuf};

const BANNED_SUBSTRINGS: &[&str] = &["bloomberg", "bpipe", "finmsg"];
const BANNED_TOKENS: &[&str] = &["blp"];
const WHITELISTED_FILES: &[&str] = &["NOTICE.md"];
/// Files that legitimately reference the gate (this test itself, plus any
/// CI script the team adds later). Whitelisting by basename keeps the gate
/// honest while letting tooling about the gate exist in the repo.
const WHITELISTED_BASENAMES: &[&str] = &["naming_gate.rs"];
const ALLOWED_EXTS: &[&str] = &["rs", "md", "toml", "svelte", "ts"];

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points to the package dir (aperture-core). The
    // workspace root is two levels up: <root>/crates/aperture-core ->  <root>.
    let pkg = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    pkg.parent()
        .and_then(|p| p.parent())
        .unwrap_or(&pkg)
        .to_path_buf()
}

fn is_whitelisted(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    WHITELISTED_FILES.iter().any(|w| *w == name)
        || WHITELISTED_BASENAMES.iter().any(|w| *w == name)
}

fn has_allowed_ext(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => ALLOWED_EXTS.iter().any(|a| a.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    // Skip Cargo's `target/` build dir entirely.
    if dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "target")
        .unwrap_or(false)
    {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect(&path, out);
        } else if ft.is_file() && has_allowed_ext(&path) {
            out.push(path);
        }
    }
}

/// Splits `s` on non-alphanumeric chars and yields lowercased tokens.
fn tokens_lower(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_lowercase())
}

#[test]
fn no_vendor_terms_in_aperture_workspace() {
    let root = workspace_root();
    assert!(
        root.join("Cargo.toml").exists(),
        "workspace root resolution broke: {} has no Cargo.toml",
        root.display()
    );

    let mut files = Vec::new();
    collect(&root, &mut files);
    assert!(
        files.len() >= 5,
        "expected to find at least a handful of source files, got {}",
        files.len()
    );

    let mut violations: Vec<String> = Vec::new();

    for path in &files {
        if is_whitelisted(path) {
            continue;
        }
        let body = match fs::read_to_string(path) {
            Ok(b) => b,
            // Skip unreadable / binary files silently.
            Err(_) => continue,
        };
        let lower = body.to_ascii_lowercase();
        for needle in BANNED_SUBSTRINGS {
            if lower.contains(needle) {
                violations.push(format!(
                    "{} contains banned substring `{}`",
                    path.display(),
                    needle
                ));
            }
        }
        // For `blp` we want a word-boundary check so we don't flag, say, a
        // hash that happens to contain the trigraph. Tokens: split on
        // non-alphanumerics, lowercase, compare exactly.
        let mut hits_blp: Vec<String> = Vec::new();
        for tok in tokens_lower(&body) {
            if BANNED_TOKENS.iter().any(|b| *b == tok) {
                hits_blp.push(tok);
            }
        }
        if !hits_blp.is_empty() {
            violations.push(format!(
                "{} contains banned tokens: {:?}",
                path.display(),
                hits_blp
            ));
        }
    }

    assert!(
        violations.is_empty(),
        "vendor-naming gate violated:\n  - {}",
        violations.join("\n  - ")
    );
}

#[test]
fn whitelisted_notice_md_is_actually_present() {
    // Defence in depth: if NOTICE.md is renamed or removed, this test fails
    // and forces us to update the whitelist intentionally.
    let p = workspace_root().join("NOTICE.md");
    assert!(p.exists(), "NOTICE.md must exist at {}", p.display());
    let body = fs::read_to_string(&p).unwrap();
    assert!(
        body.to_ascii_lowercase().contains("bloomberg"),
        "NOTICE.md is meant to mention the inspiration repo by name; if you've removed that, also remove the whitelist entry"
    );
}

#[test]
fn token_helper_distinguishes_blp_from_lookalikes() {
    // Sanity: the token-based check only flags `blp` standalone (after
    // splitting on non-alphanumerics), not `blp` embedded inside larger
    // alphanumeric runs like `myblpid`.
    let toks: Vec<String> = tokens_lower("hello blp world").collect();
    assert!(toks.iter().any(|t| t == "blp"));

    let toks2: Vec<String> = tokens_lower("hello myblpid world").collect();
    assert!(!toks2.iter().any(|t| t == "blp"));

    let toks3: Vec<String> = tokens_lower("type=BLP, src=BPIPE").collect();
    assert!(toks3.iter().any(|t| t == "blp"));
}
