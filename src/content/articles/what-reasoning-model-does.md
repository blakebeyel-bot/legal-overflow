---
title: "What a \"reasoning\" model actually does, for lawyers who hate jargon."
dek: "A plain-English primer on what 'reasoning' means inside a frontier model — and where I use it on this site versus where I don't."
kind: "Primer"
track: "both"
readMinutes: 6
date: 2026-02-22
topic: "Primer"
cover: "ph-g"
featured: false
draft: false
---

Every frontier model you have heard of is, under the hood, doing the same thing: predicting the next token (word fragment) given everything that came before it. A "reasoning" model isn't doing something fundamentally different. It's doing the same thing, but it's been trained — and is allowed at inference time — to generate a long internal scratchpad of intermediate steps before producing the answer the user sees.

That's the whole trick. The model talks to itself first.

When you toggle "deep think" or "reasoning effort: high" on a provider's API, you're telling the model: spend more tokens thinking before responding. The intermediate tokens are sometimes hidden from the user, sometimes shown. The output is the same kind of generated text, but produced after the model has rehearsed multiple drafts of its own internal monologue.

## Why this matters for legal work

The difference shows up on tasks where the answer requires combining several constraints.

- "Summarize this contract" — doesn't need reasoning. The model finds the relevant clauses, paraphrases them, returns the summary. A non-reasoning model is faster and cheaper and almost always good enough.
- "Find every clause where the seller could have asymmetric liability under any of these four governing-law scenarios" — needs reasoning. The model has to track multiple cross-references, simulate each governing-law context, check each clause against each scenario, surface the matches. A non-reasoning model will produce a partial answer and present it confidently. A reasoning model will work through the matrix and miss less.

The pattern: routine paraphrase and extraction tasks don't benefit from reasoning. Multi-constraint analysis, ambiguous classification, and tasks where the model needs to argue against its own first answer — those benefit.

## What I use reasoning for on this site

This site is a real product I run, not a thought experiment. Here's where reasoning is actually wired in:

- **Deep-think toggle in chat.** Above the composer there's a checkbox labeled Deep Think. When checked, the chat-stream backend adds provider-specific reasoning parameters to the request — `thinking.budget_tokens` for Anthropic, `reasoning_effort: high` for OpenAI, `thinkingConfig.thinkingBudget` for Google, `reasoning.effort: high` for xAI. Same toggle, four different vendor-specific knobs. The model takes longer to respond, but on multi-constraint legal questions the output is meaningfully better.
- **Citation classifier in the verifier.** When the Citation Verifier runs over a brief, an ambiguous citation (a parallel citation that could be referring to two different cases, or a string cite where one entry is malformed) gets routed to a reasoning model for classification. The classifier walks through the candidate matches, weighs evidence, and returns its confidence with reasoning. Easy cases are handled by a faster non-reasoning model. Hard cases go to the reasoning model.
- **Contract review agent.** The agent that runs full contract review uses extended thinking when it detects that a clause involves more than one risk dimension at once — a liability cap that interacts with a carve-out that interacts with a governing-law provision. The reasoning budget is bounded so it doesn't run forever; in practice it adds 8-30 seconds per complex clause and meaningfully cuts the false-negative rate.
- **Redline agent's clause analysis pass.** The redline runs a quick scan first, then escalates clauses that touch indemnity, IP, termination, or limitation-of-liability to a reasoning pass. Three or four clauses out of forty in a typical MSA. The rest stay in the fast lane.

## Where reasoning isn't worth it

It's tempting to turn the reasoning toggle on for everything because the outputs feel more thorough. Don't.

- **Routine drafting** — boilerplate clauses, standard NDAs, plain-vanilla demand letter shells. Reasoning is wasted compute. The output looks the same as the fast model.
- **Email summaries** — the kind of "what's in this 30-message thread" question I run every morning. Fast model. No reasoning. Done in 4 seconds.
- **Citation formatting** — getting Bluebook formatting right is a pattern-match task, not a reasoning task. Fast model handles it.
- **Anything with a tight latency budget** — if the user is waiting on the result interactively, reasoning latency (often 10-60 seconds added) erodes the experience. Use it deliberately, not by default.

## The mental model I keep in my head

Reasoning is the model thinking out loud before it speaks. For routine tasks, it's the verbal equivalent of someone clearing their throat for a long time before saying "okay." For multi-constraint tasks, it's the model arguing with itself before it commits, which is exactly what you want when the question is hard.

The provider docs make this sound more exotic than it is. Anthropic's "extended thinking", OpenAI's "reasoning effort", Google's "thinking budget", xAI's "reasoning effort" — same idea, different knob names. The right question for any task isn't "should I use a reasoning model?" but "is this task one where the model needs to talk to itself first?"

## A practical close

If you're picking models for a workflow, start without reasoning. Watch where the output is weakest — typically multi-constraint legal questions, ambiguous classification, anything where the model should be arguing with its first answer. Toggle reasoning on for those. Leave it off for everything else.

That's the rule I apply when I'm wiring a new agent into this site. Most things stay on the fast lane. The hard problems get the slow lane. The user toggle exists because some users know which is which, and the system shouldn't second-guess them.
