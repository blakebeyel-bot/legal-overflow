---
title: "What the Bluebook will need to add for AI-drafted citations."
dek: "The Bluebook (22nd ed.) was designed for human researchers using Westlaw and Lexis. The next edition has to account for citations that come out of a model's mouth — and the tools that verify them."
kind: "Essay"
track: "legal"
readMinutes: 5
date: 2026-03-02
topic: "Profession"
cover: "ph-f"
featured: false
draft: false
---

The Bluebook is a citation convention. It tells you how to format a Supreme Court case (Rule 10), a federal statute (Rule 12), a treatise (Rule 15), an internet source (Rule 18). It assumes a researcher who has touched the source material — typically by retrieving it through a curated database like Westlaw or Lexis, where the case captions, parallel citations, and pinpoint pages come pre-formatted.

That assumption is starting to creak. When the first draft of a brief is produced by a frontier model, the citations in it weren't retrieved from a curated database. They were generated. Sometimes they're correct. Sometimes they're correct in form but wrong in substance — the case exists, but it doesn't say what the brief claims it says. Sometimes the case doesn't exist at all, which is what landed the *Mata v. Avianca* attorneys in front of Judge Castel.

The Bluebook hasn't said anything formal about this yet. The 22nd edition (2024) still treats citations as something a human typed. The 23rd edition will have to address it. Here are the four problems I think it has to solve.

## 1. Provenance

The Bluebook doesn't require an attorney to certify how they found a source. The implicit assumption is that you went to Westlaw, ran a search, opened the case, read the relevant section, and pinpointed the citation. When the source comes from a model's mouth, the provenance chain is different — and arguably needs to be disclosed.

I'm not arguing the Bluebook should require an "AI-assisted" flag on every citation. That would be unworkable and overbroad. But the formatting conventions should probably acknowledge that a citation has different reliability characteristics depending on whether it was produced by a curated database, a retrieval-augmented system pulling chunks from a vector index, or a generative model producing it from pattern-match. The reader (judge, opposing counsel, junior associate checking the brief) should be able to know what they're looking at.

## 2. Pin-cite verification

A pin cite in the Bluebook tells you where in the source the proposition lives. Rule 3.2(a) — "specific page references shall be provided when relying on a particular part of a publication." That rule assumes the attorney looked at the page.

When the citation comes from a model, the pin cite is often the weakest part. The case might exist, the proposition might be defensible, but the specific page reference is hallucinated — the model produced a plausible-looking number that doesn't correspond to anything. This is the citation failure mode that most often slips past first review. The case is real, so quick checks pass. But the pin cite is fabricated.

The Bluebook could add a recommendation: where citations are produced by generative tools, the pin cite must be independently verified against the source PDF. (The same recommendation would apply to citations from retrieval-augmented systems that surface chunks without the original page context.) That's not a citation-format change. It's a citation-discipline change.

## 3. Algorithmic verification

I built a [Citation Verifier](/agents/citation-verifier) for myself because I needed it. It does what an associate used to do — walk every citation, pull the source, check the pin cite, flag what doesn't match. It does it in minutes instead of hours.

The Bluebook will, I think, eventually acknowledge that algorithmic verification exists and define what "verified" means. Right now there's no convention. Different tools verify different things — some check case existence, some check pin-cite content, some check Bluebook formal compliance. The next edition could publish a rubric for what a citation verification protocol must cover before the attorney represents the cite as accurate to a tribunal.

## 4. Retrieval-augmented systems

The Bluebook has Rule 18 for internet sources and Rule 19 for unpublished sources. Neither anticipates a retrieval-augmented system as a citation surface. When my chat system surfaces a relevant chunk of a contract or a statute via vector search, the "citation" that should appear in the work product isn't the chat system — it's the underlying source. But the convention for attributing how the source was found is unclear.

This is a low-priority issue because the chunked retrieval is usually a starting point, not an end. But for sophisticated retrieval systems that surface unique propositions — particularly in administrative law or internal corporate research — the convention should clarify whether the search system itself needs to be acknowledged, or whether only the underlying authority does.

## The pragmatic close

The Bluebook is a slow-moving institution. The 22nd edition took five years. By the time the 23rd edition addresses generative AI citations, the working conventions will have been improvised by every firm, every state Bar, and every Federal District judge with a standing order on AI use.

In the interim, the working rule I apply: I treat my own citations the way I'd want opposing counsel to treat theirs. I verify pin cites. I run the algorithmic check. I read the case. I sign the brief.

When the convention catches up, it'll probably codify something close to that workflow. Until then, the discipline is the convention.
