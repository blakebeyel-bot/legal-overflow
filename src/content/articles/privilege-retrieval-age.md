---
title: "Privilege in the age of retrieval: your prompts are probably discoverable."
dek: "Work-product doctrine assumes the attorney's thinking lives somewhere private. The tools we use now put a lot of that thinking on someone else's server. Here's how I think about it as an in-house counsel — and what I do about it."
kind: "Article"
track: "legal"
readMinutes: 6
date: 2026-03-11
topic: "Ethics"
cover: "ph-e"
featured: false
draft: false
---

Work-product doctrine protects the attorney's thought process. Attorney-client privilege protects the attorney's communications with the client. Both doctrines were built on an assumption: the attorney's thinking lives in a human skull, and the client's communications happen in a room with a door.

The tools I use every day at Beyel Brothers don't fit that assumption. When I draft a demand letter by iterating prompts against a frontier model — revising, refining, occasionally arguing with the tool — every one of those prompts goes to someone else's server. Every retrieval query I run against our vault hits a vector index that logs what I searched. The act of asking the question is, in a real sense, a record of what I was thinking when I asked it.

That's the privilege problem.

## The basic concern

A prompt is a draft. It contains attorney mental impressions. Under classic *Hickman v. Taylor* (329 U.S. 495 (1947)) work-product doctrine, those impressions are protected — but only to the extent they're not voluntarily disclosed to a third party. Send the prompt to a third-party LLM provider, and you have arguably waived that protection. The contract terms with the provider matter (most enterprise tiers say they don't train on your inputs and retain them for limited windows), but the doctrinal question remains open: does the act of submitting the prompt to a third party constitute disclosure that defeats work-product protection?

I don't know. Nobody knows yet. The case law hasn't caught up to the tooling. What I do know is that the Florida Bar's Rule 4-1.6 obligation — confidentiality of information relating to the representation, regardless of source — doesn't blink at the technology question. The confidentiality obligation applies whether I'm whispering to a colleague or typing into a chat window.

## The retrieval twist

The harder problem isn't the prompt. It's the retrieval query.

A retrieval-augmented system holds chunks of source documents — contracts, memos, deposition transcripts — in a vector index. When I query the index, the system finds the chunks most semantically similar to my question. The query itself is a record of what I was looking for. It can reveal trial strategy, what I'm worried about, what I expect the other side to argue. The query is often more sensitive than the prompt because it's specifically targeted: I ran a semantic search for "indemnity cap carve-out fraud" because I was worried about a specific exposure on a specific deal.

If that query lives in someone else's logs, it lives in someone else's discoverable system. Maybe protected by contract. Maybe not.

## What I actually do about it

I'm not running a law firm. I'm corporate counsel at a heavy-equipment company. My exposure is narrower than a litigation boutique's — most of my work is contracts and compliance, not adversarial discovery. But the discipline I apply is portable:

1. **I run a privacy-mode toggle in my own tooling.** On the chat I built for myself on this site, there's a flag that abstracts any document text before it leaves my browser — names redacted to roles, dollar figures rounded, dates generalized. The model gets enough to do the work, not enough to identify the matter. It's not perfect protection but it cuts the data-exposure surface meaningfully.
2. **I use my own API keys (BYOK).** Every provider gets a separate key, scoped per-purpose. The contract terms I agreed to with that provider apply — not the consumer terms my employees might be subject to on the free tier. Anthropic's enterprise terms say no training on inputs. OpenAI's enterprise terms say the same. Google's enterprise terms say the same. The consumer terms on each of those products do not.
3. **The vault is RLS-isolated.** Documents I upload are stored in a per-user Postgres row with row-level security. The retrieval queries against the vault stay inside the database; the embeddings provider sees the query text but doesn't see the matched documents or the matter context.
4. **I keep prompt logs.** Counterintuitively, the right move isn't to delete the prompts — it's to log them in a place I control, so if I ever need to assert work-product over the prompt set, I can show what was thought and when. Logging in the provider's system is exposure; logging in my own system, on my own infrastructure, is a record I can produce or assert protection over on my terms.

## The ABA / Florida Bar piece

ABA Formal Opinion 512 (July 29, 2024) addressed lawyer use of generative AI directly. The headline obligations: competence (Rule 1.1), confidentiality (Rule 1.6), supervision (Rule 5.3), and clear client communication (Rule 1.4). The opinion didn't resolve the privilege question, but it set a posture: lawyers must understand the tools they're using, must protect client information regardless of vendor representations, and must disclose AI use to clients when it bears on the representation.

The Florida Bar has not issued a generative-AI-specific opinion as of this writing. Existing rules — particularly 4-1.1, 4-1.6, and 4-5.3 — apply unchanged. If you're practicing in Florida and you're using these tools, the rule isn't different; the application requires more discipline than it did a decade ago.

## The honest gap

Privilege in the age of retrieval isn't a settled doctrine. It will get tested in a courtroom within the next few years, probably in a litigation context where opposing counsel subpoenas the LLM provider's logs in pursuit of work-product. The first reported decision will probably be narrow and unsatisfying. The body of law will build up over a decade.

In the meantime, the practical move is to operate as if your prompts are discoverable. Treat the model the way you'd treat email to a third party — clear about what you can say in writing, deliberate about what you can't. The discipline is older than the technology.

## Practical close

If you're using these tools and you haven't read your provider's terms of service yourself, that's the first move. If you're using a consumer tier on free credits, switch to the enterprise tier or BYOK before the matter that matters. Log what you send. Assume someone smart will get to read it in five years.

This is general commentary, not legal advice, and it isn't specific to anyone's situation. For your own practice, consult counsel with privilege expertise. For mine, this is what I do.
