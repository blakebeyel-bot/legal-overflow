---
title: "<em>Mata</em>, two years on: the case that pinned every AI brief to a real citation."
dek: "What Judge Castel actually held, what changed in practice, and how I built a citation verifier on this site so the same mistake doesn't happen to anyone running the same workflow I do."
kind: "Case Study"
track: "legal"
readMinutes: 6
date: 2026-04-03
topic: "Litigation"
cover: "ph-b"
featured: false
draft: false
---

The facts of *Mata v. Avianca, Inc.* are simple enough to fit in a paragraph, and most attorneys still get one detail wrong. Two attorneys at Levidow Levidow & Oberman PC — Steven A. Schwartz and Peter LoDuca — submitted a brief in opposition to a motion to dismiss that cited six federal cases. The cases did not exist. Schwartz had drafted the brief using ChatGPT (the free version, GPT-3.5 at the time) and had not verified the citations. Judge P. Kevin Castel of the S.D.N.Y. issued a written sanctions order on June 22, 2023. The order found the attorneys and their firm jointly responsible under Rule 11. The sanction was $5,000.

*Mata v. Avianca, Inc.*, No. 22-cv-1461 (PKC), 2023 WL 4114965 (S.D.N.Y. June 22, 2023).

I keep that citation in a sticky note on my second monitor. It's not because I think the world needs another reminder that LLMs hallucinate — the world has been reminded plenty. I keep it there because it's the cleanest, most well-documented example of what happens when a working attorney trusts a tool's output without verifying it. The professional consequence isn't speculative. It's in the Federal Reporter.

## What changed

Two years on, the practical change isn't that AI got better at not hallucinating — it did get better, but not enough to remove the verification problem. The change is that every reasonable workflow now treats the AI's output as a draft, and treats verification as the work the attorney is actually being paid for.

In my own practice as in-house counsel, that means:

- I treat every citation the model produces the way I'd treat a citation from a junior associate's first draft. I read it. I open the case. I check the pin cite.
- I don't accept the model's representation that a case "stands for" a proposition. I read the holding myself. The model is right often enough to be useful and wrong often enough to be dangerous.
- When the volume gets high enough that hand-verification is unrealistic, I lean on a tool that does the citation verification programmatically — and then I spot-check the tool.

That last one is what I built on this site.

## Why I built the Citation Verifier

The premise behind the [Citation Verifier](/agents/citation-verifier) agent is straightforward. You upload a draft brief or memo as a .docx file. The agent walks every citation in the document, classifies it (case, statute, regulation, secondary source), pulls the underlying authority from CourtListener, Free Law Project, or the relevant statutory database, and flags every claim that doesn't match what the cited source actually says. The output is the original .docx with tracked changes — pin-cites verified, parentheticals checked, errant cases flagged for human review.

It does not replace the attorney's judgment. It catches the *Mata* failure mode — a citation that looks plausible but doesn't exist, or a citation that exists but doesn't say what the brief claims it says. That's the narrow problem. The tool handles it at machine speed so the human can spend time on the parts that need a human.

I built it because I needed it for my own demand letters and the occasional state-court filing. The fact that it's on the site for anyone else to use is a side effect, not the point.

## What *Mata* didn't say

It's worth being precise about what the sanctions order actually held, because the case gets cited for propositions it doesn't support.

Castel's order **did not** hold that attorneys can't use generative AI. It held that attorneys remain responsible for the contents of every filing, that Rule 11 obligations are unchanged by the tool used to produce the draft, and that representations made to the court about a citation's existence and content must be true. The use of ChatGPT was the proximate cause of the failure but not the legal basis for the sanction. The legal basis was the false representation to the tribunal.

That distinction matters. It means the rule isn't "don't use AI." It's the same rule that's always applied: don't put something in front of a tribunal that you haven't verified.

## The in-house rule I actually follow

I treat AI output the way I'd treat a junior's first draft. I read it. I verify it. I take responsibility for it. The tool can be wrong. The tool can be confidently wrong. My professional obligation is to catch the wrong before it leaves my desk.

That isn't a particularly novel rule. It's the same standard the Florida Bar applies under Rule 4-1.1 (competence), Rule 4-1.3 (diligence), and Rule 4-3.3 (candor to the tribunal). The novelty is that the new draft-producer is faster and more confident than any junior associate has ever been, which means the verification step has to be more disciplined, not less.

## The honest close

I don't think *Mata* will be remembered as a turning point. I think it will be remembered as the obvious case — the one where the sanction was small, the misconduct was unambiguous, and the lesson was the one every first-year used to learn from the partner who marked up their draft: don't put something in writing that you haven't checked.

What's new is the speed. Tools that produce confident text faster than humans can verify it create a discipline problem. The discipline solution is the same it's always been. Read the case. Check the cite. Take responsibility.

That's the work. The tools just changed how fast you can get to it.
