# Multilingual Embedding Models

## Current Status

Multilingual embedding models are a roadmap feature proposal, not a fully configurable shipped capability.

Issue #1272 tracks support for configurable multilingual embedding backends for semantic search and retrieval workflows.

Current releases primarily use the default embedding pipeline and do not expose full multilingual model selection through user-facing configuration.

---

## What Exists Today

Current embedding support includes:

- default embedding pipeline for semantic search
- vector indexing for retrieval workflows
- ONNX-based embedding execution
- support for general semantic similarity across common text inputs

This provides baseline embedding functionality, but not dedicated multilingual model configuration.

---

## Proposed Scope

The proposed multilingual embedding feature would add:

- configurable multilingual embedding backends
- model selection via config
- improved multilingual semantic retrieval
- better non-English search and matching
- support for alternate embedding providers

This would improve retrieval quality across multilingual corpora.

---

## Not Yet Implemented

The following are not currently shipped as stable user-facing features:

- configurable multilingual embedding model selection
- dedicated multilingual embedding presets
- per-project multilingual model routing
- language-aware embedding backend switching

These remain roadmap items.

---

## Roadmap Reference

Tracked in Issue #1272 as a future embedding and retrieval enhancement.