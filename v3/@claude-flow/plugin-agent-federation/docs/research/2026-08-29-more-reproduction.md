# MoRe reproduction protocol

Source: arXiv 2608.27338, submitted 2026 08 27.

Evidence class: originating team report. No Ruflo reproduction yet.

## Question

Can a local open model preserve most of the quality benefit of Ruflo textual multi agent fanout by composing learned latent roles into one generation?

## Conditions

A. Single agent baseline.

B. Existing Ruflo textual mixture of agents with matched task budget.

C. Latent role composition using a frozen backbone and validated role vector artifacts.

Use the same prompt set, model revision, tokenizer revision, decoding parameters, seeds, hardware, and evaluator across conditions.

## Initial models

1. Llama 3.1 8B Instruct.
2. Qwen3 8B.

Pin exact model revisions before execution.

## Workloads

Use a stratified subset first, then full suites only if the direction survives.

1. MMLU.
2. GSM8K.
3. MATH.
4. TriviaQA.
5. One Ruflo repository task set representing tool planning and software reasoning.

## Metrics

Report task score, generated tokens, prompt tokens, wall time, time to first token, tokens per second, peak GPU memory, energy when measurable, router overhead, failure count, and variance across seeds.

Report absolute and relative deltas. Keep failed and regressed tasks in the artifact.

## Ablations

1. Top K equals 1, 2, 3, and 5.
2. Uniform role weights versus learned router weights.
3. Random role vector control.
4. Text role prompting without vector steering.
5. Latent path with one role artifact removed.

## Adversarial tests

1. Non finite router logits.
2. Duplicate role identifiers.
3. Missing or mismatched vector artifact digest.
4. Poisoned vector artifact.
5. Out of distribution prompts.
6. Attempted use of role confidence as execution authority.

## Acceptance gate

Graduate only if either condition C is within 1.5 absolute percentage points of the stronger condition B while using at least 8 times fewer coordination tokens, or condition C beats condition A by at least 2 absolute points while using no more than 1.1 times its generated token count.

No authority expansion is permitted. All vector artifacts require provenance and digest binding before runtime integration.
