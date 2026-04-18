---
title: "What a \"reasoning\" model actually does, for lawyers who hate jargon."
dek: "A plain-English, technically accurate primer for the partner who has to explain the tech stack to the managing committee next Tuesday."
kind: "Primer"
track: "both"
readMinutes: 7
date: 2026-02-22
topic: "Primer"
cover: "ph-g"
featured: false
draft: false
---

Every frontier model you have heard of is, under the hood, doing the same thing: predicting the next token.

A "reasoning" model is one that has been trained — or prompted — to predict many tokens of its own thinking *before* it produces the tokens you see. Those interior tokens are called a chain of thought. They exist to let the model solve problems that a single-pass predictor cannot.

Everything else is engineering detail.

## Why this matters for your practice

1. A reasoning model can check its own citations. A single-pass model usually cannot.
2. A reasoning model costs ~5–15x more per query. This matters at scale.
3. A reasoning model is slower. For client-facing chat, this is a problem. For research, it is often a feature.

*(Full primer coming soon.)*
