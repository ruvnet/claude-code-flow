//! Native transport: newline-delimited JSON over stdin/stdout.
//!
//! `unified-coordinator.ts` spawns the binary as a child process and pipes
//! `Envelope` JSON in/out per line. This module exposes async read and write
//! helpers; transport setup (channel wiring, retries, backpressure) is the
//! caller's responsibility.

use crate::envelope::Envelope;
use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, Stdin, Stdout};

/// Maximum size of a single inbound JSON line before the reader rejects it.
/// At 1 MiB we can still carry a chart pane's full ASCII payload while
/// preventing an unterminated stdin from OOM-ing the agent process.
pub const MAX_LINE_BYTES: usize = 1 << 20;

#[derive(thiserror::Error, Debug)]
pub enum TransportError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("line exceeds {MAX_LINE_BYTES} bytes")]
    LineTooLong,
    #[error("eof")]
    Eof,
}

pub struct StdioReader {
    inner: BufReader<Stdin>,
    buf: String,
}

impl Default for StdioReader {
    fn default() -> Self {
        Self::new()
    }
}

impl StdioReader {
    pub fn new() -> Self {
        Self {
            inner: BufReader::new(tokio::io::stdin()),
            buf: String::new(),
        }
    }

    pub async fn next(&mut self) -> Result<Envelope, TransportError> {
        self.buf.clear();
        // Read byte-by-byte through a `take` adaptor so we hard-cap the line
        // size and skip the unbounded `read_line` allocation. Anything past
        // `MAX_LINE_BYTES` without a `\n` is rejected.
        let mut bytes = Vec::with_capacity(256);
        let mut limited = (&mut self.inner).take(MAX_LINE_BYTES as u64 + 1);
        loop {
            let mut chunk = [0u8; 1];
            let n = limited.read(&mut chunk).await?;
            if n == 0 {
                if bytes.is_empty() {
                    return Err(TransportError::Eof);
                }
                break;
            }
            if chunk[0] == b'\n' {
                break;
            }
            bytes.push(chunk[0]);
            if bytes.len() > MAX_LINE_BYTES {
                return Err(TransportError::LineTooLong);
            }
        }
        let line = std::str::from_utf8(&bytes)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let env: Envelope = serde_json::from_str(line.trim_end())?;
        Ok(env)
    }
}

pub struct StdioWriter {
    out: Stdout,
}

impl Default for StdioWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl StdioWriter {
    pub fn new() -> Self {
        Self {
            out: tokio::io::stdout(),
        }
    }

    pub async fn send(&mut self, env: &Envelope) -> Result<(), TransportError> {
        let line = serde_json::to_string(env)?;
        self.out.write_all(line.as_bytes()).await?;
        self.out.write_all(b"\n").await?;
        self.out.flush().await?;
        Ok(())
    }
}
