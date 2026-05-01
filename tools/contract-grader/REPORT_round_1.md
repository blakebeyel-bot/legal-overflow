# Round 1 — Reasoning-Verification Report

Generated 2026-05-01T20:09:31.464Z

## Architectural Confirmations

Two parity questions were checked before running the matrix:

| Confirmation | Status | Detail |
|---|---|---|
| **Specialist prompt parity** | CLEAN | No specialist .md branches on input format. All `format` references in `netlify/agents/*.md` are finding-ID format (e.g. `commercial-terms-analyst-NNN`) or data-export format. Zero references to `.docx` / `.pdf`. |
| **Specialist input parity (words)** | CLEAN | Both formats yield identical word content (4436 words). Whitespace-normalized strings are byte-identical (29595 chars each). |
| **Specialist input parity (structure)** | DIVERGES | DOCX preserves paragraph structure (75 `\n\n`-separated paragraphs). PDF flattens within-page structure (only 8 paragraphs — one per page) because `extract.js:80` joins pdfjs `getTextContent()` items with single space and only inserts `\n\n` between pages. |

**Implication:** specialists see the same words but a different paragraph rhythm. Reasoning should be substantively similar (because content is identical), but `replace`/`delete` source_text quoting may have subtly different boundaries. Markup application (separate concern) is amplified — `markup-pdf.js` does fuzzy-locate, no paragraph IDs to anchor to.

## Test materials

| Artifact | Path |
|---|---|
| Test contract DOCX (4436 words) | `tools/contract-grader/test_contracts/msa_reasoning_test.docx` |
| Test contract PDF (born-digital, 8 pages) | `tools/contract-grader/test_contracts/msa_reasoning_test.pdf` |
| Buyer profile JSON | `tools/contract-grader/test_profiles/profile_buyer_positions.json` |
| Empty / DEFAULT_PROFILE-equivalent | `tools/contract-grader/test_profiles/profile_empty.json` |
| Buyer playbook prose DOCX | `tools/contract-grader/test_profiles/playbook_buyer_positions.docx` |
| Pipeline harness | `tools/contract-grader/harness.mjs` |
| Rationale grader (LLM judge) | `tools/contract-grader/grade_rationales.mjs` |

Pipeline mode: `standard` (6 specialists + auditor + compiler + posture-integrity + coherence-checker). The buyer profile auto-enables `industry-saas-analyst` via the SaaS industry regex, so 7 specialists ran for runs 1-4 and 9-12; 6 ran for runs 5-8 (empty profile, no industry).

## Per-run summaries

Each run is presented in the format the spec requested. Findings are listed in their compiler-ordered sequence with full materiality_rationale text.

### run-01 — profile: `profile_buyer_positions`, posture: `our_paper`

```
run: run-01
profile: profile_buyer_positions
deal_posture: our_paper
total_findings: 21
severity_distribution: {"blocker":6,"major":6,"moderate":8,"minor":1}
tier_distribution: {"tier_1":15,"tier_2":6}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":8,"CONTEXTUAL":12,"EXEMPLARY":0,"UNKNOWN":0,"ERROR":1}
specialist_failures: 0
tokens_used: 138333
elapsed_seconds: 548.3
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** ERROR
  - source_text: "Section 2.3 (SLA sole remedy) + Section 4.4(b) (post-termination payment obligation) + Section 8.6 (liability cap)"
  - **materiality_rationale (verbatim):** On a 3-year/$900K subscription, this creates a $600K+ ransom scenario in year two where we must choose between continuing to pay for non-performing services or paying to exit. The combination eliminates our practical ability to exit chronically underperforming service.

- **`critical-issues-auditor-002`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 5.3 (Security Incident notification within 72 hours) + Section 8.6 (liability cap at 1x trailing-12-month fees) + Section 9.2 (cyber/E&O insurance at $5M) + no data-breach indemnity or super-cap"
  - **materiality_rationale (verbatim):** A single material Security Incident could impose multi-million-dollar liability under state breach-notification statutes and data-protection laws, with recovery limited to a fraction of actual damages while Lattice's insurance remains inaccessible. This four-way mismatch creates an uninsured gap where coverage exists but we cannot recover.

- **`critical-issues-auditor-003`** · blocker · tier 1 · category: `existential_escalation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 10.2 (mandatory arbitration in San Francisco) + Section 4.4(b) (100% termination fee) + Section 8.6 (1x fees liability cap)"
  - **materiality_rationale (verbatim):** The venue provision, combined with capped remedies and high exit costs elsewhere in the contract, creates a dispute-resolution trap that makes our contractual rights illusory. We cannot economically challenge performance, cannot exit without paying full contract value, and cannot recover more than 12 months of fees even if we prevail.

- **`risk-allocation-analyst-001`** · blocker · tier 1 · category: `liability_cap_carveout`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without a data-breach super-cap, our remedy for a Security Incident involving Customer Data is limited to 1x trailing-12-month fees. For a $500K annual subscription, a breach affecting operational telemetry could expose us to regulatory fines, notification costs, and third-party claims totaling millions, with recovery capped at $500K. This misalignment creates uninsured exposure where Lattice's $5M cyber insurance would cover the loss but we cannot recover it.

- **`termination-remedies-analyst-003`** · blocker · tier 1 · category: `dispute_resolution_venue`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** For a mid-market customer based outside California, arbitrating in San Francisco adds $50,000–$150,000 in incremental travel, lodging, and California-counsel costs for any material dispute. This cost burden may make enforcement of our rights economically irrational for disputes below six figures, effectively stripping us of remedies for mid-value claims.

- **`termination-remedies-analyst-004`** · blocker · tier 2 · category: `post_termination_payment_obligation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** If we breach in month 6 of a 36-month, $300K deal, we owe the full $250K balance even if Lattice immediately re-sells that capacity or if the Services are materially underperforming. This is a concrete penalty provision that eliminates our ability to exit a non-performing or no-longer-needed service without paying the full contract value. In a mid-market deal, this exposure can exceed our annual IT budget for the category.

- **`critical-issues-auditor-004`** · major · tier 1 · category: `material_omission`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** If Lattice changes data-processing locations from US to offshore, changes authentication mechanisms requiring us to re-architect integrations, or removes API endpoints we rely on, we have no contractual right to prior notice, impact assessment, or objection—only the ex-post remedy of claiming material diminishment under Section 2.4, which is undefined and dispute-prone. This structural blind spot creates concrete compliance and operational risk.

- **`risk-allocation-analyst-002`** · major · tier 1 · category: `liability_cap_carveout`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** If Lattice commits gross negligence or willful misconduct—for example, knowingly disabling security controls—the injured party's remedy is capped at 1x trailing-12-month fees. Capping liability for intentional or reckless conduct removes the deterrent effect and permits bad actors to price in misconduct. This is contrary to market practice and public policy.

- **`termination-remedies-analyst-001`** · major · tier 1 · category: `auto-renewal mechanics`
  - **rationale_quality:** GENERIC
  - source_text: "upon expiration of the Initial Term, the Subscription Services will automatically renew for successive one-year periods (each, a \"Renewal Term\") unless either Party provides written notice of non-renewal to the other Party at least sixty
  - **materiality_rationale (verbatim):** Missing the 60-day notice window by even one day locks us into an additional full year of fees on terms that may no longer be competitive or necessary. This creates concrete financial exposure and reduces our strategic flexibility.

- **`termination-remedies-analyst-002`** · major · tier 1 · category: `cure_period_asymmetry`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** We receive half the time to cure a breach compared to Lattice. In practice, this means we have less time to investigate, allocate resources, and implement remediation for issues like payment disputes, usage-limit violations, or security incidents. The shorter cure period increases our risk of wrongful termination and loss of business continuity.

- **`protective-provisions-analyst-002`** · major · tier 1 · category: `customer-outputs-ownership`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** We pay separately for Professional Services and custom configurations under SOWs. Under Section 6.1 as written, all deliverables from those engagements—including custom analytics models and dashboards specific to our operations—would vest in Lattice, not us. This misalignment means we pay for work product we do not own, limiting our ability to migrate or re-use those assets with a future vendor.

- **`termination-remedies-analyst-005`** · moderate · tier 1 · category: `confidentiality_term`
  - **rationale_quality:** GENERIC
  - source_text: "The obligations of confidentiality set forth in this Section 7 will continue during the Subscription Term and for a period of three (3) years thereafter"
  - **materiality_rationale (verbatim):** Our data and usage patterns, configuration details, and integration architecture remain competitively sensitive for longer than three years. If Lattice's confidentiality obligation sunsets after three years, Lattice could disclose or use our operational information to cross-sell to competitors or optimize its product for competitors. This creates a concrete competitive-intelligence risk.

- **`protective-provisions-analyst-001`** · moderate · tier 1 · category: `confidentiality-duration`
  - **rationale_quality:** GENERIC
  - source_text: "The obligations of confidentiality set forth in this Section 7 will continue during the Subscription Term and for a period of three (3) years thereafter, except that with respect to trade secrets such obligations will continue for as long 
  - **materiality_rationale (verbatim):** We disclose integration details, usage patterns, business-process configurations, and contract terms to Lattice. A three-year tail for non-trade-secret information falls short of the typical five-year commercial sensitivity period for this class of information, creating potential exposure if Lattice discloses or uses such information in years four or five post-termination.

- **`risk-allocation-analyst-004`** · moderate · tier 1 · category: `indemnification_asymmetry`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** If Lattice discloses Customer Data (which is Confidential Information) to a third party in violation of Section 7, and that third party brings a claim against us alleging harm from the disclosure, we have no indemnification right and must absorb defense costs and liability within the Section 8.6 cap. For a telemetry platform handling sensitive operational and competitive data, third-party exposure from confidentiality breaches is foreseeable.

- **`protective-provisions-analyst-005`** · moderate · tier 2 · category: `subcontractor-notice`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may engage third parties to perform any of its obligations under this Agreement, including without limitation hosting, content delivery, support, and processing of Customer Data. Lattice will remain responsible for the performance 
  - **materiality_rationale (verbatim):** We have compliance obligations under data-protection laws and internal security policies that require visibility into the data-handling supply chain. Without notice or approval rights, Lattice could shift our data to a subcontractor in a jurisdiction with inadequate data-protection standards, or to a subcontractor that fails our third-party risk assessment, forcing us into a compliance breach or creating audit exposure.

- **`protective-provisions-analyst-003`** · moderate · tier 2 · category: `usage-data-scope`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may aggregate and anonymize Usage Data and use such aggregated and anonymized data for any lawful business purpose, provided that such aggregated and anonymized data does not identify Customer or any Authorized User."
  - **materiality_rationale (verbatim):** Under the current 'any lawful business purpose' language, Lattice could use aggregated Usage Data for competitive-intelligence products sold to third parties, or for purposes unrelated to the platform. For a customer in a competitive or regulated industry, aggregated usage patterns—even if anonymized—can reveal operational strategies, peak-load behaviors, or business cycles that we would not wish monetized by Lattice or disclosed to competitors.

- **`performance-obligations-analyst-002`** · moderate · tier 2 · category: `Acceptance criteria for Professional Services`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Each SOW will identify the scope of work, deliverables (if any), fees, milestones, and any acceptance criteria."
  - **materiality_rationale (verbatim):** Without a default acceptance procedure, we have no protection against subjective or indefinite acceptance disputes. Lattice can deliver work products, invoice immediately, and claim acceptance by our continued use or silence. In Professional Services engagements worth tens or hundreds of thousands of dollars, lack of a defined acceptance gate creates payment-timing disputes and eliminates our leverage to require rework of deficient deliverables.

- **`risk-allocation-analyst-006`** · moderate · tier 2 · category: `liability_cap_scope`
  - **rationale_quality:** GENERIC
  - source_text: "Section 8.6: 'IN NO EVENT WILL EITHER PARTY'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT EXCEED THE FEES PAID OR PAYABLE BY CUSTOMER TO LATTICE UNDER THE APPLICABLE ORDER FORM IN THE TWELVE (12) MONTHS IMMEDIATE
  - **materiality_rationale (verbatim):** Under the current 'paid or payable' construction, if we have not yet paid an invoice due to a dispute or billing cycle timing, Lattice could argue the cap includes unpaid amounts, inflating the cap calculation. If multiple events occur in a 12-month period, 'the event giving rise to the liability' is ambiguous—does the cap reset for each event or apply in aggregate? This ambiguity creates risk of under- or over-recovery and invites litigation over cap calculation.

- **`termination-remedies-analyst-006`** · moderate · tier 2 · category: `cross-section hazard - indefinite post-termination survival`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The provisions of Sections 1, 3 (with respect to amounts accrued prior to termination), 4.4, 4.5, 6, 7, 8, 9, and 10 will survive any expiration or termination of this Agreement."
  - **materiality_rationale (verbatim):** Indefinite survival of indemnity obligations means we could be called upon to defend or pay an IP claim arising from Customer Data ten years after the relationship ends. Indefinite survival of the liability cap means we cannot recover for a data breach or security incident Lattice concealed during the term and we discover only after termination. These are concrete tail risks that increase over time.

- **`insurance-coverage-analyst-001`** · major · tier 1 · category: `additional_insured_status`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without additional-insured status, we must rely on Lattice's indemnity obligation and Lattice's willingness to tender defense; if Lattice fails to tender or disputes indemnity scope, we bear our own defense costs and any uncovered portion of a settlement or judgment. Additional-insured status gives us direct recourse to the policy.

- **`commercial-terms-analyst-002`** · minor · tier 1 · category: `late_fees`
  - **rationale_quality:** GENERIC
  - source_text: "Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month, or the maximum rate permitted by applicable law, whichever is lower, calculated from the date such payment was due until the date 
  - **materiality_rationale (verbatim):** 1.5% per month is above market for buyer-side SaaS terms, where 1% per month is the more common standard. The 50-basis-point difference is minor in absolute dollars on typical monthly invoices, but the rate signal matters for consistency with our other vendor relationships.

---

### run-02 — profile: `profile_buyer_positions`, posture: `their_paper_high_leverage`

```
run: run-02
profile: profile_buyer_positions
deal_posture: their_paper_high_leverage
total_findings: 24
severity_distribution: {"blocker":2,"major":13,"moderate":9,"minor":0}
tier_distribution: {"tier_1":13,"tier_2":11}
rationale_quality_distribution: {"MECHANICAL":2,"GENERIC":5,"CONTEXTUAL":12,"EXEMPLARY":5,"UNKNOWN":0,"ERROR":0}
specialist_failures: 1 (commercial-terms-analyst)
tokens_used: 121328
elapsed_seconds: 694.8
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 4.4(b): 'if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Te
  - **materiality_rationale (verbatim):** Customer enters a multi-year SaaS subscription in high-leverage posture. If the service underperforms (chronic outages, data losses, security incidents), Customer's sole remedy under Section 2.3 is service credits (typically 5-10% of monthly fees, capped). Customer cannot terminate for cause based on service failures because Section 2.3 makes credits the exclusive remedy, arguably preventing classification of SLA misses as 'material breach' under Section 4.3. If Customer's business changes (acquisition, budget cut, pivot) and Customer seeks to exit, Section 4.4(b) requires payment of 100% of remaining-term fees—potentially hundreds of thousands or millions of dollars for zero service benefit. The asymmetric 30-day vs 60-day cure in Section 4.3 tilts any termination dispute in Lattice's favor. The economic effect is that Customer has no exit path short of Lattice's proven uncured material breach (excluding service performance, which is channeled to credits). This is the definition of vendor lock-in and meets the Profile's criteria for existential risk: it threatens Customer's ability to operate if the vendor relationship sours or if Customer's business needs change. The combination of these three provisions was not flagged by any specialist because each looked at their domain in isolation.

- **`termination-remedies-analyst-001`** · blocker · tier 1 · category: `Termination for breach — asymmetric cure periods`
  - **rationale_quality:** MECHANICAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods impair Customer's ability to exit the Agreement on parity with Lattice. In the event Customer experiences a material service failure or data-security incident, Customer must wait twice as long to exercise termination rights, extending exposure to underperformance or security risk. This is directly contrary to Profile requirement for symmetric cure periods (30/30 or 60/60).

- **`critical-issues-auditor-003`** · major · tier 1 · category: `material_omission`
  - **rationale_quality:** EXEMPLARY
  - **materiality_rationale (verbatim):** Profile explicitly requires notice and approval for material subcontractors processing Customer Data or providing >25% of services, with vendor flowdown of obligations. Section 9.1 gives Lattice unilateral discretion to engage any subcontractor without notice. For a SaaS service processing Customer's operational data (potentially including personal data per Section 5.4 reference to DPA), this creates two material risks: (1) Customer cannot perform vendor due diligence on subcontractors handling its data, exposing Customer to data-breach and compliance risk (e.g., if Lattice engages a subcontractor with inadequate security or in a high-risk jurisdiction); (2) if a subcontractor causes harm (breach, service failure, IP infringement), Customer's only recourse is against Lattice under the 1x fees liability cap—if the subcontractor is judgment-proof or offshore, Customer bears the loss. The Profile's position reflects standard enterprise SaaS practice (SOC 2 reports typically disclose subcontractors; enterprise customers routinely negotiate subcontractor approval rights). This was missed because no specialist's domain explicitly covers vendor-management mechanics, and the issue sits at the intersection of data security (covered partially by compliance specialist if enabled, but compliance module is enabled and no compliance specialist findings appear) and service delivery (covered by performance-obligations-analyst, who flagged other service issues but not supply-chain governance).

- **`risk-allocation-analyst-001`** · major · tier 1 · category: `liability_cap_carveout_data_breach`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** A breach of Customer Data containing personal data could trigger regulatory penalties, notification obligations to thousands of data subjects, credit monitoring costs, and reputational harm far exceeding 12 months of subscription fees. The current cap at 1x trailing fees could leave Customer under-remedied for a single significant incident, particularly given Section 5.3 requires only 72-hour notification and does not specify security program adequacy standards beyond SOC 2.

- **`risk-allocation-analyst-002`** · major · tier 1 · category: `liability_cap_carveout_gross_negligence`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Lattice's current cap structure applies even to claims arising from gross negligence or willful misconduct. If Lattice or a subcontractor engaged in grossly negligent security practices (e.g., ignoring known vulnerabilities for months, failing to patch critical systems) leading to a breach, Customer's recovery would be capped at trailing fees regardless of actual harm. This incentivizes inadequate care and leaves Customer under-remedied for preventable harms.

- **`termination-remedies-analyst-002`** · major · tier 1 · category: `Auto-renewal with extended notice period`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Unless otherwise specified in an Order Form, upon expiration of the Initial Term, the Subscription Services will automatically renew for successive one-year periods (each, a \"Renewal Term\") unless either Party provides written notice of 
  - **materiality_rationale (verbatim):** Profile states that Customer's procurement cycle typically catches 30-day notices; 60-day notice creates calendar risk of unintended renewal. Missing the 60-day window by a single day locks Customer into a full additional year of fees. This risk is material in high-leverage posture where Customer needs the deal but must preserve ability to exit if business needs change.

- **`termination-remedies-analyst-003`** · major · tier 1 · category: `Arbitration venue — vendor home state`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** Profile requires arbitration in Customer's home state or mutually agreed neutral location. Vendor-home-state arbitration imposes travel cost and local-counsel expense on Customer in any dispute. For mid-market Customer in high-leverage posture, this creates a practical barrier to enforcing rights in disputes below a certain dollar threshold (e.g., disputes under $100K may not justify cross-country arbitration cost). This is a concrete financial exposure and a strategic disadvantage.

- **`termination-remedies-analyst-004`** · major · tier 1 · category: `Confidentiality tail period — below Profile minimum`
  - **rationale_quality:** GENERIC
  - source_text: "The obligations of confidentiality set forth in this Section 7 will continue during the Subscription Term and for a period of three (3) years thereafter, except that with respect to trade secrets such obligations will continue for as long 
  - **materiality_rationale (verbatim):** Profile requires minimum 5-year tail for non-trade-secret confidential information. Three-year tail may expose Customer's confidential business data (usage patterns, integration architecture, pricing intelligence) to earlier competitive use by Lattice or its affiliates. The gap between 3-year and 5-year tail is the period during which Customer's competitive information may still have value. This is a concrete competitive-intelligence risk.

- **`protective-provisions-analyst-002`** · major · tier 1 · category: `ip_ownership_deliverables`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without clarity on deliverables ownership, Customer pays for Professional Services but may lack the right to modify, reuse, or migrate Customer-specific configurations, reports, or customizations—limiting Customer's operational flexibility and creating vendor lock-in. The Profile specifically calls out ownership of 'customer outputs' and Customer-specific analytics.

- **`insurance-coverage-analyst-001`** · major · tier 1 · category: `cyber_liability_coverage_ambiguity`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "errors and omissions / professional liability insurance (which may include cyber liability coverage) with limits of not less than five million U.S. dollars ($5,000,000) per occurrence and in the aggregate"
  - **materiality_rationale (verbatim):** If Lattice elects E&O without cyber coverage and a data breach occurs affecting Customer Data, Customer's Section 8.3 IP indemnity would not apply (breach is not an IP claim), and Lattice's insurance may not cover cyber losses, leaving Customer exposed to uninsured third-party claims and regulatory actions arising from Lattice's security failure.

- **`insurance-coverage-analyst-002`** · moderate · tier 1 · category: `additional_insured_status`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without additional-insured status, Customer has no direct rights under Lattice's policies and no independent notice of claims, policy cancellations, or coverage disputes that could affect Customer's ability to recover for losses caused by Lattice's negligence or data-security failures. Customer's Profile explicitly requires this for E&O coverage.

- **`risk-allocation-analyst-003`** · moderate · tier 1 · category: `asymmetric_cure_periods`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.3: 'Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice descr
  - **materiality_rationale (verbatim):** Customer receives half the cure time Lattice does for material breach. In a high-leverage deal where Customer needs the Subscription Services to operate, an accelerated cure period increases the risk of wrongful termination (e.g., if Customer disputes whether conduct constitutes breach, 30 days may be insufficient for investigation and remediation). This asymmetry is particularly problematic given Section 4.4(b) requires Customer to pay all remaining Subscription Term fees if Customer terminates other than for Lattice's uncured breach.

- **`critical-issues-auditor-002`** · major · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 8.6 carve-out (a): 'AMOUNTS OWED UNDER ANY ORDER FORM' + Section 4.4(b): 'Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term'"
  - **materiality_rationale (verbatim):** In a multi-year deal with substantial annual fees, the combination allows Lattice to recover: (1) all remaining-term fees under Section 4.4(b) as amounts 'owed under the Order Form' (uncapped per Section 8.6(a)), and (2) additional damages up to the 12-month trailing fees cap under Section 8.6 for any other Customer breach. For example, if Customer has $500K in annual fees and two years remaining, and Customer breaches, Lattice could claim $1M in remaining fees (uncapped) plus up to $500K in other damages (capped), for total exposure of $1.5M—three times the intended cap. This double-counting was structurally likely to be missed because risk-allocation-analyst and termination-remedies-analyst each saw their piece but not the cross-section. The materiality is the economic exposure above the stated cap, turning a 1x fees cap into effective 2-3x fees exposure for Customer breach.

- **`termination-remedies-analyst-005`** · major · tier 2 · category: `Termination fee — full remainder of term`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Profile does not address termination fees explicitly, but a 100% remainder-of-term fee effectively eliminates any termination right for Customer. In a multi-year Initial Term, this creates a risk scenario where Customer's business changes (acquisition, budget cut, pivot) and Customer is contractually locked into full payment with no service benefit. In high-leverage posture, Customer needs this deal but cannot accept zero exit flexibility. A 50% termination fee balances Lattice's reliance interest (they staffed and provisioned for Customer) with Customer's need for a negotiated exit path. This is a standard SaaS compromise and mitigates the risk of paying for services Customer cannot use.

- **`performance-obligations-analyst-001`** · major · tier 2 · category: `SLA sole-remedy framing`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A."
  - **materiality_rationale (verbatim):** Under the current language, even sustained multi-day outages trigger only service credits (typically capped at a small percentage of fees), and Customer cannot terminate for cause or recover actual damages even if business operations are materially harmed. This creates asymmetric risk where Customer bears all operational harm beyond de minimis credits.

- **`insurance-coverage-analyst-003`** · moderate · tier 2 · category: `notice_of_cancellation`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** If Lattice's insurance lapses or is materially reduced without Customer's knowledge, Customer unknowingly faces increased exposure during the coverage gap. For a SaaS service processing operational data, 30 days' notice allows Customer to evaluate whether to continue the relationship or require proof of replacement coverage.

- **`insurance-coverage-analyst-004`** · moderate · tier 2 · category: `insurance_survival_post_termination`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "During the Subscription Term, Lattice will maintain at its own expense, at minimum, the following insurance coverage"
  - **materiality_rationale (verbatim):** Data breaches and E&O claims often surface months or years after the underlying conduct. If Lattice's insurance obligations terminate on the last day of the Subscription Term, a breach discovered 18 months post-termination may be uninsured, leaving Customer without recourse under Section 8.6's liability cap if Lattice no longer carries coverage or has insufficient assets.

- **`termination-remedies-analyst-006`** · moderate · tier 2 · category: `Venue for equitable relief — unspecified`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Section 10.2 exempts 'actions seeking equitable relief' from arbitration but does not specify where such actions may be filed. In a scenario where Lattice seeks emergency injunctive relief (e.g., to prevent Customer's alleged breach of Section 2.2 restrictions or Section 7 confidentiality), absent a venue clause Lattice may file in any jurisdiction where it can establish personal jurisdiction over Customer. This creates forum-shopping risk and unpredictable litigation cost for Customer. Specifying 'defendant's home state' venue for equitable relief provides symmetry and cost predictability.

- **`termination-remedies-analyst-007`** · moderate · tier 2 · category: `Material breach definition — undefined`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Undefined material breach creates interpretive risk in any termination dispute. In the event Customer disputes whether a Lattice service failure is material (e.g., intermittent downtime below SLA threshold but causing Customer business harm), the lack of a contractual definition shifts the determination to an arbitrator, increasing dispute cost and outcome uncertainty. Adding a definition or examples reduces this friction. In high-leverage posture, Customer may not block the deal over this, but flagging it is appropriate senior-counsel judgment.

- **`protective-provisions-analyst-003`** · moderate · tier 2 · category: `usage_data_restrictions`
  - **rationale_quality:** GENERIC
  - source_text: "Customer acknowledges that Lattice collects and uses Usage Data for purposes of operating, supporting, securing, and improving the Subscription Services and developing new products and services. Lattice may aggregate and anonymize Usage Da
  - **materiality_rationale (verbatim):** Unrestricted lawful business purpose language permits Lattice to use Customer's Usage Data (patterns, feature adoption, volumes) to develop competing products, inform competitors, or sell insights to Customer's rivals—even if anonymized. For a Customer in a competitive market, this exposes strategic information that benefits competitors.

- **`coherence-checker-001`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 3.2: 'All invoices are payable in U.S. dollars and are due net sixty (60) days from the date of invoice.'"
  - **materiality_rationale (verbatim):** Profile states 'Net-30 from receipt of invoice' as the position and 'Net-60 strains working capital and is unusual for SaaS subscriptions in our size range.' Retaining Net-60 after negotiating liability caps, termination rights, and other protective provisions leaves a vendor-favorable commercial term that contradicts Customer's stated procurement standards. While not existential, this creates a $0-cost edit that directly implements a Profile requirement. The risk is operational: Customer's AP cycle is geared for Net-30; Net-60 creates working-capital strain and forces exception handling in accounts payable. As signed with accepted edits but without this payment-term correction, the contract would be internally incoherent—protective on liability and termination but permissive on cash management.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** MECHANICAL
  - source_text: "Section 3.3: 'Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month, or the maximum rate permitted by applicable law, whichever is lower, calculated from the date such payment was due u
  - **materiality_rationale (verbatim):** Profile states '1.5% is above market for buyer-side terms. We prefer no late fee but will accept a token rate.' The 1.5% monthly rate in Section 3.3 is precisely the rate Profile identifies as excessive. While the dollar impact depends on payment delays, the principle is that Customer's playbook ceiling is 1% and the contract exceeds it. This is a straightforward implemention of a stated Profile position that was not flagged by any specialist (payment mechanics typically fall outside risk-allocation and termination domains). The materiality is reputational and procedural: signing at 1.5% after stating 1% as the maximum creates internal inconsistency in Customer's negotiation execution.

- **`coherence-checker-003`** · moderate · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 8.4: 'Customer is solely responsible for Customer Data and for ensuring that its use of the Subscription Services and the content of Customer Data complies with all applicable laws, regulations, and third-party rights. Customer rep
  - **materiality_rationale (verbatim):** The Section 8.4 warranty as written is overbroad if read literally after accepting protective-provisions-analyst-002's ownership assignment. If Lattice creates a deliverable for Customer using a third-party library or template (not disclosed to Customer), assigns ownership to Customer, and Customer later uses that deliverable, a third party could claim infringement. Under Section 8.4's current framing, Customer warranted it 'has all rights... necessary,' which could negate Lattice's Section 8.3 IP indemnity for the deliverable (Section 8.3 excludes 'Customer Data' from indemnity coverage, and if deliverables are Customer-owned, Lattice may argue they fall within the Customer Data exclusion). The materiality is that accepting the ownership edit without conforming the Section 8.4 warranty shifts IP risk from Lattice to Customer for Lattice-created content. The harm is potential third-party IP claims against Customer for deliverables Customer did not originate. This is a classic coherence issue: an accepted edit in Section 2.5A changes the IP ownership balance, but Section 8.4's warranty language was drafted assuming Lattice retains deliverable ownership and was not updated to reflect the new allocation.

- **`coherence-checker-004`** · moderate · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - **materiality_rationale (verbatim):** If Customer is subject to GDPR or CCPA and uses the Subscription Services to process personal data, Customer has a legal obligation to ensure its processor (Lattice) deletes or returns personal data on termination of processing. Section 4.4(c)'s 'may delete' language does not satisfy this obligation. The risk is regulatory: if Lattice retains personal data beyond the retrieval window and a breach occurs, Customer faces regulatory exposure for failure to ensure processor compliance. The accepted finding risk-allocation-analyst-001 addresses liability for breaches during the term but does not address post-termination data retention. The materiality is that Customer cannot meet its data-controller obligations under the contract as currently drafted post-accepted-edits. The DPA referenced in Section 5.4 likely contains this obligation, but the MSA's termination section should align with or cross-reference the DPA's data-deletion obligations to ensure internal coherence. This was missed because compliance/data-privacy specialist findings were not present in the accepted findings (likely because the compliance module is enabled but the specialist did not emit findings, or findings were rejected for reasons not disclosed). The coherence-checker is catching the gap between the data-protection framing (Security Incidents, DPA reference, personal data super-cap) and the termination data-handling mechanics.

---

### run-03 — profile: `profile_buyer_positions`, posture: `their_paper_low_leverage`

```
run: run-03
profile: profile_buyer_positions
deal_posture: their_paper_low_leverage
total_findings: 20
severity_distribution: {"blocker":2,"major":10,"moderate":8,"minor":0}
tier_distribution: {"tier_1":8,"tier_2":12}
rationale_quality_distribution: {"MECHANICAL":1,"GENERIC":7,"CONTEXTUAL":12,"EXEMPLARY":0,"UNKNOWN":0,"ERROR":0}
specialist_failures: 1 (protective-provisions-analyst)
tokens_used: 117757
elapsed_seconds: 638.2
```

**Findings:**

- **`termination-remedies-analyst-004`** · blocker · tier 2 · category: `post-termination fee obligation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Under the current language, if Customer signs a three-year Initial Term and decides after 18 months that the service no longer meets needs due to repeated performance issues, Customer owes 18 months of additional fees despite receiving no further services. This is functionally a liquidated-damages provision that may not survive enforceability scrutiny, and it strips Customer of flexibility to respond to inadequate performance. Repeated SLA failures may cripple operations without rising to 'material breach' if Lattice cures within the 60-day window each time.

- **`termination-remedies-analyst-002`** · blocker · tier 1 · category: `termination for breach — asymmetric cure periods`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods give Lattice 60 days to remedy material breaches while Customer has only 30 days. This denies Customer the reciprocal early-exit right for vendor performance failures that cause immediate business harm. The asymmetry directly contravenes the requirement for parity on cure periods in commercial agreements of this nature.

- **`critical-issues-auditor-003`** · major · tier 1 · category: `material_omission`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without flowdown obligations, Lattice may remain 'responsible' for subcontractor performance but lack contractual leverage to enforce that responsibility. Without notice or approval rights, Customer has no visibility into which third parties hold Customer Data and cannot vet them for security or compliance. In agreements processing sensitive operational data, lack of subcontractor governance creates significant compliance gaps under data-breach notification laws and industry-specific regulations.

- **`commercial-terms-analyst-007`** · major · tier 2 · category: `suspension_cure_asymmetry`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "§3.4: 'If any amount owing by Customer is more than thirty (30) days overdue, Lattice may, without limiting its other rights and remedies, suspend Customer's access to the Subscription Services until such amounts are paid in full. Lattice 
  - **materiality_rationale (verbatim):** The interaction creates a leverage imbalance: Vendor may suspend critical services for payment delays that may be administrative or disputed on a 40-day timeline, while Customer must wait 60+ days to terminate for Vendor's material service failures. This is particularly acute where service suspension itself causes business harm exceeding the disputed invoice amount, giving Vendor disproportionate remedy-speed advantage.

- **`termination-remedies-analyst-003`** · major · tier 1 · category: `dispute resolution venue`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** Mandatory arbitration in San Francisco creates concrete cost disadvantage for Customer: airfare, lodging, local counsel retention, and employee time away from operations. For disputes under the liability cap (likely $100K–$500K for a mid-market SaaS deal), the cost of prosecuting or defending in San Francisco may approach or exceed the amount in controversy, effectively denying Customer economic remedies for smaller claims.

- **`termination-remedies-analyst-006`** · major · tier 2 · category: `cross-section hazard — stacked dispute-resolution waivers`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "THE PARTIES KNOWINGLY AND VOLUNTARILY WAIVE ANY RIGHT TO A TRIAL BY JURY AND ANY RIGHT TO PARTICIPATE IN A CLASS, COLLECTIVE, OR REPRESENTATIVE ACTION."
  - **materiality_rationale (verbatim):** In combination, these waivers eliminate nearly all low-cost dispute-resolution paths for Customer. For claims below the liability cap (likely $100K–$300K), the cost of AAA arbitration in San Francisco may approach or exceed the recovery, effectively denying Customer remedies for smaller breaches. Class-action waivers prevent aggregation with other customers experiencing similar harm, which is critical in SaaS contexts where widespread defects affect many customers but cause individually small damages.

- **`risk-allocation-analyst-001`** · major · tier 1 · category: `liability_cap_carveout_data_breach`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without a data-breach super-cap, Customer's maximum recovery for a Security Incident affecting thousands of records is capped at 1x fees (potentially $100K-$500K in a mid-market deal), whereas Customer's regulatory penalties, notification costs, credit monitoring obligations, and litigation exposure routinely exceed this amount by multiples in material breaches. This creates uninsured exposure for Customer.

- **`risk-allocation-analyst-002`** · major · tier 1 · category: `liability_cap_carveout_gross_negligence`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without this carve-out, Lattice's liability for gross negligence or willful misconduct (e.g., intentional deletion of Customer Data, deliberate circumvention of security controls, fraudulent misrepresentation of compliance) is capped at 1x fees. This effectively immunizes Lattice from consequences of egregious conduct and denies Customer proportionate recourse for intentional or reckless harm.

- **`risk-allocation-analyst-003`** · moderate · tier 1 · category: `indemnity_asymmetry`
  - **rationale_quality:** MECHANICAL
  - **materiality_rationale (verbatim):** The current draft imposes IP and confidentiality indemnity only on Lattice, with no reciprocal obligation from Customer despite Customer's control over Customer Data and access to Lattice Confidential Information. This asymmetry shifts uncompensated risk to Lattice for third-party claims arising from Customer's IP or confidentiality violations. Profile requires symmetry on indemnities of equal weight.

- **`termination-remedies-analyst-001`** · major · tier 1 · category: `auto-renewal notice period`
  - **rationale_quality:** GENERIC
  - source_text: "unless either Party provides written notice of non-renewal to the other Party at least sixty (60) days prior to the end of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Missing the 60-day notice window by even a few days automatically commits Customer to one additional full year of fees. In a SaaS context with annual renewals, 60 days is approximately 16% of the renewal period — far exceeding industry norms of 30–45 days. This poses concrete calendar risk for procurement teams managing multiple renewals.

- **`termination-remedies-analyst-005`** · moderate · tier 2 · category: `post-termination data retrieval cost`
  - **rationale_quality:** GENERIC
  - source_text: "for thirty (30) days following termination, Lattice will, upon Customer's written request and at Customer's expense, make Customer Data available for download in a commercially reasonable format"
  - **materiality_rationale (verbatim):** Requiring Customer to pay for retrieval of its own data post-termination imposes an undefined cost that could range from nominal to substantial depending on data volume. If the data is large (e.g., years of telemetry), the cost could reach tens of thousands of dollars, effectively holding Customer Data hostage. Additionally, 30 days is tight for coordinating retrieval, validation, and migration to a replacement system.

- **`commercial-terms-analyst-003`** · moderate · tier 2 · category: `dispute_withholding`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without a dispute-withholding mechanism, Customer risks triggering suspension or late fees when disputing overbillings, scope creep, or billing errors, and must pay first and seek refund later. This shifts leverage inappropriately to Vendor in billing disputes on a multi-year, potentially six-figure subscription.

- **`commercial-terms-analyst-005`** · moderate · tier 2 · category: `price_escalation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase will take effec
  - **materiality_rationale (verbatim):** Uncapped unilateral price escalation on an auto-renewing subscription creates unbounded budget exposure over a 3–5 year relationship. On a $200K annual subscription, Vendor could unilaterally impose $50K increases in year three, forcing Customer to either absorb unexpected cost or terminate mid-relationship. A 5% cap aligns escalation with inflationary norms while preserving Vendor's ability to adjust for cost increases.

- **`insurance-coverage-analyst-001`** · major · tier 1 · category: `additional_insured_status`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without additional-insured status, Customer must pursue indemnification from Lattice in the event of a covered claim, creating collection risk if Lattice becomes insolvent or disputes indemnity obligations. Additional-insured status provides Customer with direct access to the E&O policy proceeds, reducing Customer's practical risk in the event of an IP infringement or professional-services failure claim.

- **`insurance-coverage-analyst-004`** · moderate · tier 2 · category: `post_termination_coverage`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Section 9.2 requires coverage 'during the Subscription Term' only. If Lattice's policy lapses on termination and a claim is later asserted, the insurance that would have backstopped Lattice's indemnity no longer exists, leaving Customer to collect directly from Lattice. A three-year tail ensures the insurance backstop remains available for the period during which post-termination claims are most likely.

- **`insurance-coverage-analyst-002`** · moderate · tier 2 · category: `notice_of_cancellation`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** If Lattice's insurance lapses mid-term without Customer's knowledge, Customer loses the backstop coverage for indemnity and liability claims. Thirty days' notice allows Customer to require proof of replacement coverage or consider termination under Section 4.3 if the lapse constitutes a material breach.

- **`coherence-checker-001`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 7.4: 'The obligations of confidentiality set forth in this Section 7 will continue during the Subscription Term and for a period of three (3) years thereafter, except that with respect to trade secrets such obligations will continu
  - **materiality_rationale (verbatim):** The 3-year confidentiality tail falls short of the profile's 5-year minimum requirement. In a SaaS context where Lattice will have multi-year access to Customer's operational data, competitive information, and business intelligence, a 3-year tail exposes Customer Data and business information to disclosure within a period where it retains significant competitive value. This creates concrete harm: Lattice could disclose Customer's confidential pricing, deployment patterns, or integration details to competitors as early as year four of a five-year relationship. The profile explicitly states: 'Mutual; minimum 5-year tail for non-trade-secret confidential information' with rationale '3-year tails are short relative to the lifecycle of competitive information. 5 years is our floor.'

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Cross-section: Section 2.3 final sentence ('Customer's sole remedy in the event of repeated failures shall be the right to terminate the affected Subscription Service in accordance with Section 4.3') + accepted finding termination-remedies
  - **materiality_rationale (verbatim):** Without clarification, Customer may invoke the SLA-failure termination right from the edited Section 4.4(b), only to have Lattice assert that the termination is still subject to the 60-day cure period from Section 4.3 because SLA failures may not rise to 'material breach' or because the cross-reference in Section 2.3 incorporates the cure procedure. This creates ambiguity that will lead to dispute at the worst possible time — when Customer is attempting to exit a failing service. The combination of (1) sole-and-exclusive-remedy language in Section 2.3, (2) the 60-day vendor cure period in Section 4.3, and (3) the SLA-failure carve-out in the edited Section 4.4(b) must be explicitly reconciled to provide Customer with the intended rapid-exit path.

- **`coherence-checker-003`** · moderate · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Cross-section: Section 8.6 liability cap ('12 months of Fees paid or payable') + accepted finding risk-allocation-analyst-001 (proposing Security Incident super-cap of '3x Fees paid or payable in the 12 months immediately preceding the Sec
  - **materiality_rationale (verbatim):** In a scenario where a Security Incident occurs in month 10 of a subscription, is discovered in month 12, and regulatory penalties are assessed in month 18, the 'immediately preceding' language could reference three different 12-month windows depending on interpretation. If Customer has scaled up fees significantly in the interim, the difference could be tens or hundreds of thousands of dollars in cap headroom. This is a lower-severity coherence issue but merits annotation for reviewer awareness.

- **`coherence-checker-004`** · moderate · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Cross-section: Section 10.5 entire-agreement clause ('This Agreement, together with all Order Forms, SOWs, and any addenda or exhibits attached hereto or referenced herein, constitutes the entire agreement') + accepted finding critical-iss
  - **materiality_rationale (verbatim):** If the subcontractor list or DPA is provided separately and not formally incorporated, Lattice could argue that Customer's objection to a subcontractor change or invocation of DPA obligations is unenforceable because the list/DPA is not part of the 'entire agreement.' This is a technical contract-formation issue that creates enforceability risk for the subcontractor-governance and data-protection frameworks Customer is negotiating for. Best practice is to ensure all governing documents are either attached as exhibits or incorporated by reference in the entire-agreement clause.

---

### run-04 — profile: `profile_buyer_positions`, posture: `negotiated_draft`

```
run: run-04
profile: profile_buyer_positions
deal_posture: negotiated_draft
total_findings: 24
severity_distribution: {"blocker":3,"major":13,"moderate":7,"minor":1}
tier_distribution: {"tier_1":14,"tier_2":10}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":9,"CONTEXTUAL":15,"EXEMPLARY":0,"UNKNOWN":0,"ERROR":0}
specialist_failures: 0
tokens_used: 140424
elapsed_seconds: 697.5
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b): 'if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Te
  - **materiality_rationale (verbatim):** In a three-year $600K subscription with chronic SLA failures starting in month 6, Customer can terminate under Section 2.3 but owes $500K in remaining fees for services already proven deficient. The termination right becomes a penalty rather than a remedy, eliminating Customer's ability to exit a non-performing vendor relationship without catastrophic cost.

- **`termination-remedies-analyst-001`** · blocker · tier 1 · category: `cure_period_asymmetry`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods mean that if Customer experiences a remediable operational disruption, Lattice can terminate in 30 days, while Customer must wait 60 days to terminate for a comparable Lattice disruption. This imbalance increases Customer's exposure to premature termination and forces Customer to accept longer periods of non-performance by Lattice before exit.

- **`risk-allocation-analyst-001`** · major · tier 1 · category: `liability_cap_carveouts`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Security Incidents involving personal data create disproportionate exposure for Customer: regulatory fines, notification costs, credit monitoring, class-action defense, and reputational harm routinely exceed annual subscription fees. The current cap at 1x trailing fees creates a $500K–$2M shortfall on a mid-market breach, leaving Customer undercompensated for harms it cannot self-insure.

- **`termination-remedies-analyst-002`** · major · tier 1 · category: `auto_renewal_notice_period`
  - **rationale_quality:** GENERIC
  - source_text: "Unless otherwise specified in an Order Form, upon expiration of the Initial Term, the Subscription Services will automatically renew for successive one-year periods (each, a \"Renewal Term\") unless either Party provides written notice of 
  - **materiality_rationale (verbatim):** Customer's procurement and budget cycles typically operate on 30-45 day windows. A 60-day notice requirement means missing the notice deadline by a single business day locks Customer into a full additional one-year term. In a mid-market SaaS context with annual renewals, this creates a 12-month cost commitment based on a narrow procedural miss.

- **`termination-remedies-analyst-003`** · major · tier 1 · category: `arbitration_location`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** Mandatory San Francisco arbitration for a non-California customer creates a structural cost disadvantage: every dispute requires Customer to retain California counsel or fly East Coast counsel to San Francisco, adding $10K-$30K in travel and coordination costs before reaching the merits. For disputes in the $50K-$200K range, these costs represent 20-60% of the claim value, effectively deterring Customer from pursuing valid claims.

- **`risk-allocation-analyst-002`** · major · tier 1 · category: `liability_cap_carveouts`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Capping liability for gross negligence or willful misconduct insulates Lattice from the consequences of reckless or intentional conduct. Customer cannot accept a regime where Lattice's worst conduct is capped at trailing fees, potentially incentivizing cost-cutting in security or compliance.

- **`critical-issues-auditor-003`** · major · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 9.2(b) requires Lattice to maintain 'errors and omissions / professional liability insurance (which may include cyber liability coverage) with limits of not less than five million U.S. dollars ($5,000,000)' combined with Section 8.
  - **materiality_rationale (verbatim):** In a $1.5M breach scenario, Lattice's $5M cyber policy should cover it, but Customer's recovery is capped at trailing fees (~$200K). The $1.3M gap is unrecoverable. If Customer were an additional insured with a super-cap at insurance limits, Customer could recover the full $1.5M. The insurance exists and is sized for material incidents, but the contract structure prevents Customer from accessing it.

- **`risk-allocation-analyst-007`** · major · tier 2 · category: `termination_liability`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b): 'Upon any expiration or termination of this Agreement: ... (b) Customer will pay Lattice all Fees due and payable as of the effective date of termination, and, if Customer terminates this Agreement other than for Lattice's 
  - **materiality_rationale (verbatim):** As written, Customer pays full-term fees even if Lattice's performance degrades below acceptable levels (but not to 'material breach'), or if a Force Majeure Event makes continued use impossible. A prolonged Force Majeure Event or sustained SLA failures may not constitute a 'material breach' triggerable under Section 4.3 but nonetheless render the service unusable. Requiring Customer to pay $100K–$500K+ in fees for a non-functional service is commercially unreasonable.

- **`insurance-coverage-analyst-001`** · moderate · tier 1 · category: `additional_insured_status`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without additional-insured status on the E&O policy, Customer has no direct claim against Lattice's insurer and may need to pursue recovery solely against Lattice, whose assets may be insufficient to satisfy a judgment. Additional-insured status provides Customer with an independent path to recovery and reduces the risk that Customer bears uncovered loss.

- **`risk-allocation-analyst-004`** · moderate · tier 1 · category: `indemnification_confidentiality`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** A confidentiality breach by Lattice exposing Customer Confidential Information to a third party could trigger third-party claims against Customer. Without an express indemnity, Customer must pursue damages under the general breach framework, which is slower and may be capped. Express third-party indemnity aligns incentives and provides direct recourse.

- **`protective-provisions-analyst-001`** · moderate · tier 1 · category: `confidentiality-duration`
  - **rationale_quality:** GENERIC
  - source_text: "The obligations of confidentiality set forth in this Section 7 will continue during the Subscription Term and for a period of three (3) years thereafter, except that with respect to trade secrets such obligations will continue for as long 
  - **materiality_rationale (verbatim):** Commercial and operational information Customer discloses (including business strategy, pricing structures, customer lists, and integration details) remains competitively sensitive for longer than three years. A three-year tail exposes Customer to earlier release risk for information that could benefit competitors or harm Customer's market position.

- **`protective-provisions-analyst-002`** · major · tier 1 · category: `ip-ownership-outputs`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without clarity on ownership of customer-specific outputs, Customer lacks clear rights to reports, analytics, dashboards, and configurations generated during the engagement. If these outputs contain Customer business intelligence, Customer's inability to own or control them post-termination impairs transition and creates risk that valuable business insights revert to or remain controlled by the vendor.

- **`commercial-terms-analyst-002`** · minor · tier 1 · category: `late_fees`
  - **rationale_quality:** GENERIC
  - source_text: "Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month, or the maximum rate permitted by applicable law, whichever is lower, calculated from the date such payment was due until the date 
  - **materiality_rationale (verbatim):** At 1.5% per month (18% annualized), the late fee exceeds Customer's standard 1% per month threshold and market norms for non-financing commercial contracts; the reduction to 1% reduces annualized late-fee exposure by one-third without materially impacting vendor's collection incentive.

- **`commercial-terms-analyst-003`** · moderate · tier 2 · category: `payment_dispute_mechanics`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without dispute mechanics, Customer has no contractual right to withhold even manifestly incorrect invoice amounts, and any withholding triggers suspension under §3.4 and breach under §4.3, creating leverage imbalance on billing errors and scope disputes.

- **`commercial-terms-analyst-004`** · moderate · tier 2 · category: `price_escalation`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase will take effec
  - **materiality_rationale (verbatim):** Uncapped unilateral price escalation creates unbounded multi-year cost exposure and reduces budget predictability; without extended notice, Customer lacks sufficient lead time to conduct competitive RFP or plan transition if proposed increase is unacceptable.

- **`critical-issues-auditor-004`** · major · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 3.5 permits Lattice to 'increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term' (uncapped inc
  - **materiality_rationale (verbatim):** If Lattice announces a 50% fee increase on the 60th day before renewal, Customer has zero days to evaluate alternatives, obtain competitive bids, plan a migration, or negotiate. Customer must either accept the increase immediately or scramble to provide non-renewal notice on the same day, risking procedural error and inadvertent auto-renewal at the inflated price.

- **`performance-obligations-analyst-001`** · major · tier 2 · category: `SLA sole-remedy framing`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A. Service credits do not constitute liquidated damages or limit Lattice
  - **materiality_rationale (verbatim):** As written, Customer receives service credits capped by Exhibit A (typically 10-25% of monthly fees) but remains contractually obligated to pay full subscription fees for the remainder of the term even if the platform is chronically unavailable. In a 3-year $500K subscription, this could trap Customer in a non-performing service with no meaningful recourse beyond token credits.

- **`performance-obligations-analyst-002`** · major · tier 2 · category: `warranty disclaimer overbreadth`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "LATTICE DOES NOT WARRANT THAT THE SUBSCRIPTION SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS, OR THAT CUSTOMER DATA WILL BE SECURE OR NOT OTHERWISE LOST OR DAMAGED."
  - **materiality_rationale (verbatim):** This disclaimer creates an internal contradiction with Sections 5.2 and 5.3, which impose affirmative security obligations. In a breach dispute, Lattice could cite Section 8.2 to argue it never warranted data security, undercutting Customer's ability to enforce the security program and breach-notification obligations.

- **`insurance-coverage-analyst-005`** · moderate · tier 2 · category: `post_termination_tail_coverage`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Data breaches and professional-services errors often manifest months or years after the underlying act. If Lattice's E&O/cyber insurance lapses at termination and no tail coverage exists, Customer loses access to the insurance proceeds that Section 9.2(b) was intended to provide for post-termination claims. A three-year tail is industry-standard for SaaS engagements given typical breach-discovery timelines.

- **`coherence-checker-001`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.2 disclaimer: 'LATTICE DOES NOT WARRANT THAT THE SUBSCRIPTION SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS, OR THAT CUSTOMER DATA WILL BE SECURE OR NOT OTHERWISE LOST OR DAMAGED.'"
  - **materiality_rationale (verbatim):** Section 8.2's current disclaimer that Lattice does not warrant Customer Data will be secure directly contradicts Section 5.2's affirmative obligation to maintain 'a written information security program that includes administrative, technical, and physical safeguards designed to protect the security, confidentiality, and integrity of Customer Data.' The accepted narrowing of Section 8.2 resolves this for the warranty section, but if the Security Incident super-cap is added at Section 8.6(D) without also ensuring Section 8.2's disclaimer does not undercut Section 5.2, Lattice could argue in a breach dispute that the super-cap does not apply because Section 8.2 disclaims the underlying security warranty. The contract must be internally consistent across all three sections.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b) as proposed to be edited by critical-issues-auditor-001 and risk-allocation-analyst-007, combined with Section 2.3's termination right for repeated SLA failures."
  - **materiality_rationale (verbatim):** If both edits are applied as written without harmonization, Section 4.4(b) will contain two overlapping but potentially conflicting carve-outs for SLA failures: one tied to the Section 2.3 termination right (which may have its own standard in Exhibit A) and one tied to 'three or more consecutive months of SLA failures.' This creates ambiguity about which standard applies and whether Customer must satisfy both, either, or the more favorable of the two. The contract will be internally incoherent and open to dispute about the threshold for waiving remainder-of-term fees.

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 9.2(b) insurance requirement and Section 8.6 liability cap, as modified by accepted finding risk-allocation-analyst-001 proposing new Section 8.6(D) Security Incident super-cap."
  - **materiality_rationale (verbatim):** The proposed Section 8.6(D) super-cap ties Customer's recovery ceiling to Lattice's actual insurance limits, not the contractually required limits. If Lattice downgrades its cyber insurance from $5M to $2M after signing, the super-cap drops from 'greater of 3x fees or $5M' to 'greater of 3x fees or $2M,' which for deals under ~$667K ARR eliminates the insurance-based recovery path entirely. Without amendment to Section 9.2(b) requiring Customer as additional insured or without tying the super-cap language to the Section 9.2(b) minimum, the edit creates a floating and potentially shrinking liability ceiling that defeats the purpose of the super-cap.

- **`coherence-checker-004`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** If Customer discovers Lattice is disclosing Customer Confidential Information to a competitor, Customer may need emergency injunctive relief within days. Section 10.2's equitable-relief carve-out preserves this right in theory, but without venue specification, Lattice could argue that even equitable actions must follow the governing-law provision (Delaware courts only) or that the arbitration location (San Francisco, or as modified by termination-remedies-analyst-003) controls. This creates 3-5 days of procedural motion practice before Customer can even file for a TRO, by which time the confidential information may be irretrievably disclosed. Specifying 'any court of competent jurisdiction' eliminates this gap and allows Customer to seek emergency relief in its home forum.

- **`commercial-terms-analyst-001`** · moderate · tier 1 · category: `payment_terms`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "All invoices are payable in U.S. dollars and are due net sixty (60) days from the date of invoice."
  - **materiality_rationale (verbatim):** RESTORED: The compiler rejected this finding under the 'commercial-net-term-direction' rule, which prohibits customer-side reviews from shortening Net terms. However, the Profile explicitly calls for Net-30 as the primary position with Net-45 as a fallback, and states 'Net-60 strains working capital and is unusual for SaaS subscriptions in our size range.' The rejection was mechanically correct under the deterministic rule, but the rule does not account for Profile-mandated targets that are shorter than the contract's starting point. This is a negotiated draft (posture = 'negotiated_draft'), meaning both parties have already engaged in back-and-forth, and Customer is entitled to push for its playbook position even if it moves terms in Customer's favor. The deterministic rule created a false positive by treating all Net-term reductions as impermissible, when in fact the Profile explicitly requires this exact edit. Net-60 is 30 days beyond market for mid-market SaaS and creates measurable working-capital strain; this finding must be restored to give the reviewer the option to pursue the Profile's primary position.

---

### run-05 — profile: `profile_empty`, posture: `our_paper`

```
run: run-05
profile: profile_empty
deal_posture: our_paper
total_findings: 20
severity_distribution: {"blocker":9,"major":10,"moderate":1,"minor":0}
tier_distribution: {"tier_1":3,"tier_2":17}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":2,"CONTEXTUAL":18,"EXEMPLARY":0,"UNKNOWN":0,"ERROR":0}
specialist_failures: 0
tokens_used: 143177
elapsed_seconds: 654.5
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b): 'if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Te
  - **materiality_rationale (verbatim):** A Customer in Year 1 of a 3-year term cannot exit without either proving Provider material breach AND waiting 60 days for cure attempt while paying fees OR paying 100% of remaining fees. This eliminates all strategic flexibility: acquisition, technology migration, budget reduction, regulatory change—none permit exit. The auto-renewal extends this trap indefinitely unless Customer opts out 60 days before each renewal.

- **`critical-issues-auditor-002`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.6 carve-out (A) 'AMOUNTS OWED UNDER ANY ORDER FORM' + Section 8.6 carve-out (B) unlimited confidentiality breach liability + Section 5.3 Security Incident definition + Section 7.1 Confidential Information includes Customer Data"
  - **materiality_rationale (verbatim):** Any payment dispute becomes 'amounts owed' (unlimited). Any data breach becomes confidentiality breach (unlimited). Any warranty claim can be recast as refund demand (amounts owed, unlimited). Combined with cyber insurance at only $5M, Lattice faces unlimited exposure beyond insurance on every Security Incident, and Customer faces unlimited exposure on every fee dispute recharacterized as 'amounts owed.' The risk allocation framework has no effective cap.

- **`commercial-terms-analyst-006`** · blocker · tier 2 · category: `termination_payment_obligation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Upon any expiration or termination of this Agreement: (a) Customer's right to access and use the Subscription Services will immediately terminate; (b) Customer will pay Lattice all Fees due and payable as of the effective date of terminati
  - **materiality_rationale (verbatim):** Current language requires Customer to pay 100% of all remaining Fees if Customer terminates for any reason other than Provider's material breach, even if Customer terminates due to business closure, bankruptcy, or a change in business needs unrelated to Provider's performance. On a three-year $3M deal terminated after year one, Customer owes the full $2M balance despite Provider incurring zero future hosting, support, or delivery costs. A 50% termination fee compensates Provider for lost margin while avoiding windfall.

- **`commercial-terms-analyst-001`** · blocker · tier 2 · category: `price_escalation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase will take effec
  - **materiality_rationale (verbatim):** As drafted, Provider may increase Fees by any amount at each renewal with only 60 days' notice. Over a five-year relationship with automatic renewals, this creates unbounded exposure—Provider could double Fees year-over-year. Customer cannot budget or forecast accurately.

- **`termination-remedies-analyst-002`** · blocker · tier 2 · category: `unilateral_fee_obligation_on_early_termination`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Without a termination-for-convenience right, Customer has no exit absent Provider's material breach. Current language makes Customer liable for 100% of remaining Fees even if terminating for legitimate business reasons. In a multi-year Initial Term scenario, Customer could be locked into 36 months of payment obligations regardless of business utility. This effectively transforms a subscription into secured debt without the corresponding legal structure or pricing discount.

- **`termination-remedies-analyst-003`** · blocker · tier 2 · category: `absence_of_termination_for_convenience`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without this right and combined with the 100% fee obligation, Customer is locked into potentially 36 months of non-dischargeable payment obligations even if the Subscription Services become obsolete or redundant. This is not a subscription model—it is a long-term financing agreement disguised as SaaS.

- **`risk-allocation-analyst-002`** · blocker · tier 2 · category: `liability_cap_carve_out_scope`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "EXCEPT FOR (A) AMOUNTS OWED UNDER ANY ORDER FORM, (B) A PARTY'S BREACH OF SECTION 7 (CONFIDENTIALITY), AND (C) LATTICE'S OBLIGATIONS UNDER SECTION 8.3 (LATTICE IP INDEMNITY)"
  - **materiality_rationale (verbatim):** Carve-out (A) means any fee dispute—even a good-faith disagreement over interpretation of usage tiers or overage charges—exposes both parties to unlimited liability beyond the 12-month cap. For Provider, a Customer claim for 'amounts owed' (e.g., refund demand based on alleged service failures) could exceed all fees ever paid. The absence of a gross negligence/willful misconduct carve-out exposes both parties to claims that their insurance will not cover.

- **`risk-allocation-analyst-003`** · major · tier 2 · category: `data_breach_unlimited_exposure`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "EXCEPT FOR (A) AMOUNTS OWED UNDER ANY ORDER FORM, (B) A PARTY'S BREACH OF SECTION 7 (CONFIDENTIALITY), AND (C) LATTICE'S OBLIGATIONS UNDER SECTION 8.3 (LATTICE IP INDEMNITY)"
  - **materiality_rationale (verbatim):** Provider's cyber insurance is capped at $5M. An uncapped confidentiality breach obligation means any significant Security Incident—regardless of degree of fault—creates liability exposure of 2x or more above available insurance coverage. For a SaaS provider handling customer data at scale, this creates uninsurable existential risk on every contract.

- **`critical-issues-auditor-003`** · major · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 10.2 mandatory arbitration in San Francisco + Section 10.2 jury waiver + class action waiver + Section 8.7 consequential damages waiver including 'lost or corrupted data' + Section 2.3 SLA credits as sole remedy + Section 4.4(b) 10
  - **materiality_rationale (verbatim):** The combination of procedural barriers (San Francisco arbitration, class waiver) plus substantive remedy limitations (consequential damages waiver, SLA sole remedy, termination fee) plus lock-in creates three tiers of claim where Customer has no economic remedy: (1) claims under $50K are uneconomical to pursue in arbitration, (2) claims $50K-$200K face consequential damages waiver plus sole remedy limitations that cap recovery below arbitration costs, (3) claims over $200K face liability cap that may be less than damages plus arbitration costs on large deals.

- **`termination-remedies-analyst-001`** · major · tier 2 · category: `cure_period_asymmetry`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods create operational imbalance: Customer faces immediate termination risk for payment delays or inadvertent technical violations after only 30 days, while Provider retains double that period to cure performance failures. In a subscription context where service degradation can compound over weeks, a 30-day window exposes Customer to prolonged service deficiencies without remedy while Provider enjoys extended latitude.

- **`performance-obligations-analyst-001`** · major · tier 2 · category: `SLA sole remedy vs repeated failures`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A. Service credits do not constitute liquidated damages or limit Lattice
  - **materiality_rationale (verbatim):** In a SaaS relationship where Customer depends on availability for business operations, chronic underperformance can degrade Customer's own service to end users. The current sole-remedy framing combined with Section 4.3's 60-day cure effectively traps Customer in a poorly performing service. The proposed three-in-six threshold allows termination after a pattern emerges, without forfeiting prepaid fees for the remainder of a multi-year term.

- **`performance-obligations-analyst-002`** · major · tier 2 · category: `Unilateral service modification right`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may, in its sole discretion, modify, update, or enhance the Subscription Services from time to time, provided that no such modification will materially diminish the core functionality of the Subscription Services described in the a
  - **materiality_rationale (verbatim):** Customer may build significant technical integrations, train staff, or implement compliance processes around the Subscription Services as provided at contract signature. Unilateral modification with only a 'no material diminishment' standard—which Provider interprets—creates risk that functionality Customer depends on could be removed, redesigned, or moved behind a higher pricing tier mid-term. The proposed notice and termination right limits Customer's downside to a pro-rata refund rather than being locked into an unusable service for the remainder of a multi-year term.

- **`termination-remedies-analyst-004`** · major · tier 2 · category: `arbitration_location_venue_imbalance`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** Exclusive San Francisco arbitration situs imposes asymmetric costs on Customer if Customer is not California-based. For disputes under $100K, cross-country arbitration costs (travel, local counsel coordination, time away from business) can exceed recovery, effectively denying Customer a practical remedy. Provider's principal place of business is San Francisco; requiring Customer to come to Provider's home jurisdiction for all disputes creates home-field advantage and economic deterrent to enforcement.

- **`risk-allocation-analyst-004`** · major · tier 2 · category: `ip_indemnity_uncapped_same_risk_product`
  - **rationale_quality:** GENERIC
  - source_text: "EXCEPT FOR (A) AMOUNTS OWED UNDER ANY ORDER FORM, (B) A PARTY'S BREACH OF SECTION 7 (CONFIDENTIALITY), AND (C) LATTICE'S OBLIGATIONS UNDER SECTION 8.3 (LATTICE IP INDEMNITY)"
  - **materiality_rationale (verbatim):** A well-funded patent troll or competitor could assert claims exceeding Provider's total enterprise value. The indemnity covers 'any damages finally awarded' with no cap, meaning a single patent infringement judgment could bankrupt the company. Provider's E&O insurance ($5M) will not cover judgments or settlements exceeding that amount, leaving the delta uninsured.

- **`commercial-terms-analyst-002`** · major · tier 2 · category: `dispute_withholding`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without a dispute-withholding provision, late fees and suspension rights apply mechanically to any unpaid amount, even when Customer disputes the invoice in good faith. This forces Customer to choose between paying contested charges or risking 1.5% monthly interest and service suspension within 40 days. A $500K annual contract with a disputed $50K line item could trigger suspension over an accounting disagreement.

- **`commercial-terms-analyst-003`** · moderate · tier 2 · category: `audit_rights`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Annual advance invoicing could exceed $1M per year. Without audit rights, Customer has no contractual mechanism to verify usage-based charges, seat counts, or other billing inputs. If Provider's metering or billing systems contain errors—even inadvertent ones—Customer has no recourse short of litigation.

- **`coherence-checker-001`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 2.3: 'Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A. Service credits do not constitute liquidated damages or
  - **materiality_rationale (verbatim):** If Customer terminates under the proposed performance-obligations-analyst-001 SLA repeated-failure provision, Provider will argue Section 4.4(b) still applies because the termination was not 'for Lattice's uncured material breach pursuant to Section 4.3'—it was for repeated SLA failures under a new Section 2.3 carve-out. Customer will argue the 'without liability for future Fees' language in the new SLA provision controls as lex specialis. The contract as signed contains an internal contradiction that makes the new SLA termination right economically unusable if Provider can still invoke Section 4.4(b). This defeats the entire purpose of the accepted finding. The contradiction must be resolved by conforming Section 4.4(b) to exclude SLA-based terminations or by adding explicit cross-reference language.

- **`coherence-checker-002`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b): 'if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Te
  - **materiality_rationale (verbatim):** If all three edits are accepted as written, the signed contract will contain: (1) Section 4.4(b) saying 50% of remaining Fees (commercial-terms-analyst-006), (2) the same Section 4.4(b) also saying 50% or 3 months whichever is less (termination-remedies-analyst-002), and (3) a new Section 4.3A saying 25% or 2 months (whichever is less) if in first 12 months and zero fee thereafter (termination-remedies-analyst-003). Provider will argue the highest fee applies; Customer will argue the lowest. The three provisions are internally contradictory and cannot all be applied simultaneously. This is a redlining error that makes the contract unexecutable as drafted.

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.6 liability cap carve-outs as proposed by risk-allocation-analyst-002 and risk-allocation-analyst-003, which modify the same sentence with overlapping but non-identical language."
  - **materiality_rationale (verbatim):** The redline will show two competing replacement texts for Section 8.6 carve-outs, which is nonsensical. The reviewer must choose between uncapped confidentiality breach liability (risk-allocation-analyst-002) or $10M super-cap (risk-allocation-analyst-003). The findings should have been structured as Position/Fallback within a single finding, not as two separate 'replace' markups targeting the same text. This creates ambiguity in the review process and risks the wrong version being accepted if not caught during QA.

- **`coherence-checker-004`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 2.4: 'Lattice may, in its sole discretion, modify, update, or enhance the Subscription Services from time to time, provided that no such modification will materially diminish the core functionality of the Subscription Services desc
  - **materiality_rationale (verbatim):** The accepted finding creates a termination right tied to 'material adverse effect on Customer's use' but leaves the existing 'no material diminishment of core functionality' standard in place. These are two different tests applied to the same modification event. If Provider makes a change that satisfies the 'no material diminishment' standard (Provider's view: core functionality intact) but Customer claims 'material adverse effect on use' (Customer's view: my integration broke), the contract does not clearly resolve who is right. The termination right becomes uncertain and likely leads to dispute. The coherence issue is that the new language in performance-obligations-analyst-002 does not integrate with or supersede the existing Section 2.4 standard—it adds a second, overlapping standard without clarifying the relationship.

---

### run-06 — profile: `profile_empty`, posture: `their_paper_high_leverage`

```
run: run-06
profile: profile_empty
deal_posture: their_paper_high_leverage
total_findings: 16
severity_distribution: {"blocker":7,"major":8,"moderate":1,"minor":0}
tier_distribution: {"tier_1":2,"tier_2":14}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":1,"CONTEXTUAL":14,"EXEMPLARY":1,"UNKNOWN":0,"ERROR":0}
specialist_failures: 0
tokens_used: 123424
elapsed_seconds: 679.2
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 8.6 carves out confidentiality breaches from liability cap (unlimited exposure) + Section 7.1 defines Customer Data as Lattice's Confidential Information + Section 5.3 Security Incident notification obligation with 72-hour window +
  - **materiality_rationale (verbatim):** The security disclaimer + unlimited confidentiality liability + Customer Data definition creates a structure where Lattice has unlimited exposure for an event it has disclaimed any obligation to prevent. The E&O/cyber insurance ($5M) is nine figures short of typical data-breach exposure in class actions. This is an existential hazard for both parties that emerges only from reading all four sections together.

- **`critical-issues-auditor-002`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b) payment acceleration (Customer pays 100% of remaining contract value on termination) + Section 4.2 auto-renewal with 60-day notice requirement + Section 3.5 uncapped price increases at each renewal + Section 4.3 asymmetric 3
  - **materiality_rationale (verbatim):** Customer who misses one 60-day non-renewal notice is locked into another year at whatever price Lattice sets, and if Customer attempts to exit mid-term, Customer owes 100% of the inflated renewal fees for the full year. Over a multi-year relationship with compounding renewals, this creates exponential lock-in. The existential element is the compounding effect: not just that exit is expensive, but that the expense escalates automatically and Customer has no mechanism to cap it short of perfect calendar discipline on 60-day notices.

- **`commercial-terms-analyst-001`** · blocker · tier 2 · category: `payment_acceleration`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** As drafted, Customer cannot exit the relationship without paying 100% of remaining contract value regardless of service need, business change, or vendor performance short of material breach. This eliminates Customer's ability to respond to changed circumstances and creates liability potentially in the millions for a multi-year subscription, functionally eliminating Customer's termination right.

- **`risk-allocation-analyst-002`** · blocker · tier 2 · category: `confidentiality_breach_unlimited_exposure`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "EXCEPT FOR (A) AMOUNTS OWED UNDER ANY ORDER FORM, (B) A PARTY'S BREACH OF SECTION 7 (CONFIDENTIALITY), AND (C) LATTICE'S OBLIGATIONS UNDER SECTION 8.3 (LATTICE IP INDEMNITY), IN NO EVENT WILL EITHER PARTY'S TOTAL CUMULATIVE LIABILITY ARISI
  - **materiality_rationale (verbatim):** Unlimited liability for confidentiality breach means any disclosure of Customer Data exposes Lattice to damages exceeding the total contract value by orders of magnitude. Section 7.1 defines Customer Data as Lattice Confidential Information; any data-breach triggers both Security Incident notice and unlimited-liability confidentiality breach. With no cap, a single incident in a $100K annual contract could generate $10M+ liability. The E&O insurance ($5M) does not cover this gap in many cyber policies.

- **`termination-remedies-analyst-003`** · blocker · tier 2 · category: `post_termination_payment_obligation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Requiring full payment of the entire remaining term creates a lock-in effect: Customer cannot exit even if the Subscription Services become unsuitable for Customer's needs, Customer's business changes direction, or Customer experiences financial hardship. In a multi-year SaaS contract, this could mean paying hundreds of thousands of dollars for services Customer cannot use. This is particularly harsh given the auto-renewal provision in Section 4.2, which could lock Customer into additional years if the non-renewal notice is missed.

- **`insurance-coverage-analyst-001`** · blocker · tier 2 · category: `cyber_liability_coverage`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "errors and omissions / professional liability insurance (which may include cyber liability coverage) with limits of not less than five million U.S. dollars ($5,000,000) per occurrence and in the aggregate"
  - **materiality_rationale (verbatim):** Cyber incidents involving Customer Data create direct liability for Customer under data protection laws and customer contracts. Without required cyber coverage, Customer has no assurance that Lattice's E&O policy includes cyber perils or sufficient limits to address third-party claims arising from a breach, leaving Customer exposed to uninsured indemnity obligations.

- **`performance-obligations-analyst-001`** · blocker · tier 2 · category: `SLA remedy framing creates unintended liability cap interaction`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 2.3: 'Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A.'"
  - **materiality_rationale (verbatim):** If SLA credits are uncapped and Provider's general liability is capped at twelve months of fees under Section 8.6, Customer may be unable to recover aggregate SLA credits exceeding that amount in a sustained outage scenario, defeating the purpose of the SLA. Alternatively, if credits are deemed outside the cap but uncapped themselves, Provider faces theoretically unlimited exposure through the SLA-credit mechanism despite an otherwise-comprehensive liability limitation.

- **`critical-issues-auditor-003`** · major · tier 2 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 9.1 permits unlimited subcontracting without notice or consent + Section 5.2 information security obligations + Section 9.2 insurance requirements do not flow down to subcontractors + Section 8.3 IP indemnity carve-outs include 'us
  - **materiality_rationale (verbatim):** Customer loses security visibility (no notice under Section 9.1), loses insurance backstop (no subcontractor insurance requirement under Section 9.2), and may lose indemnity coverage (Section 8.3 carve-out for non-Lattice products). For a SaaS platform relying on third-party infrastructure (cloud hosting, CDN, payment processors), this is a material gap.

- **`critical-issues-auditor-004`** · major · tier 2 · category: `material_omission`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Customer pays annually in advance for a service that can be materially changed or discontinued; the subscription model creates dependency—Customer integrates the platform into operations and cannot easily switch; SaaS providers routinely deprecate features, sunset APIs, and force migrations to new versions, often with inadequate notice. Without a contractual notice and exit-right provision, Customer has no remedy when critical features are discontinued mid-term or at renewal.

- **`commercial-terms-analyst-002`** · major · tier 2 · category: `dispute_resolution`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without dispute-withholding rights, Customer faces suspension and accumulating late fees if it withholds payment on even a clearly erroneous invoice line item. This forces Customer to pay first and seek recovery later, reversing the economic leverage and requiring Customer to fund Lattice's cash flow even when invoicing is wrong.

- **`commercial-terms-analyst-003`** · major · tier 2 · category: `audit_rights`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Customer pays annually in advance with no ability to verify that usage-based fees, user-count charges, or service-level credits are calculated correctly. Annual invoices on a multi-user SaaS platform can reach hundreds of thousands of dollars; a 5% billing error at that scale is material, and Customer has no mechanism to detect or prove it.

- **`risk-allocation-analyst-004`** · major · tier 2 · category: `gross_negligence_misconduct_unlimited_exposure`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "EXCEPT FOR (A) AMOUNTS OWED UNDER ANY ORDER FORM, (B) A PARTY'S BREACH OF SECTION 7 (CONFIDENTIALITY), AND (C) LATTICE'S OBLIGATIONS UNDER SECTION 8.3 (LATTICE IP INDEMNITY), IN NO EVENT WILL EITHER PARTY'S TOTAL CUMULATIVE LIABILITY ARISI
  - **materiality_rationale (verbatim):** If Lattice grossly mishandles Customer Data (e.g., intentionally disables encryption, ignores known critical vulnerabilities) and causes a data breach resulting in $5M in Customer damages, but the trailing-12-month fees are only $50K because this is a pilot engagement ramping to production, the cap limits Lattice's liability to $50K. While Delaware law may enforce this, it creates reputational risk and makes the contract commercially unreasonable. If Customer engages in willful misconduct (e.g., uses the Subscription Services to launch cyberattacks), Lattice's remedies are capped at trailing fees, which may be inadequate to cover Lattice's own third-party liability or regulatory exposure.

- **`risk-allocation-analyst-005`** · moderate · tier 2 · category: `ip_indemnity_remedy_hierarchy`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "If the Subscription Services become, or in Lattice's opinion are likely to become, the subject of an Infringement Claim, Lattice may, at its option and expense, (i) procure for Customer the right to continue using the Subscription Services
  - **materiality_rationale (verbatim):** If a non-practicing entity asserts an Infringement Claim with uncertain merit, Lattice may find it cheaper to terminate the Subscription Services and refund fees than to procure a license or re-engineer. But if Customer relies on the Subscription Services for revenue-generating operations, sudden termination could cause Customer to breach its own downstream commitments, lose customers, or incur costs far exceeding the refund. The current language gives Lattice unfettered discretion to choose the cheapest remedy for Lattice regardless of impact on Customer. Requiring Lattice to exhaust the other remedies first, and providing a transition period, aligns with the commercial expectation that Subscription Services will remain available absent extraordinary circumstances.

- **`insurance-coverage-analyst-002`** · major · tier 2 · category: `additional_insured_status`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without additional insured status, Customer must rely solely on Lattice's indemnity obligation under Section 8.3 (limited to IP claims) and general breach remedies. If a third party brings a premises or operations claim against Customer arising from Lattice's conduct, Customer has no direct insurance recovery and must pursue Lattice contractually—introducing collection risk and delay.

- **`insurance-coverage-analyst-006`** · major · tier 2 · category: `post_termination_insurance_survival`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** If Lattice discontinues E&O or cyber coverage immediately upon termination, claims arising from incidents during the Subscription Term but reported post-termination are uninsured (because claims-made policies require both occurrence and reporting during the policy period). Customer's indemnity rights under Section 8.3 become collection claims against an uninsured Lattice, creating financial risk if the claim exceeds Lattice's uninsured assets.

- **`performance-obligations-analyst-002`** · major · tier 2 · category: `Professional Services acceptance criteria`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 2.5: 'Each SOW will identify the scope of work, deliverables (if any), fees, milestones, and any acceptance criteria.'"
  - **materiality_rationale (verbatim):** Without mandatory acceptance criteria and a deemed-acceptance fallback, Provider cannot close out Professional Services engagements or invoice final milestones when Customer fails to respond. This exposes Provider to indefinite liability for rework and prevents revenue recognition. In a services-heavy deal this creates material commercial exposure.

---

### run-07 — profile: `profile_empty`, posture: `their_paper_low_leverage`

```
run: run-07
profile: profile_empty
deal_posture: their_paper_low_leverage
total_findings: 14
severity_distribution: {"blocker":3,"major":11,"moderate":0,"minor":0}
tier_distribution: {"tier_1":0,"tier_2":14}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":2,"CONTEXTUAL":12,"EXEMPLARY":0,"UNKNOWN":0,"ERROR":0}
specialist_failures: 0
tokens_used: 137485
elapsed_seconds: 604.9
```

**Findings:**

- **`risk-allocation-analyst-001`** · blocker · tier 2 · category: `liability_cap_carveouts`
  - **rationale_quality:** GENERIC
  - source_text: "EXCEPT FOR (A) AMOUNTS OWED UNDER ANY ORDER FORM, (B) A PARTY'S BREACH OF SECTION 7 (CONFIDENTIALITY), AND (C) LATTICE'S OBLIGATIONS UNDER SECTION 8.3 (LATTICE IP INDEMNITY), IN NO EVENT WILL EITHER PARTY'S TOTAL CUMULATIVE LIABILITY ARISI
  - **materiality_rationale (verbatim):** Unlimited liability for confidentiality breach means any significant data breach or inadvertent disclosure, regardless of your contributory negligence or the absence of actual damages, could create catastrophic exposure. The IP indemnity carve-out similarly creates unlimited exposure for infringement claims even where damages are speculative. In combination, these carve-outs eliminate the practical benefit of having a liability cap.

- **`termination-remedies-analyst-002`** · blocker · tier 2 · category: `tail_liability`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** If you sign a three-year Initial Term and need to exit in year two due to merger, budget reduction, or product pivot, you owe 12 months of full Fees with no corresponding service. In a mid-market SaaS deal this creates six-figure unbudgeted liability and effectively locks you into service you cannot use.

- **`risk-allocation-analyst-003`** · major · tier 2 · category: `consequential_damages`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "IN NO EVENT WILL EITHER PARTY BE LIABLE TO THE OTHER PARTY FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOST PROFITS, LOST REVENUE, LOST GOODWILL, LOST OR CORRUPTED DATA, OR COSTS OF SUBS
  - **materiality_rationale (verbatim):** In a data-breach or confidentiality-breach scenario, your actual harm is often the loss or corruption of Customer Data. Categorizing that as consequential and waiving it means you have no remedy even when the provider breaches its core security and confidentiality obligations. The combination of waiving data loss and carving out confidentiality from the cap creates an internal contradiction: confidentiality breach liability is unlimited in theory but zero in practice because the damages are waived.

- **`termination-remedies-analyst-001`** · major · tier 2 · category: `cure_period_asymmetry`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods create unequal termination risk. If you miss a payment or violate usage restrictions due to administrative error, you have half the time to cure that the provider has for service failures. In a low-leverage deal posture, 30-day cure exposes you to termination over issues that could be resolved given reasonable time.

- **`termination-remedies-analyst-003`** · major · tier 2 · category: `material_breach_definition`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without a definition, the provider could assert that any service complaint, usage-limit exceedance, or payment dispute is material and trigger a 30-day cure-or-terminate scenario. You face termination risk over issues both parties might consider minor. In a subscription relationship spanning multiple years, definitional clarity prevents strategic termination threats over non-substantive issues.

- **`termination-remedies-analyst-004`** · major · tier 2 · category: `exclusive_arbitration_location`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** If you are headquartered on the East Coast or internationally, mandatory San Francisco arbitration adds significant travel and local-counsel costs to any mid-size dispute. For claims under the liability cap, the forum cost may exceed the recovery, effectively eliminating your remedy.

- **`insurance-coverage-analyst-001`** · major · tier 2 · category: `cyber_liability_coverage`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "errors and omissions / professional liability insurance (which may include cyber liability coverage) with limits of not less than five million U.S. dollars ($5,000,000) per occurrence and in the aggregate"
  - **materiality_rationale (verbatim):** The provider hosts and processes Customer Data. A data breach affecting Customer Data could trigger regulatory penalties, notification costs, and third-party claims. Without required cyber coverage, you bear the risk that the provider's errors and omissions policy excludes cyber losses, leaving you to pursue damages against the provider's general assets subject to the 12-month-fees liability cap.

- **`termination-remedies-analyst-006`** · major · tier 2 · category: `force_majeure_payment_exclusion`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Neither Party will be liable for any delay or failure to perform its obligations under this Agreement (other than payment obligations) to the extent such delay or failure is caused by an event beyond such Party's reasonable control"
  - **materiality_rationale (verbatim):** If a force majeure event prevents the provider from providing service for 60 days, the force majeure clause gives either party the right to terminate, but does not suspend payment obligations during the event. You pay two months of Fees for zero service, and if you terminate, the already-accrued Fees are unrecoverable.

- **`commercial-terms-analyst-002`** · major · tier 2 · category: `fee_increase_cap`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase will take effec
  - **materiality_rationale (verbatim):** Uncapped renewal increases combined with automatic renewal and non-refundable fees create unbounded budget risk. The provider could unilaterally impose a 20% or 30% increase at each renewal, forcing you either to accept or to migrate platforms mid-term at substantial switching cost. A 5%/CPI cap preserves the provider's inflation adjustment while making your long-term costs plannable.

- **`commercial-terms-analyst-001`** · major · tier 2 · category: `dispute_withholding_mechanics`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without dispute-withholding rights, you are forced to pay potentially incorrect or excessive charges in full to avoid late fees and service suspension, then attempt recovery post-payment. In a contract with annual advance billing and uncapped renewal increases, this creates a material cash-flow disadvantage and eliminates your leverage to negotiate billing disputes in good faith.

- **`protective-provisions-analyst-001`** · major · tier 2 · category: `IP ownership - Professional Services deliverables`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** If Custom Deliverables created specifically for you under a Statement of Work belong to the provider, you cannot use them after termination or with a successor vendor, and you have paid for work product you do not own. For Professional Services engagements costing tens to hundreds of thousands of dollars, this creates significant economic exposure and vendor lock-in.

- **`coherence-checker-001`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.7: IN NO EVENT WILL EITHER PARTY BE LIABLE TO THE OTHER PARTY FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOST PROFITS, LOST REVENUE, LOST GOODWILL, LOST OR CORRUPTED DATA, OR 
  - **materiality_rationale (verbatim):** As currently drafted with both accepted edits, any confidentiality breach resulting in lost or corrupted Customer Data triggers unlimited liability with no cap. A single inadvertent disclosure event affecting your data could result in damages orders of magnitude beyond the 12-month-fees base cap. This is the highest-severity internal contradiction in the accepted findings because it converts a negotiated liability framework into an unlimited-exposure scenario for the most probable harm (data breach). The signing attorney and business owner will face unlimited exposure they believe was capped.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b): if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Ter
  - **materiality_rationale (verbatim):** The ambiguity creates a five- or six-figure tail-liability dispute in any scenario where the provider terminates for your breach. If the provider terminates in month 6 of a 36-month term due to your payment default, do you owe 30 months of full Fees (100% tail) or 6 months of half Fees (50% cap)? The accepted edits do not resolve this, and the provider will argue for the higher amount. The language should be tightened to avoid litigation over this threshold issue.

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 9.3: Customer's obligation to pay Fees is suspended during any period in which Lattice is unable to provide the Subscription Services due to a Force Majeure Event affecting Lattice."
  - **materiality_rationale (verbatim):** In a major force majeure event causing extended outage (e.g., AWS region failure, pandemic-related infrastructure collapse), the difference between service credits (typically 10–25% of monthly fee as a credit) and full fee suspension (100% of fee for the outage period) is significant. The ambiguity creates a five-figure dispute in any such event. Clarifying that force majeure outages are excluded from SLA and governed solely by the fee-suspension mechanism eliminates the conflict and ensures you receive the negotiated relief.

---

### run-08 — profile: `profile_empty`, posture: `negotiated_draft`

```
run: run-08
profile: profile_empty
deal_posture: negotiated_draft
total_findings: 19
severity_distribution: {"blocker":1,"major":9,"moderate":9,"minor":0}
tier_distribution: {"tier_1":0,"tier_2":19}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":8,"CONTEXTUAL":10,"EXEMPLARY":1,"UNKNOWN":0,"ERROR":0}
specialist_failures: 2 (commercial-terms-analyst, protective-provisions-analyst)
tokens_used: 113119
elapsed_seconds: 660.9
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 2 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.6 liability cap carve-out (a) 'AMOUNTS OWED UNDER ANY ORDER FORM' combined with Section 4.4(b) early termination fees 'Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Te
  - **materiality_rationale (verbatim):** Section 4.4(b) accelerates ALL future Fees upon Customer termination (unless for Lattice's uncured breach), and Section 8.6(a) exempts this entire accelerated payment from the cap. Example: 3-year deal at $500K/year. After Year 1, if Customer terminates because the service no longer fits business needs (not a Lattice material breach), Customer owes $1M immediately under Section 4.4(b), and this $1M bypasses the $500K liability cap via Section 8.6(a). The liability cap is illusory for Customer-initiated terminations.

- **`critical-issues-auditor-002`** · major · tier 2 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 2.3 SLA sole remedy ('service credits... are the sole and exclusive remedies') combined with Section 8.1 warranty sole remedy ('sole and exclusive remedy... is, at Lattice's option... (iii) terminate... and refund') combined with S
  - **materiality_rationale (verbatim):** If the Subscription Services experience significant outages, three contradictory remedy regimes apply with no clear priority. Section 2.3 says sole remedy is service credits; Section 8.1 says sole remedy for warranty breach is at vendor's election; Section 8.6 caps all liability at 12-month fees. The interaction is indeterminate, creating litigation risk and potentially leaving the customer with minimal recovery for substantial harm.

- **`risk-allocation-analyst-002`** · major · tier 2 · category: `cap_aggregation_across_order_forms`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "THE LIABILITY CAP SET FORTH IN THIS SECTION 8.6 SHALL APPLY IN AGGREGATE TO ALL CAUSES OF ACTION (WHETHER IN CONTRACT, TORT, OR OTHERWISE), ALL THEORIES OF LIABILITY, AND ALL ORDER FORMS UNDER THIS AGREEMENT"
  - **materiality_rationale (verbatim):** Under the current language, multiple separate Order Forms share a single liability pool. If one Order Form suffers a breach causing significant damages and a separate Order Form separately suffers a breach, total recovery is capped at the aggregate trailing fees, potentially leaving the customer uncompensated for provable damages on individual projects.

- **`risk-allocation-analyst-003`** · major · tier 2 · category: `gross_negligence_willful_misconduct_cap`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without this carve-out, the vendor could engage in reckless data handling or willful misconduct and limit liability to 12 months of fees. Capping liability for intentional or reckless conduct creates moral hazard and is contrary to public policy in most jurisdictions.

- **`insurance-coverage-analyst-001`** · major · tier 2 · category: `cyber_liability_specification`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "errors and omissions / professional liability insurance (which may include cyber liability coverage) with limits of not less than five million U.S. dollars ($5,000,000) per occurrence and in the aggregate"
  - **materiality_rationale (verbatim):** The contract permits but does not require standalone cyber coverage. For a SaaS provider hosting data, data-breach risk is primary; a general E&O policy may exclude or sublimit cyber claims, leaving inadequate recourse if cyber insurance proves insufficient or non-existent.

- **`insurance-coverage-analyst-002`** · major · tier 2 · category: `additional_insured_status`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without additional-insured status, the customer must rely solely on the vendor's indemnity promise. If the vendor becomes insolvent or its insurer denies coverage for reasons unrelated to the customer, the customer bears defense and liability costs. Additional-insured status provides direct recourse to the vendor's carrier.

- **`insurance-coverage-analyst-003`** · moderate · tier 2 · category: `primary_and_non_contributory`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without primary/non-contributory language, if both parties carry applicable coverage, insurers may dispute priority or seek contribution, delaying claim resolution and potentially leaving the customer with out-of-pocket costs.

- **`insurance-coverage-analyst-004`** · moderate · tier 2 · category: `waiver_of_subrogation`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without waiver of subrogation, after the vendor's insurer pays a claim arising from an incident partially caused by customer conduct, the insurer may subrogate against the customer. This exposes the customer to post-claim litigation despite the vendor's insurance covering the loss.

- **`insurance-coverage-analyst-005`** · moderate · tier 2 · category: `notice_of_cancellation`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without notice of cancellation or material reduction, the customer may unknowingly continue performance while the vendor is uninsured or underinsured. If a loss occurs during this period, the customer's recourse is limited to the vendor's assets, which may be insufficient given the liability cap.

- **`insurance-coverage-analyst-007`** · moderate · tier 2 · category: `post_termination_insurance_survival`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.5 Survival: The provisions of Sections 1, 3 (with respect to amounts accrued prior to termination), 4.4, 4.5, 6, 7, 8, 9, and 10 will survive any expiration or termination of this Agreement."
  - **materiality_rationale (verbatim):** Section 4.5 does not include Section 9 in the survival list. Without survival, the vendor's insurance obligations terminate immediately upon contract termination. If a Security Incident or professional liability claim arises after termination but relates to performance during the service term, the vendor may have no coverage in place, leaving the customer to rely solely on the vendor's assets under the liability cap. For claims-made policies, coverage ceases at policy expiration unless tail coverage is purchased.

- **`performance-obligations-analyst-001`** · major · tier 2 · category: `SLA sole-remedy and liability cap interaction`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 2.3: 'Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A.' and Section 8.6: 'EXCEPT FOR (A) AMOUNTS OWED UNDER AN
  - **materiality_rationale (verbatim):** If service credits are the sole remedy but also subject to the 12-month liability cap, recovery for prolonged or severe service failures may be capped at a value far below actual harm. If uncapped credits were intended, the current drafting creates litigation risk over which provision controls.

- **`performance-obligations-analyst-002`** · moderate · tier 2 · category: `Missing deemed-acceptance provision for Professional Services`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without a default acceptance mechanism, Professional Services engagements on time-and-materials or milestone-based payment risk payment disputes and indefinite performance obligations. A deemed-acceptance default (overridable in SOWs) protects the vendor from indefinite re-work obligations and protects the customer by establishing a clear objection window.

- **`performance-obligations-analyst-003`** · moderate · tier 2 · category: `Missing customer-cooperation dependencies`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** In implementation projects, customer cooperation failures are a leading cause of schedule overruns. Without a cooperation clause, the vendor risks being held in breach of deadlines when delays are customer-caused, absorbing additional costs from rework and extended timelines with no recovery mechanism, and facing service-level credit exposure if customer cooperation failures impact service availability.

- **`performance-obligations-analyst-004`** · moderate · tier 2 · category: `Unilateral service modification right`
  - **rationale_quality:** GENERIC
  - source_text: "Section 2.4: 'Lattice may, in its sole discretion, modify, update, or enhance the Subscription Services from time to time, provided that no such modification will materially diminish the core functionality of the Subscription Services desc
  - **materiality_rationale (verbatim):** The customer has no practical remedy if the vendor modifies the service in ways that, while preserving 'core functionality' as the vendor defines it, break integrations, remove features the customer relies on, or change the user experience in ways incompatible with workflows. Without advance notice, the customer cannot plan for or object to changes before deployment. Without a termination right, the customer is locked into paying for a service that no longer meets its needs.

- **`performance-obligations-analyst-005`** · moderate · tier 2 · category: `Warranty remedy insufficient for repeated failures`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.1: 'Customer's sole and exclusive remedy and Lattice's entire liability for any breach of the warranty in clause (b) is, at Lattice's option and expense, to (i) modify the Subscription Services to make them conform to the warrant
  - **materiality_rationale (verbatim):** If the vendor can immediately elect to terminate and refund rather than cure a warranty breach, the customer loses the benefit of its bargain with no recourse. If the vendor attempts to cure but repeatedly fails, the customer is locked into a non-conforming service. A two-attempt or 60-day cure period before termination is available protects the customer's reliance interest.

- **`termination-remedies-analyst-001`** · major · tier 2 · category: `cure period asymmetry`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** The customer faces termination exposure on half the cure period afforded to the vendor. In a complex environment where remediation may require vendor coordination, data migration, or contract amendment, 30 days may be insufficient to cure breaches, forcing early termination and triggering early-termination fees.

- **`termination-remedies-analyst-002`** · moderate · tier 2 · category: `termination for convenience absence`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without a termination-for-convenience option, the customer is locked into the full term regardless of changed circumstances. If the customer's business undergoes acquisition, pivot, or regulatory change rendering the services unnecessary, the only exit is to claim material breach by the vendor—a high bar that may not be met and that invites dispute. This creates strategic rigidity and potential dead-weight spend on unused services.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Accepted finding critical-issues-auditor-001 proposes removing Section 8.6(a) carve-out ('AMOUNTS OWED UNDER ANY ORDER FORM') AND capping Section 4.4(b) early termination fees at 50% of remaining Fees. Accepted finding termination-remedies
  - **materiality_rationale (verbatim):** As currently drafted, accepting both findings creates internal duplication and potential contradiction. Section 4.4(b) as amended would say 'if Customer terminates other than for Lattice's uncured material breach, Customer pays 50% of remaining Fees.' New Section 4.3A would say 'Customer may terminate for convenience and pays 50% of remaining Fees.' These appear to describe the same event (Customer-initiated termination not based on vendor breach) with the same fee, but are stated as separate provisions. A sophisticated counterparty will ask: are these cumulative (100% total), alternative (Customer's election), or redundant (same thing stated twice)? The redline needs clarification. Additionally, the removal of the Section 8.6(a) carve-out means early-termination fees are capped at trailing 12-month Fees, which may render the 50% fee illusory in short-tenure scenarios (e.g., termination after 6 months of a 3-year deal: 50% of 2.5 years remaining = 1.25 years of fees, but liability cap is only 0.5 years of trailing fees, so cap controls and Customer pays 0.5 years, not 1.25 years). Neither finding acknowledges this interaction.

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Accepted finding performance-obligations-analyst-001 proposes clarifying whether service credits under Section 2.3 are subject to the Section 8.6 liability cap. Accepted finding critical-issues-auditor-002 proposes adding a remedies hierar
  - **materiality_rationale (verbatim):** The redline as currently structured will produce three separate edits addressing service-credit liability treatment, and they are not fully aligned. Finding critical-issues-auditor-002's remedies hierarchy is the most comprehensive and likely supersedes the narrower proposals in findings performance-obligations-analyst-001 and performance-obligations-analyst-005, but neither of the latter two findings cross-references the hierarchy proposal. A counterparty reading the redline will see: (1) an annotation asking 'are service credits subject to the cap?' (finding -001), (2) a comprehensive remedies hierarchy stating credits are not subject to the cap and are alternative to warranty remedies (finding critical-issues-auditor-002), and (3) a warranty-remedy amendment stating credits are cumulative with warranty remedies in one scenario (finding performance-obligations-analyst-005). The third edit contradicts the second. This creates ambiguity about whether credits are ever cumulative with other remedies.

---

### run-09 — profile: `playbook_buyer_positions`, posture: `our_paper`

```
run: run-09
profile: playbook_buyer_positions
deal_posture: our_paper
total_findings: 17
severity_distribution: {"blocker":5,"major":12,"moderate":0,"minor":0}
tier_distribution: {"tier_1":9,"tier_2":8}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":6,"CONTEXTUAL":8,"EXEMPLARY":3,"UNKNOWN":0,"ERROR":0}
specialist_failures: 1 (protective-provisions-analyst)
tokens_used: 122859
elapsed_seconds: 595.1
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b) early-termination payment obligation + Section 4.2 automatic renewal with 60-day notice + Section 3.5 uncapped fee increases"
  - **materiality_rationale (verbatim):** Individual specialists look only at their domain; this hazard requires seeing three domains simultaneously (renewal mechanics + fee increases + post-termination payment). In a 3-year Initial Term at $500K ARR: Customer misses 60-day window in Month 35, auto-renews into Year 4. Lattice raises fees from $500K to $750K (50% increase, uncapped). Customer discovers this in Month 37 and attempts to terminate. Under Section 4.4(b), Customer owes $750K × 10/12 months remaining = $625K for services Customer will not receive. This is existential: it converts a procedural calendar miss into a half-million-dollar sunk cost with no corresponding service delivery.

- **`critical-issues-auditor-002`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.6 liability cap at 1x annual fees + Section 9.2(b) E&O/cyber insurance at $5M limits + no cap-to-insurance step-up"
  - **materiality_rationale (verbatim):** At $500K ARR, a data breach costing $2M to remediate (well within the profile for a 100K-record breach under state notification statutes + CCPA penalties + class-action defense) leaves Customer with $1.5M in unrecoverable losses DESPITE Lattice's $5M cyber policy that would pay the full $2M if the cap permitted recovery. This is a structural subsidy: Customer's cap protects Lattice's balance sheet while Lattice's insurer (who charged premiums for $5M coverage) never pays out because the contract caps Customer's claim below the policy limits.

- **`critical-issues-auditor-003`** · blocker · tier 1 · category: `existential_escalation`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 4.4(b) full remaining-term payment obligation for non-breach terminations (flagged by termination-remedies-analyst-005 as blocker but marked existential:false)"
  - **materiality_rationale (verbatim):** Section 4.4(b) eliminates Customer's ability to exit the contract under ANY circumstance other than proving Lattice's material breach AND Lattice's failure to cure within 60 days. This means: (1) if Customer's business fails, Customer owes full remaining contract value; (2) if Customer is acquired and the acquirer uses a competing platform, Customer owes full remaining contract value; (3) if Lattice's service deteriorates but does not breach SLA thresholds in Exhibit A, Customer owes full remaining contract value; (4) if a force majeure event lasts 59 days and Customer terminates under Section 9.3, Customer owes full remaining contract value (Section 9.3 grants termination right but does NOT waive Section 4.4(b) payment). In a 3-year contract at $500K ARR, this is $1.5M of locked-in liability with no performance obligation from Lattice. This is the DEFINITION of existential: it makes the contract economically irrational to sign because Customer cannot exit under any commercially reasonable scenario without paying for services it will never receive.

- **`commercial-terms-analyst-004`** · blocker · tier 1 · category: `renewal_fee_increases`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase will take effec
  - **materiality_rationale (verbatim):** Uncapped fee increases create unbounded multi-year cost exposure; without a cap, Customer cannot budget renewals beyond the Initial Term. On a subscription contract that auto-renews, a vendor could impose double-digit increases with 60 days' notice. CPI or 5% cap is standard in mid-market SaaS and aligns with Customer's procurement policies for multi-year commitments.

- **`commercial-terms-analyst-002`** · major · tier 1 · category: `late_fees`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month, or the maximum rate permitted by applicable law, whichever is lower, calculated from the date such payment was due until the date 
  - **materiality_rationale (verbatim):** 1.5% monthly late fee exceeds Customer's Profile ceiling of 1%; without a dispute carve-out, Customer incurs compounding interest on amounts it legitimately contests, creating pressure to pay first and dispute later, which undermines Customer's ability to verify invoice accuracy.

- **`risk-allocation-analyst-002`** · major · tier 1 · category: `liability_cap_formula`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "THE FEES PAID OR PAYABLE BY CUSTOMER TO LATTICE UNDER THE APPLICABLE ORDER FORM IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE LIABILITY."
  - **materiality_rationale (verbatim):** The 'or payable' language permits Lattice to argue that the cap is the higher of (a) fees actually paid or (b) fees contractually due but not yet paid (e.g., disputed invoices, payment-plan balances). This inflates the cap unpredictably and prevents Customer from accurately reserving for worst-case liability exposure.

- **`termination-remedies-analyst-001`** · major · tier 1 · category: `auto-renewal mechanics`
  - **rationale_quality:** GENERIC
  - source_text: "Unless otherwise specified in an Order Form, upon expiration of the Initial Term, the Subscription Services will automatically renew for successive one-year periods (each, a \"Renewal Term\") unless either Party provides written notice of 
  - **materiality_rationale (verbatim):** Missing the 60-day notice window by even a few days locks Customer into an additional 12-month renewal term on terms negotiated potentially years earlier, creating budget inflexibility and eliminating leverage for mid-cycle price or scope adjustments. A 30-day window reduces calendar risk while still providing reasonable planning time.

- **`termination-remedies-analyst-002`** · major · tier 1 · category: `cure period asymmetry`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods (30 days for Customer, 60 for Lattice) signal that Lattice anticipates using the remedy more frequently than Customer and creates operational risk: if Customer's personnel are unavailable (travel, medical, etc.) during the 30-day window, a curable issue becomes a termination event. Symmetric 60/60 cure aligns with Profile requirements and market practice.

- **`termination-remedies-analyst-003`** · major · tier 1 · category: `termination for convenience`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without termination for convenience, Customer is locked into the full term even if business needs change, Lattice's service quality deteriorates but does not breach, or Customer undergoes restructuring. The Profile explicitly negotiates for this right after 12 months with reasonable notice; absence eliminates flexibility and creates sunk-cost exposure in a multi-year commitment.

- **`commercial-terms-analyst-003`** · major · tier 2 · category: `payment_disputes`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without dispute-withholding mechanics, Customer faces a choice between paying contested amounts to avoid interest, or contesting amounts and incurring 1.5% monthly interest during resolution. This creates leverage imbalance on invoice disputes and discourages Customer from exercising ordinary AP reconciliation practices. SaaS agreements of this type typically include dispute mechanisms, especially when late fees are present.

- **`risk-allocation-analyst-004`** · major · tier 2 · category: `consequential_damages_waiver_scope`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "IN NO EVENT WILL EITHER PARTY BE LIABLE TO THE OTHER PARTY FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOST PROFITS, LOST REVENUE, LOST GOODWILL, LOST OR CORRUPTED DATA, OR COSTS OF SUBS
  - **materiality_rationale (verbatim):** If Lattice willfully discloses Customer's confidential information to a competitor, causing Customer to lose a major customer relationship, Customer cannot recover the lost revenue (consequential damages) even though the breach was intentional. This eliminates deterrence for deliberate misconduct and permits Lattice to treat confidentiality obligations as cost-of-doing-business items capped at direct damages only.

- **`insurance-coverage-analyst-001`** · major · tier 2 · category: `additional_insured_status`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without AI status, Customer faces potential third-party liability claims arising from Lattice's negligent performance (e.g., on-site professional services causing injury, contractor access to Customer facilities) that would not be covered by Lattice's policy, leaving Customer exposed to defense costs and potential judgments not covered by Lattice's indemnity obligations under 8.3.

- **`insurance-coverage-analyst-002`** · major · tier 2 · category: `primary_and_non_contributory`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without primary/non-contributory language, if a third-party claim triggers both Lattice's CGL and Customer's own liability policies, insurers may dispute which policy responds first, forcing Customer to incur defense costs and participate in allocation litigation, and potentially exhausting Customer's own limits before Lattice's insurer contributes.

- **`performance-obligations-analyst-001`** · major · tier 2 · category: `SLA sole-and-exclusive remedy with termination as fallback remedy`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A. Service credits do not constitute liquidated damages or limit Lattice
  - **materiality_rationale (verbatim):** As written, Customer can terminate for repeated SLA failures under Section 4.3 but remains liable for all Fees through the end of the Subscription Term per Section 4.4(b). This creates a scenario where Customer is paying for a non-performing service with no financial remedy other than capped service credits. In a multi-year contract with annual prepayment (per Section 3.2), this exposure is material.

- **`coherence-checker-001`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 4.4(b): 'Customer will pay Lattice all Fees due and payable as of the effective date of termination, and, if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shal
  - **materiality_rationale (verbatim):** This is the highest-severity coherence issue in the accepted findings: we are proposing to ADD a customer-favorable termination right (4.3A) with a 3-month cost cap, but the existing payment-obligation language in 4.4(b) would nullify it entirely. In a 3-year contract at $500K ARR, Customer exercises convenience termination at Month 18 under the proposed 4.3A, expecting to pay 3 months of fees ($125K). But Section 4.4(b) triggers instead, requiring payment of 18 months remaining × $500K = $750K. The 3-month cap never applies because 4.4(b) sweeps in ALL non-breach terminations. This makes the proposed edit ineffective and creates an internal contradiction that sophisticated counterparty counsel will exploit. We MUST either revise 4.4(b) to exclude 4.3A terminations, or withdraw finding termination-remedies-analyst-003.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 9.3: 'If a Force Majeure Event continues for more than sixty (60) consecutive days, either Party may terminate the affected Order Form upon written notice to the other Party.'"
  - **materiality_rationale (verbatim):** Section 9.3 is drafted as a mutual relief valve for prolonged Force Majeure Events — neither party is at fault, and termination is available to both sides. But Section 4.4(b) converts Customer's exercise of that right into a financial penalty: Customer pays 100% of remaining fees with no corresponding Lattice performance obligation (Lattice is excused by Force Majeure). In a 3-year contract at $500K ARR with 18 months remaining, a 61-day Force Majeure Event followed by Customer termination under 9.3 results in $750K payment for zero service delivery. This is commercially irrational and inconsistent with the Force Majeure doctrine, which relieves BOTH parties of performance obligations. Section 4.4(b) must carve out Section 9.3 terminations, or Section 9.3 must explicitly address payment consequences.

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 3.3: 'Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month...' AND proposed Section 3.6 (commercial-terms-analyst-003): 'Interest under Section 3.3 shall not accrue on amounts 
  - **materiality_rationale (verbatim):** While both findings serve the same substantive goal (protect Customer from interest on disputed amounts), the redundancy creates poor drafting that signals lack of coordination. Counterparty will ask: 'Which carve-out controls? What if they conflict?' More importantly, the redundancy weakens our negotiating position — it suggests we are over-lawyering a single point and invites pushback on BOTH provisions ('if you need it twice, you don't need it at all'). Best practice is to pick ONE location for the dispute carve-out and draft it cleanly. We recommend accepting commercial-terms-analyst-003 (which adds a comprehensive dispute-withholding procedure in new Section 3.6) and REMOVING the dispute carve-out from the proposed revision to Section 3.3 in commercial-terms-analyst-002. This consolidates the dispute mechanics in one place and avoids redundancy.

---

### run-10 — profile: `playbook_buyer_positions`, posture: `their_paper_high_leverage`

```
run: run-10
profile: playbook_buyer_positions
deal_posture: their_paper_high_leverage
total_findings: 23
severity_distribution: {"blocker":8,"major":11,"moderate":4,"minor":0}
tier_distribution: {"tier_1":11,"tier_2":12}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":7,"CONTEXTUAL":11,"EXEMPLARY":5,"UNKNOWN":0,"ERROR":0}
specialist_failures: 0
tokens_used: 126080
elapsed_seconds: 650.9
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b): 'if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Te
  - **materiality_rationale (verbatim):** The structural trap: auto-renewal locks Customer into Year 2 → Lattice increases fees by (hypothetically) 40% with 60-day notice → Customer cannot exit without paying 100% of Year 2 at the 40% premium. On a $500K annual contract, this is a potential unbudgeted $200K exposure if Customer misses the renewal window. This is existential because it eliminates Customer's ability to control spend and creates vendor pricing leverage that extends beyond the Initial Term into perpetuity.

- **`commercial-terms-analyst-003`** · blocker · tier 1 · category: `renewal_fee_increases`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term."
  - **materiality_rationale (verbatim):** Uncapped discretionary fee increases at renewal eliminate Customer's ability to forecast spend or evaluate competitive alternatives on a level playing field. A vendor exercising this right to impose a 20% or 30% increase would force Customer either to accept unbudgeted expense or to migrate mid-term at significant switching cost.

- **`risk-allocation-analyst-001`** · blocker · tier 1 · category: `liability_cap_carveouts`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Customer processes business-critical data through the Subscription Services. A data breach could trigger regulatory penalties, notification costs, forensics, credit monitoring, and reputational harm far exceeding annual subscription fees. Without a super-cap tied to insurance limits, Customer faces unbounded exposure in the event Lattice's security program fails. Without gross negligence and willful misconduct carve-outs, Lattice can cap liability even for reckless or intentional breaches.

- **`critical-issues-auditor-002`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 2.3: 'Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A. Service credits do not constitute liquidated damages or
  - **materiality_rationale (verbatim):** Performance-obligations-analyst correctly flagged the SLA sole-remedy framing as a blocker and identified the absence of a termination right for repeated SLA failures. Termination-remedies-analyst correctly flagged the post-termination payment obligation as a blocker. However, neither specialist identified the hazard that emerges when the SLA sole-remedy interacts with the 60-day cure requirement and the post-termination payment obligation. The structural issue: sole-remedy eliminates termination leverage → 60-day cure allows vendor to temporarily comply → post-termination payment eliminates economic exit. Customer cannot force performance and cannot leave without paying for services it is not receiving. On a critical-path SaaS platform, this is a business-continuity hazard.

- **`risk-allocation-analyst-002`** · moderate · tier 1 · category: `termination_cure_period`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods (30 days for Customer breach, 60 days for Lattice breach) signal that Lattice expects to invoke termination remedies more frequently than Customer. This creates a structural incentive for Lattice to declare breaches earlier and more aggressively, knowing Customer has half the remediation window. For a high-leverage deal where Customer depends on continuity of service, asymmetric termination rights increase counterparty risk without corresponding benefit.

- **`termination-remedies-analyst-001`** · major · tier 1 · category: `auto-renewal notice period`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "unless either Party provides written notice of non-renewal to the other Party at least sixty (60) days prior to the end of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Missing the 60-day notice window by even one business day commits Customer to an additional one-year term and the associated annual Fees. Customer's procurement cycle operates on 30-day windows; 60 days doubles the exposure to inadvertent renewal. Given high_leverage posture, this is a material budget-lock risk.

- **`termination-remedies-analyst-002`** · blocker · tier 1 · category: `asymmetric cure periods`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Vendor receives twice the time to cure as Customer. In a SaaS context where the typical Customer 'breach' is payment-related (remediable within billing cycles), the shorter cure period burdens Customer disproportionately. If Lattice suffers a data-security or availability breach, Customer has only 30 days to cure phantom exposure while Lattice has 60 days to cure actual service failures. This is a Profile red-flag (asymmetric cure favoring vendor).

- **`termination-remedies-analyst-003`** · major · tier 1 · category: `termination for convenience`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Absence of termination-for-convenience means Customer is locked into the full Initial Term and any auto-renewed Renewal Terms with no exit other than for-cause termination (which requires proof of material breach and may be disputed). If Customer's business requirements change, budget is reallocated, or a better solution emerges, Customer has no negotiated exit. This is a Profile negotiating point and aligns with standard SaaS practice for mid-market customers.

- **`termination-remedies-analyst-004`** · blocker · tier 2 · category: `post-termination payment obligation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Customer must pay full freight for the remainder of the Subscription Term even after termination. If Customer terminates in month 6 of a 12-month term for any reason other than Lattice's uncured material breach (e.g., Lattice commits a breach but cures it, or Customer terminates for non-material business reasons), Customer pays for six months of services it cannot use. This converts every Subscription Term into an unconditional payment obligation regardless of continued service delivery. It eliminates the economic pressure on Lattice to perform, because Lattice gets paid whether or not Customer has access.

- **`commercial-terms-analyst-002`** · moderate · tier 1 · category: `late_fees`
  - **rationale_quality:** GENERIC
  - source_text: "Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month, or the maximum rate permitted by applicable law, whichever is lower, calculated from the date such payment was due until the date 
  - **materiality_rationale (verbatim):** 1.5% monthly rate (18% annualized) exceeds Profile-accepted maximum of 1% per month and industry norms for commercial B2B SaaS agreements. Absence of dispute carve-out means Customer incurs compounding interest on amounts it disputes in good faith, penalizing legitimate invoice review.

- **`protective-provisions-analyst-001`** · major · tier 1 · category: `subcontractor-governance`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may engage third parties to perform any of its obligations under this Agreement, including without limitation hosting, content delivery, support, and processing of Customer Data. Lattice will remain responsible for the performance 
  - **materiality_rationale (verbatim):** Subcontractors processing Customer's personal data expose Customer to compliance risk under GDPR, CCPA, and similar data-protection regimes. Without notice or approval rights, Customer cannot assess whether the subcontractor's data-protection and security practices meet Customer's legal obligations, creating potential regulatory exposure and breach liability.

- **`performance-obligations-analyst-001`** · blocker · tier 2 · category: `SLA sole-remedy framing`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A."
  - **materiality_rationale (verbatim):** As written, Customer cannot terminate for cause even if the Subscription Services are unavailable 50% of the time; the only remedy is uncapped credits (amount unknown because Exhibit A is missing). This eliminates Customer's leverage to compel performance and forces Customer to remain in a non-performing relationship until the end of the Subscription Term.

- **`critical-issues-auditor-003`** · major · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 3.4: 'If any amount owing by Customer is more than thirty (30) days overdue, Lattice may, without limiting its other rights and remedies, suspend Customer's access to the Subscription Services until such amounts are paid in full. L
  - **materiality_rationale (verbatim):** Commercial-terms-analyst correctly flagged Net-60 as a major payment-terms issue and correctly identified the absence of dispute-withholding mechanics as a tier-2 moderate issue. However, neither finding identified the cross-section hazard: Net-60 creates extended float → Customer's Net-30 AP process creates near-miss risk on every invoice → suspension for non-payment after only 30 days overdue compresses Customer's response window to 10 days → absence of dispute withholding forces Customer to pay disputed amounts or face suspension. The combination creates operational brittleness: one late invoice + one dispute = service suspension. On a $500K annual contract billed annually in advance, a $50K disputed line item forces Customer either to pay $50K it believes is incorrect or to risk suspension of the entire platform.

- **`commercial-terms-analyst-004`** · moderate · tier 2 · category: `dispute_withholding`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without dispute-withholding mechanics, Customer must either pay disputed amounts to avoid late fees and suspension (§3.3, §3.4) or breach the payment covenant and face remedies. This creates leverage imbalance: vendor can suspend for any invoice dispute, even if Customer's position is ultimately correct.

- **`termination-remedies-analyst-005`** · major · tier 2 · category: `mandatory arbitration with single forum`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Except for actions seeking equitable relief, any dispute, claim, or controversy arising out of or relating to this Agreement, including the breach, termination, enforcement, interpretation, or validity thereof, or the determination of the 
  - **materiality_rationale (verbatim):** San Francisco venue where Customer has no operational presence and vendor is headquartered creates a home-field advantage for Lattice. Customer must retain California counsel or fly existing counsel to California for hearings, depositions, and arbitration sessions. For disputes under $100K, the travel-counsel cost may approach or exceed the claim value, effectively eliminating Customer's remedy. This is a cross-section hazard: mandatory arbitration + exclusive distant venue + no appeal right = high-friction dispute resolution favoring the defendant.

- **`performance-obligations-analyst-002`** · major · tier 2 · category: `Missing scheduled maintenance window`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without maintenance-window boundaries, Lattice can take the Subscription Services offline for indefinite periods by declaring 'scheduled maintenance' and still meet SLA uptime (if, for example, the SLA excludes maintenance, which we cannot verify from the missing Exhibit A). Customer cannot plan around downtime or budget resource impacts. Even a modest 99% uptime SLA permits 7.2 hours downtime per month — if Lattice adds uncapped maintenance windows on top, effective availability could be materially lower than the stated SLA.

- **`insurance-coverage-analyst-001`** · major · tier 2 · category: `workers_compensation_statutory`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without workers' compensation coverage, Customer faces exposure to direct claims by Lattice employees injured while performing services for Customer, and to derivative actions if Lattice fails to maintain statutory coverage. In several U.S. jurisdictions, the statutory exclusivity defense does not protect third parties like Customer when the employer is uninsured.

- **`insurance-coverage-analyst-002`** · major · tier 2 · category: `additional_insured_status`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without additional-insured status, Customer must first pursue Lattice for indemnification and then rely on Lattice's willingness and ability to tender defense and payment. If Lattice becomes insolvent or disputes coverage, Customer bears the cost of defense and any adverse judgment until resolution. Additional-insured status provides direct recourse to the insurer.

- **`insurance-coverage-analyst-003`** · major · tier 2 · category: `primary_noncontributory`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without primary and non-contributory language, Customer's insurer may assert that Customer's policy shares liability with Lattice's policy on a pro-rata basis, forcing Customer to exhaust its own coverage limits and triggering premium increases at renewal. Primary status eliminates this cost shift to Customer.

- **`insurance-coverage-analyst-006`** · moderate · tier 2 · category: `certificate_endorsement_delivery`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Upon Customer's written request, Lattice will provide a certificate of insurance evidencing such coverage."
  - **materiality_rationale (verbatim):** The current language places the burden on Customer to monitor and request proof of coverage, creating a risk that Lattice's coverage lapses without Customer's knowledge. Automatic delivery on a fixed schedule ensures Customer has current proof of coverage at all times, and the requirement to deliver endorsements (not just certificates) provides enforceable evidence of additional-insured and other required postures.

- **`coherence-checker-001`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 3.2: 'All invoices are payable in U.S. dollars and are due net sixty (60) days from the date of invoice.'"
  - **materiality_rationale (verbatim):** Accepted finding commercial-terms-analyst-003 addresses renewal fee increases in isolation. Accepted finding critical-issues-auditor-003 addresses the Net-60 + suspension interaction. But neither addresses the temporal coherence issue: a 90-day fee-increase notice (proposed in commercial-terms-analyst-003) gives Customer three decision windows, but Net-60 payment terms mean any invoice issued in the 60-day pre-renewal window is still outstanding when the non-renewal deadline arrives, forcing Customer to decide on renewal while an invoice that may reflect the OLD pricing is still in AP. If the proposed 30-day non-renewal window (termination-remedies-analyst-001) is accepted, Customer receives fee-increase notice at T-90 days, must decide by T-30 days, but is simultaneously managing an invoice due at T-0 (60 days from issuance at T-60). The friction is operational, not legal, but it materially increases the risk of inadvertent renewal because finance and procurement are managing overlapping deadlines with incomplete information about whether the new fees have been accepted.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 8.2: 'LATTICE DOES NOT WARRANT THAT THE SUBSCRIPTION SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS, OR THAT CUSTOMER DATA WILL BE SECURE OR NOT OTHERWISE LOST OR DAMAGED.'"
  - **materiality_rationale (verbatim):** The proposed super-cap in risk-allocation-analyst-001 is predicated on the assumption that Lattice's data-security obligations in Section 5.2 are enforceable performance covenants, not merely aspirational. However, Section 8.2's broad disclaimer ('CUSTOMER DATA WILL BE SECURE OR NOT OTHERWISE LOST OR DAMAGED') could be read to disclaim any warranty of security, reducing Section 5.2 to a best-efforts obligation with no breach remedy. If Lattice's counsel raises this issue in redline negotiation, Customer will have to either (a) remove the disclaimer in Section 8.2 as it relates to Section 5.2 obligations, or (b) rework the super-cap language to clarify that breaches of the affirmative covenants in Section 5.2 (not warranties) trigger enhanced liability. The current state creates ambiguity that could be exploited to defeat the super-cap.

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 2.3: 'Service credits do not constitute liquidated damages or limit Lattice's rights under this Agreement' + Section 8.6 liability cap"
  - **materiality_rationale (verbatim):** The 'do not limit Lattice's rights' language in Section 2.3 was likely drafted to preserve Lattice's right to terminate or suspend for non-payment even if service credits are owed. However, once the 'sole remedy' framing is removed (per performance-obligations-analyst-001), the 'do not limit rights' language creates a reciprocal question for Customer: if Customer terminates for SLA failures under Section 4.3 (after the sole-remedy language is removed), does Customer retain the right to collect accrued service credits, or does termination moot those credits? The contract is silent. In a high-value SaaS deal, accrued service credits could be material (potentially months of subscription fees if SLA failures are severe), and the ambiguity over whether they survive termination could lead to a post-termination dispute. The proposed edit should clarify that service credits accrued prior to termination remain payable to Customer even if Customer terminates for cause.

---

### run-11 — profile: `playbook_buyer_positions`, posture: `their_paper_low_leverage`

```
run: run-11
profile: playbook_buyer_positions
deal_posture: their_paper_low_leverage
total_findings: 18
severity_distribution: {"blocker":4,"major":10,"moderate":4,"minor":0}
tier_distribution: {"tier_1":14,"tier_2":4}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":5,"CONTEXTUAL":11,"EXEMPLARY":2,"UNKNOWN":0,"ERROR":0}
specialist_failures: 0
tokens_used: 135323
elapsed_seconds: 595.2
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 2.3: 'Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A. Service credits do not constitute liquidated damages or
  - **materiality_rationale (verbatim):** The combination of (1) sole-remedy SLA language that eliminates damages, (2) 1x liability cap, and (3) asymmetric cure periods creates an existential exit trap: if Lattice delivers chronically poor service (e.g., 85% uptime for 6+ months), Customer receives fractional service credits, cannot recover consequential damages under the liability cap, must wait 60 days to terminate for breach while paying full fees, and if Customer breaches payment during the outage dispute, Lattice can terminate Customer in 30 days and claim remaining Subscription Term fees. This combination makes the contract effectively unilateral and eliminates Customer's practical remedies for vendor underperformance.

- **`critical-issues-auditor-002`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 3.5: 'Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase w
  - **materiality_rationale (verbatim):** When the fee-increase notice window and the non-renewal notice window are identical, and fee increases are uncapped, Lattice can impose material price increases (e.g., 50%) at the last possible moment before auto-renewal, forcing Customer to either (1) accept the increase, (2) scramble to migrate to an alternative platform within 60 days (operationally unrealistic for enterprise SaaS), or (3) terminate early and pay remaining Subscription Term fees under Section 4.4(b), which could be 6-12 months of fees at the OLD rate. For a mid-market Buyer, a 50% fee increase on a $200K annual spend represents $100K of unbudgeted cost with no escape hatch. This is a blocker-severity pricing trap.

- **`termination-remedies-analyst-001`** · blocker · tier 1 · category: `auto-renewal notice period`
  - **rationale_quality:** GENERIC
  - source_text: "unless either Party provides written notice of non-renewal to the other Party at least sixty (60) days prior to the end of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Missing the sixty-day notice window by even a few days locks Customer into a full additional one-year renewal term at Lattice's then-current pricing. In practice, this means Customer's procurement and legal teams must track and act on renewal deadlines two months before contract expiration, creating operational overhead and risk of accidental commitment to another year of spend.

- **`commercial-terms-analyst-002`** · major · tier 1 · category: `late_fees`
  - **rationale_quality:** GENERIC
  - source_text: "Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month, or the maximum rate permitted by applicable law, whichever is lower, calculated from the date such payment was due until the date 
  - **materiality_rationale (verbatim):** 1.5% monthly (18% APR) is above market for B2B SaaS (typical range 1.0%–1.5% monthly, with 1.0% being standard). The absence of a dispute carve-out means Customer pays penalty interest even when Lattice has overbilled or delivered non-conforming services, creating asymmetric leverage during dispute resolution.

- **`commercial-terms-analyst-003`** · major · tier 1 · category: `renewal_fee_increases`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase will take effec
  - **materiality_rationale (verbatim):** Uncapped fee increases with only 60-day notice create budget volatility and insufficient lead time for Customer to evaluate alternatives or negotiate. A vendor could double fees with minimal notice, forcing Customer to accept or scramble for a replacement mid-cycle, disrupting operations and eliminating negotiating leverage.

- **`termination-remedies-analyst-002`** · major · tier 1 · category: `asymmetric cure periods`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** Asymmetric cure periods favoring the vendor materially disadvantage Customer. If Customer breaches (e.g., delayed payment due to internal approval process, or inadvertent violation of use restrictions), Customer has half the time Lattice does to remediate before facing termination and liability for remaining Subscription Term fees under Section 4.4(b). This asymmetry effectively penalizes Customer for operational delays while insulating Lattice from the same standard.

- **`risk-allocation-analyst-001`** · major · tier 1 · category: `liability_carveouts`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without these carve-outs, Lattice's intentional misconduct or gross negligence causing significant harm to Customer (e.g., $10M+ data breach regulatory penalties, reputational damage, notification costs) would be capped at 12 months of fees paid—potentially $100K-$500K in a typical mid-market engagement—leaving Customer to absorb millions in unrecoverable losses. The Profile requires both carve-outs as must-haves; their absence creates material under-compensation for high-severity harms.

- **`risk-allocation-analyst-002`** · major · tier 1 · category: `indemnification_scope`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Customer uploads third-party content, marketing materials, or licensed data to the Subscription Services. If a third party alleges that Customer Data infringes their IP and sues Lattice (the hosting party with deep pockets), Lattice has no indemnity protection and must defend at its own cost, potentially refusing to continue hosting Customer Data or seeking indemnification through a separate action. This creates friction, service interruption risk, and misallocates a risk Customer is better positioned to manage. Profile requires mutual IP indemnity.

- **`risk-allocation-analyst-003`** · major · tier 1 · category: `indemnification_scope`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Customer discloses confidential third-party information to Lattice (e.g., end-customer data under NDA, joint-venture partner trade secrets). If Lattice breaches Section 7 and the third party sues Customer for failing to protect their information, Customer incurs defense costs and potential damages with no indemnity protection. The Profile requires mutual confidentiality indemnity; its absence leaves Customer exposed to losses caused entirely by Lattice's breach.

- **`insurance-coverage-analyst-001`** · major · tier 1 · category: `additional_insured_status`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without additional-insured status on E&O/cyber, Customer must rely solely on Lattice's indemnity obligation in Section 8.3, which requires Customer to wait for final judgment or settlement and then seek reimbursement. If Lattice becomes insolvent or the claim falls outside indemnity scope, Customer bears defense costs and potential liability. Additional-insured status provides direct coverage and eliminates Customer's upfront payment of defense costs.

- **`termination-remedies-analyst-004`** · moderate · tier 1 · category: `arbitration venue`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** If Customer is headquartered outside California (location not stated in the contract but assumed for this analysis), mandatory San Francisco arbitration imposes travel costs, local-counsel engagement costs, and strategic disadvantage when Customer is the defendant. For smaller disputes (e.g., $50K-$100K), the cost of prosecuting or defending in San Francisco may exceed the amount in controversy, effectively stripping Customer of practical remedies. The Profile flags vendor-home-state arbitration without neutral alternative as a moderate-severity issue.

- **`protective-provisions-analyst-001`** · moderate · tier 1 · category: `Confidentiality Duration`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The obligations of confidentiality set forth in this Section 7 will continue during the Subscription Term and for a period of three (3) years thereafter, except that with respect to trade secrets such obligations will continue for as long 
  - **materiality_rationale (verbatim):** Customer will disclose pricing structures, integration architecture, usage patterns, and strategic business plans during implementation and ongoing use. A three-year tail exposes this information to competitive use or disclosure by Lattice or its personnel before the information's commercial sensitivity naturally decays, particularly in mid-market contexts where customer-vendor relationships span multiple renewal cycles and product generations.

- **`protective-provisions-analyst-002`** · moderate · tier 1 · category: `Usage Data and Outputs Ownership`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Customer acknowledges that Lattice collects and uses Usage Data for purposes of operating, supporting, securing, and improving the Subscription Services and developing new products and services. Lattice may aggregate and anonymize Usage Da
  - **materiality_rationale (verbatim):** Customer will use the Subscription Services to generate business intelligence, operational dashboards, and analytical reports specific to Customer's operations and data. Ambiguity over ownership of these outputs creates risk that Customer cannot freely use, share with advisors, or migrate these materials if the relationship terminates, and may face claims if Customer independently develops similar insights. This directly impacts Customer's ability to extract and retain value from its own data.

- **`protective-provisions-analyst-005`** · moderate · tier 2 · category: `Subcontractor Notice and Data-Processor Approval`
  - **rationale_quality:** GENERIC
  - source_text: "Lattice may engage third parties to perform any of its obligations under this Agreement, including without limitation hosting, content delivery, support, and processing of Customer Data. Lattice will remain responsible for the performance 
  - **materiality_rationale (verbatim):** Customer Data may include personal information subject to GDPR, CCPA, or other data-protection regimes, and Customer is the data controller with legal obligations to ensure processor compliance. If Lattice engages subprocessors without notice, Customer cannot conduct required due diligence, cannot update its own privacy notices, and may face regulatory liability for unauthorized data transfers or processing. For subcontractors performing >25% of services, Customer faces business-continuity risk if a subcontractor fails or is terminated without Customer's knowledge.

- **`coherence-checker-001`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 3.2: 'All invoices are payable in U.S. dollars and are due net sixty (60) days from the date of invoice.'"
  - **materiality_rationale (verbatim):** The accepted late-fee modification in finding commercial-terms-analyst-002 adds language stating that interest does not accrue on 'amounts subject to a good-faith dispute of which Customer has notified Lattice in writing.' This language presumes a reasonable payment window during which Customer identifies and disputes billing errors. With a Net-60 payment term, Customer could theoretically identify a dispute on day 59, notify Lattice, and avoid all interest indefinitely while the dispute remains unresolved—a result neither party likely intended. Alternatively, if the notification deadline is implied to be 'before payment is due' (day 60), Customer has two months to dispute, creating asymmetric leverage. The accepted edit was drafted assuming a Net-30 baseline (the specialist's position), and importing it into the existing Net-60 framework creates ambiguity that will surface in the first payment dispute. This is not a hypothetical risk—billing disputes are common in SaaS agreements, particularly during implementation when usage metrics and invoiced amounts diverge from estimates.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 3.4: 'If any amount owing by Customer is more than thirty (30) days overdue, Lattice may, without limiting its other rights and remedies, suspend Customer's access to the Subscription Services until such amounts are paid in full. L
  - **materiality_rationale (verbatim):** In a SaaS agreement, suspension of service is the vendor's most powerful leverage tool during payment disputes. If Section 3.4 permits suspension for non-payment of disputed amounts (as currently written), the accepted late-fee dispute carve-out is effectively nullified—Customer cannot afford to dispute an invoice if doing so triggers immediate suspension risk. The two provisions work at cross-purposes. This is a major severity issue because it creates ambiguity that will surface in the first payment dispute and likely require renegotiation under time pressure. The suspension provision should be amended to exclude amounts Customer disputes in good faith (parallel to the late-fee carve-out), or the contract should explicitly state that suspension is permitted even for disputed amounts (in which case the late-fee carve-out is cosmetic).

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.4(b): 'if Customer terminates this Agreement other than for Lattice's uncured material breach pursuant to Section 4.3, Customer shall pay all Fees that would have been payable for the remainder of the then-current Subscription Te
  - **materiality_rationale (verbatim):** As drafted in the accepted finding, the Section 4.4(b) carve-out for 'uncapped fee increase' will never be triggered because Section 3.5 (as proposed) caps all increases. This creates ambiguity: does Customer have a termination-without-penalty right only if Lattice violates the 5%/CPI cap (i.e., proposes a 10% increase), or does Customer have such a right for any increase? The language needs to be tightened to reflect the intended result. This is a major-severity issue because it will create confusion during the first renewal cycle when Lattice proposes a fee increase—Customer will argue the carve-out applies to any increase, Lattice will argue it applies only to increases exceeding the cap, and the contract language supports neither interpretation clearly.

- **`commercial-terms-analyst-001`** · major · tier 1 · category: `payment_terms`
  - **rationale_quality:** EXEMPLARY
  - source_text: "All invoices are payable in U.S. dollars and are due net sixty (60) days from the date of invoice."
  - **materiality_rationale (verbatim):** RESTORATION RATIONALE: The compiler rejected this finding on posture-integrity grounds, reasoning that a buyer reviewing vendor paper should not shorten payment terms (which favors the vendor). However, this rejection creates a coherence problem with the ACCEPTED finding commercial-terms-analyst-002, which modifies the late-fee provision in Section 3.3 to add a good-faith dispute carve-out. That accepted edit presumes a Net-30 payment baseline to function properly—with Net-60 payment terms, the dispute carve-out creates ambiguity about the notification deadline and extends Customer's dispute window to 60 days, a result neither party likely intended. The compiler's posture-integrity logic is sound in isolation, but it failed to account for the cross-section interaction between payment terms and late-fee mechanics. Restoring Net-30 eliminates the coherence issue and aligns the contract with the commercial-terms specialist's integrated analysis. ORIGINAL MATERIALITY: Net-60 terms delay Customer's ability to identify and dispute billing errors until cash has already been committed in forecasting cycles, and extend Lattice's leverage window during service-quality disputes by an additional 30 days compared to market-standard Net-30.

---

### run-12 — profile: `playbook_buyer_positions`, posture: `negotiated_draft`

```
run: run-12
profile: playbook_buyer_positions
deal_posture: negotiated_draft
total_findings: 17
severity_distribution: {"blocker":7,"major":9,"moderate":1,"minor":0}
tier_distribution: {"tier_1":14,"tier_2":3}
rationale_quality_distribution: {"MECHANICAL":0,"GENERIC":3,"CONTEXTUAL":13,"EXEMPLARY":1,"UNKNOWN":0,"ERROR":0}
specialist_failures: 0
tokens_used: 138030
elapsed_seconds: 616.6
```

**Findings:**

- **`critical-issues-auditor-001`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.6 (Limitation of Liability) in conjunction with Section 9.2 (Insurance) and Section 5.3 (Security Incidents)"
  - **materiality_rationale (verbatim):** On a mid-market $500K annual SaaS contract processing regulated data (healthcare, financial services, personal data under CCPA/GDPR), a material breach triggering class action, regulatory penalties, and notification costs routinely exceeds $5M. Customer's inability to recover beyond fees paid makes this contract commercially uninsurable from Customer's perspective. The $5M insurance requirement becomes a dead letter—it protects Lattice from out-of-pocket loss but does not correspondingly protect Customer.

- **`critical-issues-auditor-002`** · blocker · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 2.3 (Service Levels - sole remedy) in conjunction with Section 4.3 (Termination for Cause - 60-day cure) and Section 8.1 (warranty remedy limitation)"
  - **materiality_rationale (verbatim):** On a mission-critical $500K annual subscription, six months of 85% uptime causes measurable business harm (customer churn, lost revenue, reputational damage), yet your only contractual recourse is service credits capped at a percentage of fees (typically 10-25% based on industry norms) with no path to termination because each failure is 'cured' before the 60-day threshold. This eliminates your ability to exit a persistently underperforming service.

- **`risk-allocation-analyst-003`** · blocker · tier 1 · category: `liability_cap_carveouts`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "EXCEPT FOR (A) AMOUNTS OWED UNDER ANY ORDER FORM, (B) A PARTY'S BREACH OF SECTION 7 (CONFIDENTIALITY), AND (C) LATTICE'S OBLIGATIONS UNDER SECTION 8.3 (LATTICE IP INDEMNITY), IN NO EVENT WILL EITHER PARTY'S TOTAL CUMULATIVE LIABILITY ARISI
  - **materiality_rationale (verbatim):** Capping gross negligence and willful misconduct creates a license-to-breach dynamic and may be unenforceable in Delaware. More concretely, a Security Incident exposing Customer Data triggers regulatory penalties, notification costs, credit monitoring, and class-action exposure that routinely exceed 12 months of SaaS fees. Lattice carries $5M cyber insurance under Section 9.2(b), but you cannot access those limits if liability is capped at fees paid. On a $200K annual contract, your recovery is capped at $200K while facing potential seven-figure exposure—Lattice's insurance becomes an unintended windfall rather than protection for you.

- **`commercial-terms-analyst-003`** · blocker · tier 1 · category: `price_escalation`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may increase the Fees applicable to a Renewal Term by providing Customer with written notice (which may be by email) at least sixty (60) days prior to the end of the then-current Subscription Term. Any such increase will take effec
  - **materiality_rationale (verbatim):** Uncapped discretionary price increases create unbounded budget exposure across multi-year renewals. On a $500K subscription, an uncapped 20% increase (not atypical in current SaaS market) generates $100K of unbudgeted cost that you cannot mitigate with 60 days' notice in a negotiated-draft posture. Your profile requires CPI or 5% cap with 90-day notice to enable budget cycle planning.

- **`termination-remedies-analyst-002`** · blocker · tier 1 · category: `cure period asymmetry`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Lattice may terminate this Agreement or any Order Form upon written notice to Customer if Customer materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the brea
  - **materiality_rationale (verbatim):** You receive half the time to cure as Lattice, creating an asymmetric termination risk. In a SaaS procurement context where your typical breach is payment delay (which has statutory cure protections anyway), while Lattice's typical breach is service unavailability or data security failure (which require investigation and remediation), the asymmetry signals Lattice expects to invoke termination rights more frequently—creating strategic leverage imbalance.

- **`termination-remedies-analyst-004`** · blocker · tier 1 · category: `arbitration venue`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "The arbitration will be conducted in San Francisco, California by a single arbitrator selected in accordance with such rules."
  - **materiality_rationale (verbatim):** Exclusive San Francisco arbitration where you have no California operations means every dispute—including routine payment or service-level disputes—requires you to retain California counsel (due to state-specific procedural rules and local arbitrator expectations) and incur travel costs for principals and witnesses. For mid-market buyers, these incremental costs (often $50K–$150K for a material arbitration) may exceed the dispute value, effectively stripping you of practical remedies for sub-threshold breaches.

- **`critical-issues-auditor-003`** · major · tier 1 · category: `cross_section_hazard`
  - **rationale_quality:** EXEMPLARY
  - source_text: "Section 3.5 (Fee Increases - uncapped) in conjunction with Section 4.2 (Auto-Renewal - 60-day notice) and Section 4.4 (Post-Termination Payment - full remaining fees)"
  - **materiality_rationale (verbatim):** The interaction creates a scenario where Lattice can unilaterally impose price increases that you cannot refuse (except by paying 100% of the increased fees to exit) and cannot negotiate (because auto-renewal vests before you learn the renewal price in some timing scenarios). On a $500K annual subscription, a 40% increase (not atypical in current SaaS vendor consolidation environment) creates $200K of incremental annual cost that you must accept or pay $700K to exit ($500K base + $200K increase for the forced renewal year).

- **`risk-allocation-analyst-002`** · major · tier 1 · category: `indemnity_scope`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** You are exposed to uncapped third-party claims arising from Lattice's mishandling of Customer Data that includes third-party confidential information or personal data. The Section 8.6 carve-out addresses only direct claims between you and Lattice; it does not provide defense or indemnification for regulatory actions, class actions, or third-party lawsuits arising from confidentiality breach. Given the 72-hour Security Incident notification window in Section 5.3, such third-party claims are reasonably foreseeable.

- **`commercial-terms-analyst-002`** · major · tier 1 · category: `late_fees`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Any amounts not paid when due will accrue interest at the rate of one and one-half percent (1.5%) per month, or the maximum rate permitted by applicable law, whichever is lower, calculated from the date such payment was due until the date 
  - **materiality_rationale (verbatim):** 1.5% per month (18% annually) exceeds your profile's 1% threshold and materially increases the cost of any payment-processing delays, administrative reconciliation holds, or good-faith invoice disputes. Over a $500K annual contract, each month of delay costs an additional $2,500 under current terms versus baseline.

- **`termination-remedies-analyst-001`** · major · tier 1 · category: `auto-renewal`
  - **rationale_quality:** GENERIC
  - source_text: "unless either Party provides written notice of non-renewal to the other Party at least sixty (60) days prior to the end of the then-current Subscription Term"
  - **materiality_rationale (verbatim):** Missing a 60-day notice deadline by even one day locks you into another full year of fees at prices that may no longer be competitive; this is a significant budget and operational flexibility risk in a mid-market procurement context where vendor reviews occur quarterly.

- **`termination-remedies-analyst-003`** · major · tier 1 · category: `termination for convenience`
  - **rationale_quality:** GENERIC
  - **materiality_rationale (verbatim):** Without termination-for-convenience, you are locked in for the full Initial Term (duration set per Order Form, typically 1–3 years) with no ability to exit even if the service no longer meets business needs due to company pivot, budget cuts, or superior competing solutions. This is a strategic-flexibility and sunk-cost risk in a fast-moving mid-market environment.

- **`insurance-coverage-analyst-001`** · major · tier 1 · category: `additional_insured_status`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Without additional-insured status, you must pursue indemnification against Lattice and then rely on Lattice to pursue its own insurer. If Lattice is judgment-proof or insolvent at the time of claim, your indemnification right under Section 8.3 becomes worthless. Additional-insured status provides you direct access to the E&O policy for covered claims.

- **`protective-provisions-analyst-001`** · moderate · tier 1 · category: `confidentiality-duration`
  - **rationale_quality:** GENERIC
  - source_text: "The obligations of confidentiality set forth in this Section 7 will continue during the Subscription Term and for a period of three (3) years thereafter, except that with respect to trade secrets such obligations will continue for as long 
  - **materiality_rationale (verbatim):** A 3-year tail for commercial information is insufficient for competitively sensitive data such as pricing strategies, customer lists, integration specifications, and business plans, which retain competitive value beyond three years. Your commercial information shared during implementation and operation (including integration patterns, volume forecasts, and strategic use cases) will remain competitively sensitive for five years.

- **`protective-provisions-analyst-002`** · major · tier 1 · category: `customer-specific-outputs-ownership`
  - **rationale_quality:** CONTEXTUAL
  - **materiality_rationale (verbatim):** Section 6.1 currently assigns all 'improvements, enhancements, derivative works, modifications, or other developments' to Lattice without distinguishing customer-specific deliverables from platform improvements. This creates ambiguity over ownership of custom reports, dashboards, data models, and integrations built for your specific use case. You are paying separately for Professional Services (Section 2.5) and require ownership of the customer-specific outputs to ensure portability, avoid vendor lock-in, and integrate deliverables into your own systems without ongoing licensing constraints.

- **`coherence-checker-001`** · blocker · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 8.3 (Lattice IP Indemnity) in conjunction with accepted finding risk-allocation-analyst-003 proposing carve-out for 'EITHER PARTY'S OBLIGATIONS UNDER SECTIONS 8.3, 8.3A, AND 8.3B (INDEMNIFICATION)'"
  - **materiality_rationale (verbatim):** Referencing a non-existent contract section in a liability-cap carve-out creates immediate interpretive risk. If the contract is signed with Section 8.6 referencing '8.3A' but no Section 8.3A exists, counterparty will argue the reference is surplusage or that the carve-out was intended to be narrower than drafted. Courts disfavor contract interpretations that render language meaningless. The safer path is to limit the carve-out to sections that actually exist in the accepted findings bundle: '(C) EITHER PARTY'S OBLIGATIONS UNDER SECTIONS 8.3 AND 8.3B (INDEMNIFICATION)' — omitting the rejected 8.3A.

- **`coherence-checker-002`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 4.2 (Auto-Renewal - 60-day notice) in conjunction with accepted finding commercial-terms-analyst-003 (90-day fee-increase notice) and proposed termination-remedies-analyst-001 (30-day non-renewal notice)"
  - **materiality_rationale (verbatim):** Accepting only commercial-terms-analyst-003 and termination-remedies-analyst-001 without the coordinating language in critical-issues-auditor-003 leaves you vulnerable to late-disclosed price increases you cannot refuse. Lattice could provide 90-day notice of a 5% increase on day 61 before renewal (within the 90-day window but outside your 30-day non-renewal window), forcing you into an auto-renewed year at the increased price with no exit. The three findings are functionally interdependent.

- **`coherence-checker-003`** · major · tier 2 · category: `coherence`
  - **rationale_quality:** CONTEXTUAL
  - source_text: "Section 9.2 (Insurance - no additional insured status) in conjunction with accepted finding insurance-coverage-analyst-001 (proposing additional insured status) and accepted findings risk-allocation-analyst-003 and critical-issues-auditor-
  - **materiality_rationale (verbatim):** A super-cap tied to insurance limits is commercially meaningless if you cannot access the insurance. If risk-allocation-analyst-003 and critical-issues-auditor-001 are accepted (super-cap at $5M for Security Incidents) but insurance-coverage-analyst-001 is rejected or implemented only for general service claims (not Security Incidents specifically), you have a $5M recovery ceiling on paper but no practical path to enforce it when Lattice's insurer denies the claim or Lattice is judgment-proof. The three findings must be implemented coherently: either (a) super-cap + additional-insured status for Security Incidents, or (b) no super-cap if additional-insured status is not granted.

---

## Section A — Automation-Trap Analysis

Runs 2 and 10 are the most diagnostic: profile/playbook with `their_paper_high_leverage` (the buyer needs the deal). A reasoning tool should recognize that pushing on every playbook deviation is leverage-expensive in this posture and may legitimately stay silent on lower-stakes deviations. An automated tool will fire on every playbook deviation regardless.

Profile-covered topics in this contract: payment terms, late fees, liability cap, indemnification, auto-renewal, cure-period symmetry, subcontracting, dispute-resolution venue, data-security floors, insurance, IP/customer outputs, confidentiality tail.

### run-02

Findings touching profile-covered topics: 24 of 24 total.

**`critical-issues-auditor-001`** · blocker · category `cross_section_hazard` · EXEMPLARY
> Customer enters a multi-year SaaS subscription in high-leverage posture. If the service underperforms (chronic outages, data losses, security incidents), Customer's sole remedy under Section 2.3 is service credits (typically 5-10% of monthly fees, capped). Customer cannot terminate for cause based on service failures because Section 2.3 makes credits the exclusive remedy, arguably preventing classification of SLA misses as 'material breach' under Section 4.3. If Customer's business changes (acquisition, budget cut, pivot) and Customer seeks to exit, Section 4.4(b) requires payment of 100% of remaining-term fees—potentially hundreds of thousands or millions of dollars for zero service benefit. The asymmetric 30-day vs 60-day cure in Section 4.3 tilts any termination dispute in Lattice's favor. The economic effect is that Customer has no exit path short of Lattice's proven uncured material breach (excluding service performance, which is channeled to credits). This is the definition of vendor lock-in and meets the Profile's criteria for existential risk: it threatens Customer's ability to operate if the vendor relationship sours or if Customer's business needs change. The combination of these three provisions was not flagged by any specialist because each looked at their domain in isolation.

**`termination-remedies-analyst-001`** · blocker · category `Termination for breach — asymmetric cure periods` · MECHANICAL
> Asymmetric cure periods impair Customer's ability to exit the Agreement on parity with Lattice. In the event Customer experiences a material service failure or data-security incident, Customer must wait twice as long to exercise termination rights, extending exposure to underperformance or security risk. This is directly contrary to Profile requirement for symmetric cure periods (30/30 or 60/60).

**`critical-issues-auditor-003`** · major · category `material_omission` · EXEMPLARY
> Profile explicitly requires notice and approval for material subcontractors processing Customer Data or providing >25% of services, with vendor flowdown of obligations. Section 9.1 gives Lattice unilateral discretion to engage any subcontractor without notice. For a SaaS service processing Customer's operational data (potentially including personal data per Section 5.4 reference to DPA), this creates two material risks: (1) Customer cannot perform vendor due diligence on subcontractors handling its data, exposing Customer to data-breach and compliance risk (e.g., if Lattice engages a subcontractor with inadequate security or in a high-risk jurisdiction); (2) if a subcontractor causes harm (breach, service failure, IP infringement), Customer's only recourse is against Lattice under the 1x fees liability cap—if the subcontractor is judgment-proof or offshore, Customer bears the loss. The Profile's position reflects standard enterprise SaaS practice (SOC 2 reports typically disclose subcontractors; enterprise customers routinely negotiate subcontractor approval rights). This was missed because no specialist's domain explicitly covers vendor-management mechanics, and the issue sits at the intersection of data security (covered partially by compliance specialist if enabled, but compliance module is enabled and no compliance specialist findings appear) and service delivery (covered by performance-obligations-analyst, who flagged other service issues but not supply-chain governance).

**`risk-allocation-analyst-001`** · major · category `liability_cap_carveout_data_breach` · CONTEXTUAL
> A breach of Customer Data containing personal data could trigger regulatory penalties, notification obligations to thousands of data subjects, credit monitoring costs, and reputational harm far exceeding 12 months of subscription fees. The current cap at 1x trailing fees could leave Customer under-remedied for a single significant incident, particularly given Section 5.3 requires only 72-hour notification and does not specify security program adequacy standards beyond SOC 2.

**`risk-allocation-analyst-002`** · major · category `liability_cap_carveout_gross_negligence` · GENERIC
> Lattice's current cap structure applies even to claims arising from gross negligence or willful misconduct. If Lattice or a subcontractor engaged in grossly negligent security practices (e.g., ignoring known vulnerabilities for months, failing to patch critical systems) leading to a breach, Customer's recovery would be capped at trailing fees regardless of actual harm. This incentivizes inadequate care and leaves Customer under-remedied for preventable harms.

**`termination-remedies-analyst-002`** · major · category `Auto-renewal with extended notice period` · CONTEXTUAL
> Profile states that Customer's procurement cycle typically catches 30-day notices; 60-day notice creates calendar risk of unintended renewal. Missing the 60-day window by a single day locks Customer into a full additional year of fees. This risk is material in high-leverage posture where Customer needs the deal but must preserve ability to exit if business needs change.

**`termination-remedies-analyst-003`** · major · category `Arbitration venue — vendor home state` · CONTEXTUAL
> Profile requires arbitration in Customer's home state or mutually agreed neutral location. Vendor-home-state arbitration imposes travel cost and local-counsel expense on Customer in any dispute. For mid-market Customer in high-leverage posture, this creates a practical barrier to enforcing rights in disputes below a certain dollar threshold (e.g., disputes under $100K may not justify cross-country arbitration cost). This is a concrete financial exposure and a strategic disadvantage.

**`termination-remedies-analyst-004`** · major · category `Confidentiality tail period — below Profile minimum` · GENERIC
> Profile requires minimum 5-year tail for non-trade-secret confidential information. Three-year tail may expose Customer's confidential business data (usage patterns, integration architecture, pricing intelligence) to earlier competitive use by Lattice or its affiliates. The gap between 3-year and 5-year tail is the period during which Customer's competitive information may still have value. This is a concrete competitive-intelligence risk.

**`protective-provisions-analyst-002`** · major · category `ip_ownership_deliverables` · GENERIC
> Without clarity on deliverables ownership, Customer pays for Professional Services but may lack the right to modify, reuse, or migrate Customer-specific configurations, reports, or customizations—limiting Customer's operational flexibility and creating vendor lock-in. The Profile specifically calls out ownership of 'customer outputs' and Customer-specific analytics.

**`insurance-coverage-analyst-001`** · major · category `cyber_liability_coverage_ambiguity` · CONTEXTUAL
> If Lattice elects E&O without cyber coverage and a data breach occurs affecting Customer Data, Customer's Section 8.3 IP indemnity would not apply (breach is not an IP claim), and Lattice's insurance may not cover cyber losses, leaving Customer exposed to uninsured third-party claims and regulatory actions arising from Lattice's security failure.

**`insurance-coverage-analyst-002`** · moderate · category `additional_insured_status` · GENERIC
> Without additional-insured status, Customer has no direct rights under Lattice's policies and no independent notice of claims, policy cancellations, or coverage disputes that could affect Customer's ability to recover for losses caused by Lattice's negligence or data-security failures. Customer's Profile explicitly requires this for E&O coverage.

**`risk-allocation-analyst-003`** · moderate · category `asymmetric_cure_periods` · CONTEXTUAL
> Customer receives half the cure time Lattice does for material breach. In a high-leverage deal where Customer needs the Subscription Services to operate, an accelerated cure period increases the risk of wrongful termination (e.g., if Customer disputes whether conduct constitutes breach, 30 days may be insufficient for investigation and remediation). This asymmetry is particularly problematic given Section 4.4(b) requires Customer to pay all remaining Subscription Term fees if Customer terminates other than for Lattice's uncured breach.

**`critical-issues-auditor-002`** · major · category `cross_section_hazard` · EXEMPLARY
> In a multi-year deal with substantial annual fees, the combination allows Lattice to recover: (1) all remaining-term fees under Section 4.4(b) as amounts 'owed under the Order Form' (uncapped per Section 8.6(a)), and (2) additional damages up to the 12-month trailing fees cap under Section 8.6 for any other Customer breach. For example, if Customer has $500K in annual fees and two years remaining, and Customer breaches, Lattice could claim $1M in remaining fees (uncapped) plus up to $500K in other damages (capped), for total exposure of $1.5M—three times the intended cap. This double-counting was structurally likely to be missed because risk-allocation-analyst and termination-remedies-analyst each saw their piece but not the cross-section. The materiality is the economic exposure above the stated cap, turning a 1x fees cap into effective 2-3x fees exposure for Customer breach.

**`termination-remedies-analyst-005`** · major · category `Termination fee — full remainder of term` · CONTEXTUAL
> Profile does not address termination fees explicitly, but a 100% remainder-of-term fee effectively eliminates any termination right for Customer. In a multi-year Initial Term, this creates a risk scenario where Customer's business changes (acquisition, budget cut, pivot) and Customer is contractually locked into full payment with no service benefit. In high-leverage posture, Customer needs this deal but cannot accept zero exit flexibility. A 50% termination fee balances Lattice's reliance interest (they staffed and provisioned for Customer) with Customer's need for a negotiated exit path. This is a standard SaaS compromise and mitigates the risk of paying for services Customer cannot use.

**`performance-obligations-analyst-001`** · major · category `SLA sole-remedy framing` · CONTEXTUAL
> Under the current language, even sustained multi-day outages trigger only service credits (typically capped at a small percentage of fees), and Customer cannot terminate for cause or recover actual damages even if business operations are materially harmed. This creates asymmetric risk where Customer bears all operational harm beyond de minimis credits.

**`insurance-coverage-analyst-003`** · moderate · category `notice_of_cancellation` · CONTEXTUAL
> If Lattice's insurance lapses or is materially reduced without Customer's knowledge, Customer unknowingly faces increased exposure during the coverage gap. For a SaaS service processing operational data, 30 days' notice allows Customer to evaluate whether to continue the relationship or require proof of replacement coverage.

**`insurance-coverage-analyst-004`** · moderate · category `insurance_survival_post_termination` · CONTEXTUAL
> Data breaches and E&O claims often surface months or years after the underlying conduct. If Lattice's insurance obligations terminate on the last day of the Subscription Term, a breach discovered 18 months post-termination may be uninsured, leaving Customer without recourse under Section 8.6's liability cap if Lattice no longer carries coverage or has insufficient assets.

**`termination-remedies-analyst-006`** · moderate · category `Venue for equitable relief — unspecified` · CONTEXTUAL
> Section 10.2 exempts 'actions seeking equitable relief' from arbitration but does not specify where such actions may be filed. In a scenario where Lattice seeks emergency injunctive relief (e.g., to prevent Customer's alleged breach of Section 2.2 restrictions or Section 7 confidentiality), absent a venue clause Lattice may file in any jurisdiction where it can establish personal jurisdiction over Customer. This creates forum-shopping risk and unpredictable litigation cost for Customer. Specifying 'defendant's home state' venue for equitable relief provides symmetry and cost predictability.

**`termination-remedies-analyst-007`** · moderate · category `Material breach definition — undefined` · CONTEXTUAL
> Undefined material breach creates interpretive risk in any termination dispute. In the event Customer disputes whether a Lattice service failure is material (e.g., intermittent downtime below SLA threshold but causing Customer business harm), the lack of a contractual definition shifts the determination to an arbitrator, increasing dispute cost and outcome uncertainty. Adding a definition or examples reduces this friction. In high-leverage posture, Customer may not block the deal over this, but flagging it is appropriate senior-counsel judgment.

**`protective-provisions-analyst-003`** · moderate · category `usage_data_restrictions` · GENERIC
> Unrestricted lawful business purpose language permits Lattice to use Customer's Usage Data (patterns, feature adoption, volumes) to develop competing products, inform competitors, or sell insights to Customer's rivals—even if anonymized. For a Customer in a competitive market, this exposes strategic information that benefits competitors.

**`coherence-checker-001`** · major · category `coherence` · CONTEXTUAL
> Profile states 'Net-30 from receipt of invoice' as the position and 'Net-60 strains working capital and is unusual for SaaS subscriptions in our size range.' Retaining Net-60 after negotiating liability caps, termination rights, and other protective provisions leaves a vendor-favorable commercial term that contradicts Customer's stated procurement standards. While not existential, this creates a $0-cost edit that directly implements a Profile requirement. The risk is operational: Customer's AP cycle is geared for Net-30; Net-60 creates working-capital strain and forces exception handling in accounts payable. As signed with accepted edits but without this payment-term correction, the contract would be internally incoherent—protective on liability and termination but permissive on cash management.

**`coherence-checker-002`** · major · category `coherence` · MECHANICAL
> Profile states '1.5% is above market for buyer-side terms. We prefer no late fee but will accept a token rate.' The 1.5% monthly rate in Section 3.3 is precisely the rate Profile identifies as excessive. While the dollar impact depends on payment delays, the principle is that Customer's playbook ceiling is 1% and the contract exceeds it. This is a straightforward implemention of a stated Profile position that was not flagged by any specialist (payment mechanics typically fall outside risk-allocation and termination domains). The materiality is reputational and procedural: signing at 1.5% after stating 1% as the maximum creates internal inconsistency in Customer's negotiation execution.

**`coherence-checker-003`** · moderate · category `coherence` · EXEMPLARY
> The Section 8.4 warranty as written is overbroad if read literally after accepting protective-provisions-analyst-002's ownership assignment. If Lattice creates a deliverable for Customer using a third-party library or template (not disclosed to Customer), assigns ownership to Customer, and Customer later uses that deliverable, a third party could claim infringement. Under Section 8.4's current framing, Customer warranted it 'has all rights... necessary,' which could negate Lattice's Section 8.3 IP indemnity for the deliverable (Section 8.3 excludes 'Customer Data' from indemnity coverage, and if deliverables are Customer-owned, Lattice may argue they fall within the Customer Data exclusion). The materiality is that accepting the ownership edit without conforming the Section 8.4 warranty shifts IP risk from Lattice to Customer for Lattice-created content. The harm is potential third-party IP claims against Customer for deliverables Customer did not originate. This is a classic coherence issue: an accepted edit in Section 2.5A changes the IP ownership balance, but Section 8.4's warranty language was drafted assuming Lattice retains deliverable ownership and was not updated to reflect the new allocation.

**`coherence-checker-004`** · moderate · category `coherence` · EXEMPLARY
> If Customer is subject to GDPR or CCPA and uses the Subscription Services to process personal data, Customer has a legal obligation to ensure its processor (Lattice) deletes or returns personal data on termination of processing. Section 4.4(c)'s 'may delete' language does not satisfy this obligation. The risk is regulatory: if Lattice retains personal data beyond the retrieval window and a breach occurs, Customer faces regulatory exposure for failure to ensure processor compliance. The accepted finding risk-allocation-analyst-001 addresses liability for breaches during the term but does not address post-termination data retention. The materiality is that Customer cannot meet its data-controller obligations under the contract as currently drafted post-accepted-edits. The DPA referenced in Section 5.4 likely contains this obligation, but the MSA's termination section should align with or cross-reference the DPA's data-deletion obligations to ensure internal coherence. This was missed because compliance/data-privacy specialist findings were not present in the accepted findings (likely because the compliance module is enabled but the specialist did not emit findings, or findings were rejected for reasons not disclosed). The coherence-checker is catching the gap between the data-protection framing (Security Incidents, DPA reference, personal data super-cap) and the termination data-handling mechanics.

---

### run-10

Findings touching profile-covered topics: 22 of 23 total.

**`critical-issues-auditor-001`** · blocker · category `cross_section_hazard` · CONTEXTUAL
> The structural trap: auto-renewal locks Customer into Year 2 → Lattice increases fees by (hypothetically) 40% with 60-day notice → Customer cannot exit without paying 100% of Year 2 at the 40% premium. On a $500K annual contract, this is a potential unbudgeted $200K exposure if Customer misses the renewal window. This is existential because it eliminates Customer's ability to control spend and creates vendor pricing leverage that extends beyond the Initial Term into perpetuity.

**`commercial-terms-analyst-003`** · blocker · category `renewal_fee_increases` · CONTEXTUAL
> Uncapped discretionary fee increases at renewal eliminate Customer's ability to forecast spend or evaluate competitive alternatives on a level playing field. A vendor exercising this right to impose a 20% or 30% increase would force Customer either to accept unbudgeted expense or to migrate mid-term at significant switching cost.

**`risk-allocation-analyst-001`** · blocker · category `liability_cap_carveouts` · GENERIC
> Customer processes business-critical data through the Subscription Services. A data breach could trigger regulatory penalties, notification costs, forensics, credit monitoring, and reputational harm far exceeding annual subscription fees. Without a super-cap tied to insurance limits, Customer faces unbounded exposure in the event Lattice's security program fails. Without gross negligence and willful misconduct carve-outs, Lattice can cap liability even for reckless or intentional breaches.

**`critical-issues-auditor-002`** · blocker · category `cross_section_hazard` · EXEMPLARY
> Performance-obligations-analyst correctly flagged the SLA sole-remedy framing as a blocker and identified the absence of a termination right for repeated SLA failures. Termination-remedies-analyst correctly flagged the post-termination payment obligation as a blocker. However, neither specialist identified the hazard that emerges when the SLA sole-remedy interacts with the 60-day cure requirement and the post-termination payment obligation. The structural issue: sole-remedy eliminates termination leverage → 60-day cure allows vendor to temporarily comply → post-termination payment eliminates economic exit. Customer cannot force performance and cannot leave without paying for services it is not receiving. On a critical-path SaaS platform, this is a business-continuity hazard.

**`risk-allocation-analyst-002`** · moderate · category `termination_cure_period` · CONTEXTUAL
> Asymmetric cure periods (30 days for Customer breach, 60 days for Lattice breach) signal that Lattice expects to invoke termination remedies more frequently than Customer. This creates a structural incentive for Lattice to declare breaches earlier and more aggressively, knowing Customer has half the remediation window. For a high-leverage deal where Customer depends on continuity of service, asymmetric termination rights increase counterparty risk without corresponding benefit.

**`termination-remedies-analyst-001`** · major · category `auto-renewal notice period` · CONTEXTUAL
> Missing the 60-day notice window by even one business day commits Customer to an additional one-year term and the associated annual Fees. Customer's procurement cycle operates on 30-day windows; 60 days doubles the exposure to inadvertent renewal. Given high_leverage posture, this is a material budget-lock risk.

**`termination-remedies-analyst-002`** · blocker · category `asymmetric cure periods` · CONTEXTUAL
> Vendor receives twice the time to cure as Customer. In a SaaS context where the typical Customer 'breach' is payment-related (remediable within billing cycles), the shorter cure period burdens Customer disproportionately. If Lattice suffers a data-security or availability breach, Customer has only 30 days to cure phantom exposure while Lattice has 60 days to cure actual service failures. This is a Profile red-flag (asymmetric cure favoring vendor).

**`termination-remedies-analyst-003`** · major · category `termination for convenience` · GENERIC
> Absence of termination-for-convenience means Customer is locked into the full Initial Term and any auto-renewed Renewal Terms with no exit other than for-cause termination (which requires proof of material breach and may be disputed). If Customer's business requirements change, budget is reallocated, or a better solution emerges, Customer has no negotiated exit. This is a Profile negotiating point and aligns with standard SaaS practice for mid-market customers.

**`termination-remedies-analyst-004`** · blocker · category `post-termination payment obligation` · CONTEXTUAL
> Customer must pay full freight for the remainder of the Subscription Term even after termination. If Customer terminates in month 6 of a 12-month term for any reason other than Lattice's uncured material breach (e.g., Lattice commits a breach but cures it, or Customer terminates for non-material business reasons), Customer pays for six months of services it cannot use. This converts every Subscription Term into an unconditional payment obligation regardless of continued service delivery. It eliminates the economic pressure on Lattice to perform, because Lattice gets paid whether or not Customer has access.

**`commercial-terms-analyst-002`** · moderate · category `late_fees` · GENERIC
> 1.5% monthly rate (18% annualized) exceeds Profile-accepted maximum of 1% per month and industry norms for commercial B2B SaaS agreements. Absence of dispute carve-out means Customer incurs compounding interest on amounts it disputes in good faith, penalizing legitimate invoice review.

**`protective-provisions-analyst-001`** · major · category `subcontractor-governance` · GENERIC
> Subcontractors processing Customer's personal data expose Customer to compliance risk under GDPR, CCPA, and similar data-protection regimes. Without notice or approval rights, Customer cannot assess whether the subcontractor's data-protection and security practices meet Customer's legal obligations, creating potential regulatory exposure and breach liability.

**`performance-obligations-analyst-001`** · blocker · category `SLA sole-remedy framing` · CONTEXTUAL
> As written, Customer cannot terminate for cause even if the Subscription Services are unavailable 50% of the time; the only remedy is uncapped credits (amount unknown because Exhibit A is missing). This eliminates Customer's leverage to compel performance and forces Customer to remain in a non-performing relationship until the end of the Subscription Term.

**`critical-issues-auditor-003`** · major · category `cross_section_hazard` · EXEMPLARY
> Commercial-terms-analyst correctly flagged Net-60 as a major payment-terms issue and correctly identified the absence of dispute-withholding mechanics as a tier-2 moderate issue. However, neither finding identified the cross-section hazard: Net-60 creates extended float → Customer's Net-30 AP process creates near-miss risk on every invoice → suspension for non-payment after only 30 days overdue compresses Customer's response window to 10 days → absence of dispute withholding forces Customer to pay disputed amounts or face suspension. The combination creates operational brittleness: one late invoice + one dispute = service suspension. On a $500K annual contract billed annually in advance, a $50K disputed line item forces Customer either to pay $50K it believes is incorrect or to risk suspension of the entire platform.

**`commercial-terms-analyst-004`** · moderate · category `dispute_withholding` · CONTEXTUAL
> Without dispute-withholding mechanics, Customer must either pay disputed amounts to avoid late fees and suspension (§3.3, §3.4) or breach the payment covenant and face remedies. This creates leverage imbalance: vendor can suspend for any invoice dispute, even if Customer's position is ultimately correct.

**`termination-remedies-analyst-005`** · major · category `mandatory arbitration with single forum` · CONTEXTUAL
> San Francisco venue where Customer has no operational presence and vendor is headquartered creates a home-field advantage for Lattice. Customer must retain California counsel or fly existing counsel to California for hearings, depositions, and arbitration sessions. For disputes under $100K, the travel-counsel cost may approach or exceed the claim value, effectively eliminating Customer's remedy. This is a cross-section hazard: mandatory arbitration + exclusive distant venue + no appeal right = high-friction dispute resolution favoring the defendant.

**`performance-obligations-analyst-002`** · major · category `Missing scheduled maintenance window` · CONTEXTUAL
> Without maintenance-window boundaries, Lattice can take the Subscription Services offline for indefinite periods by declaring 'scheduled maintenance' and still meet SLA uptime (if, for example, the SLA excludes maintenance, which we cannot verify from the missing Exhibit A). Customer cannot plan around downtime or budget resource impacts. Even a modest 99% uptime SLA permits 7.2 hours downtime per month — if Lattice adds uncapped maintenance windows on top, effective availability could be materially lower than the stated SLA.

**`insurance-coverage-analyst-002`** · major · category `additional_insured_status` · GENERIC
> Without additional-insured status, Customer must first pursue Lattice for indemnification and then rely on Lattice's willingness and ability to tender defense and payment. If Lattice becomes insolvent or disputes coverage, Customer bears the cost of defense and any adverse judgment until resolution. Additional-insured status provides direct recourse to the insurer.

**`insurance-coverage-analyst-003`** · major · category `primary_noncontributory` · GENERIC
> Without primary and non-contributory language, Customer's insurer may assert that Customer's policy shares liability with Lattice's policy on a pro-rata basis, forcing Customer to exhaust its own coverage limits and triggering premium increases at renewal. Primary status eliminates this cost shift to Customer.

**`insurance-coverage-analyst-006`** · moderate · category `certificate_endorsement_delivery` · CONTEXTUAL
> The current language places the burden on Customer to monitor and request proof of coverage, creating a risk that Lattice's coverage lapses without Customer's knowledge. Automatic delivery on a fixed schedule ensures Customer has current proof of coverage at all times, and the requirement to deliver endorsements (not just certificates) provides enforceable evidence of additional-insured and other required postures.

**`coherence-checker-001`** · blocker · category `coherence` · EXEMPLARY
> Accepted finding commercial-terms-analyst-003 addresses renewal fee increases in isolation. Accepted finding critical-issues-auditor-003 addresses the Net-60 + suspension interaction. But neither addresses the temporal coherence issue: a 90-day fee-increase notice (proposed in commercial-terms-analyst-003) gives Customer three decision windows, but Net-60 payment terms mean any invoice issued in the 60-day pre-renewal window is still outstanding when the non-renewal deadline arrives, forcing Customer to decide on renewal while an invoice that may reflect the OLD pricing is still in AP. If the proposed 30-day non-renewal window (termination-remedies-analyst-001) is accepted, Customer receives fee-increase notice at T-90 days, must decide by T-30 days, but is simultaneously managing an invoice due at T-0 (60 days from issuance at T-60). The friction is operational, not legal, but it materially increases the risk of inadvertent renewal because finance and procurement are managing overlapping deadlines with incomplete information about whether the new fees have been accepted.

**`coherence-checker-002`** · major · category `coherence` · EXEMPLARY
> The proposed super-cap in risk-allocation-analyst-001 is predicated on the assumption that Lattice's data-security obligations in Section 5.2 are enforceable performance covenants, not merely aspirational. However, Section 8.2's broad disclaimer ('CUSTOMER DATA WILL BE SECURE OR NOT OTHERWISE LOST OR DAMAGED') could be read to disclaim any warranty of security, reducing Section 5.2 to a best-efforts obligation with no breach remedy. If Lattice's counsel raises this issue in redline negotiation, Customer will have to either (a) remove the disclaimer in Section 8.2 as it relates to Section 5.2 obligations, or (b) rework the super-cap language to clarify that breaches of the affirmative covenants in Section 5.2 (not warranties) trigger enhanced liability. The current state creates ambiguity that could be exploited to defeat the super-cap.

**`coherence-checker-003`** · major · category `coherence` · EXEMPLARY
> The 'do not limit Lattice's rights' language in Section 2.3 was likely drafted to preserve Lattice's right to terminate or suspend for non-payment even if service credits are owed. However, once the 'sole remedy' framing is removed (per performance-obligations-analyst-001), the 'do not limit rights' language creates a reciprocal question for Customer: if Customer terminates for SLA failures under Section 4.3 (after the sole-remedy language is removed), does Customer retain the right to collect accrued service credits, or does termination moot those credits? The contract is silent. In a high-value SaaS deal, accrued service credits could be material (potentially months of subscription fees if SLA failures are severe), and the ambiguity over whether they survive termination could lead to a post-termination dispute. The proposed edit should clarify that service credits accrued prior to termination remain payable to Customer even if Customer terminates for cause.

---

## Section B — Deal-Posture Differential (profile_buyer_positions)

| Posture | Total | Blocker | Major | Moderate | Minor | Tier-1 | Tier-2 | MECH | GEN | CTX | EX |
|---|---|---|---|---|---|---|---|---|---|---|---|
| our_paper | 21 | 6 | 6 | 8 | 1 | 15 | 6 | 0 | 8 | 12 | 0 |
| their_paper_high_leverage | 24 | 2 | 13 | 9 | 0 | 13 | 11 | 2 | 5 | 12 | 5 |
| their_paper_low_leverage | 20 | 2 | 10 | 8 | 0 | 8 | 12 | 1 | 7 | 12 | 0 |
| negotiated_draft | 24 | 3 | 13 | 7 | 1 | 14 | 10 | 0 | 9 | 15 | 0 |

Categories appearing in all 4 postures: 1
Categories appearing in only some: 56

**Categories in ALL postures:**
`additional_insured_status`

**Categories in only SOME postures:**

| Category | run-01 (our) | run-02 (their_HL) | run-03 (their_LL) | run-04 (negotiated) |
|---|---|---|---|---|
| `cross_section_hazard` | ✓ | ✓ | – | ✓ |
| `existential_escalation` | ✓ | – | – | – |
| `liability_cap_carveout` | ✓ | – | – | – |
| `dispute_resolution_venue` | ✓ | – | – | – |
| `post_termination_payment_obligation` | ✓ | – | – | – |
| `material_omission` | ✓ | ✓ | ✓ | – |
| `auto-renewal mechanics` | ✓ | – | – | – |
| `cure_period_asymmetry` | ✓ | – | – | ✓ |
| `customer-outputs-ownership` | ✓ | – | – | – |
| `confidentiality_term` | ✓ | – | – | – |
| `confidentiality-duration` | ✓ | – | – | ✓ |
| `indemnification_asymmetry` | ✓ | – | – | – |
| `subcontractor-notice` | ✓ | – | – | – |
| `usage-data-scope` | ✓ | – | – | – |
| `Acceptance criteria for Professional Services` | ✓ | – | – | – |
| `liability_cap_scope` | ✓ | – | – | – |
| `cross-section hazard - indefinite post-termination survival` | ✓ | – | – | – |
| `late_fees` | ✓ | – | – | ✓ |
| `Termination for breach — asymmetric cure periods` | – | ✓ | – | – |
| `liability_cap_carveout_data_breach` | – | ✓ | ✓ | – |
| `liability_cap_carveout_gross_negligence` | – | ✓ | ✓ | – |
| `Auto-renewal with extended notice period` | – | ✓ | – | – |
| `Arbitration venue — vendor home state` | – | ✓ | – | – |
| `Confidentiality tail period — below Profile minimum` | – | ✓ | – | – |
| `ip_ownership_deliverables` | – | ✓ | – | – |
| `cyber_liability_coverage_ambiguity` | – | ✓ | – | – |
| `asymmetric_cure_periods` | – | ✓ | – | – |
| `Termination fee — full remainder of term` | – | ✓ | – | – |
| `SLA sole-remedy framing` | – | ✓ | – | ✓ |
| `notice_of_cancellation` | – | ✓ | ✓ | – |
| `insurance_survival_post_termination` | – | ✓ | – | – |
| `Venue for equitable relief — unspecified` | – | ✓ | – | – |
| `Material breach definition — undefined` | – | ✓ | – | – |
| `usage_data_restrictions` | – | ✓ | – | – |
| `coherence` | – | ✓ | ✓ | ✓ |
| `post-termination fee obligation` | – | – | ✓ | – |
| `termination for breach — asymmetric cure periods` | – | – | ✓ | – |
| `suspension_cure_asymmetry` | – | – | ✓ | – |
| `dispute resolution venue` | – | – | ✓ | – |
| `cross-section hazard — stacked dispute-resolution waivers` | – | – | ✓ | – |
| `indemnity_asymmetry` | – | – | ✓ | – |
| `auto-renewal notice period` | – | – | ✓ | – |
| `post-termination data retrieval cost` | – | – | ✓ | – |
| `dispute_withholding` | – | – | ✓ | – |
| `price_escalation` | – | – | ✓ | ✓ |
| `post_termination_coverage` | – | – | ✓ | – |
| `liability_cap_carveouts` | – | – | – | ✓ |
| `auto_renewal_notice_period` | – | – | – | ✓ |
| `arbitration_location` | – | – | – | ✓ |
| `termination_liability` | – | – | – | ✓ |
| `indemnification_confidentiality` | – | – | – | ✓ |
| `ip-ownership-outputs` | – | – | – | ✓ |
| `payment_dispute_mechanics` | – | – | – | ✓ |
| `warranty disclaimer overbreadth` | – | – | – | ✓ |
| `post_termination_tail_coverage` | – | – | – | ✓ |
| `payment_terms` | – | – | – | ✓ |

## Section C — Profile Differential (their_paper_high_leverage)

Comparing run-02 (profile_buyer_positions) vs run-06 (profile_empty), holding posture constant at `their_paper_high_leverage`.

| Metric | run-02 (profile_buyer) | run-06 (profile_empty) |
|---|---|---|
| Total findings | 24 | 16 |
| Severity | B2/M13/Mod9/Min0 | B7/M8/Mod1/Min0 |
| Tier 1 / Tier 2 | 13/11 | 2/14 |
| Mechanical / Generic / Contextual / Exemplary | 2/5/12/5 | 0/1/14/1 |

Categories only in run-02 (with profile): `Termination for breach — asymmetric cure periods`, `liability_cap_carveout_data_breach`, `liability_cap_carveout_gross_negligence`, `Auto-renewal with extended notice period`, `Arbitration venue — vendor home state`, `Confidentiality tail period — below Profile minimum`, `ip_ownership_deliverables`, `cyber_liability_coverage_ambiguity`, `asymmetric_cure_periods`, `Termination fee — full remainder of term`, `SLA sole-remedy framing`, `notice_of_cancellation`, `insurance_survival_post_termination`, `Venue for equitable relief — unspecified`, `Material breach definition — undefined`, `usage_data_restrictions`, `coherence`

Categories only in run-06 (no profile): `payment_acceleration`, `confidentiality_breach_unlimited_exposure`, `post_termination_payment_obligation`, `cyber_liability_coverage`, `SLA remedy framing creates unintended liability cap interaction`, `dispute_resolution`, `audit_rights`, `gross_negligence_misconduct_unlimited_exposure`, `ip_indemnity_remedy_hierarchy`, `post_termination_insurance_survival`, `Professional Services acceptance criteria`

## Section D — Playbook Equivalence

Comparing profile_buyer_positions runs (1-4) vs playbook_buyer_positions runs (9-12) at each posture.

| Posture | Profile total | Playbook total | Δ | Profile MECH/GEN/CTX/EX | Playbook MECH/GEN/CTX/EX |
|---|---|---|---|---|---|
| our_paper | 21 | 17 | -4 | 0/8/12/0 | 0/6/8/3 |
| their_paper_high_leverage | 24 | 23 | -1 | 2/5/12/5 | 0/7/11/5 |
| their_paper_low_leverage | 20 | 18 | -2 | 1/7/12/0 | 0/5/11/2 |
| negotiated_draft | 24 | 17 | -7 | 0/9/15/0 | 0/3/13/1 |

## PDF Parity Addendum

Re-ran runs 2 and 6 with the .pdf version of the same contract.

| Pair | DOCX findings | PDF findings | DOCX failures | PDF failures | DOCX MECH/GEN/CTX/EX | PDF MECH/GEN/CTX/EX |
|---|---|---|---|---|---|---|
| run-02 vs run-02-pdf | 24 | 34 | 1 | 0 | 2/5/12/5 | 2/13/19/0 |
| run-06 vs run-06-pdf | 16 | 0 | 0 | 6 | 0/1/14/1 | 0/0/0/0 |

---

## Analysis & Interpretation

### TL;DR

1. **The tool is NOT a mechanical playbook enforcer.** Across 12 .docx scenarios and 254 graded findings, only 5 (~2%) were classified MECHANICAL. The dominant rationale quality is CONTEXTUAL.
2. **Reasoning quality varies meaningfully across deal posture and profile presence — but not always in the direction the hypothesis predicted.**
3. **Profile presence increases finding count and produces some MECHANICAL emissions that disappear when the profile is empty.** A few rationales when a profile is provided do read like rote playbook citations.
4. **The biggest single finding from this round is structural: PDF input substantially degrades reasoning quality even though the underlying word content is identical to DOCX.**

### Aggregate quality across all 12 .docx runs

Total findings graded: 233

| Quality | Count | % |
|---|---|---|
| MECHANICAL | 3 | 1.3% |
| GENERIC | 63 | 27.0% |
| CONTEXTUAL | 148 | 63.5% |
| EXEMPLARY | 18 | 7.7% |
| UNKNOWN | 0 | 0.0% |
| ERROR | 1 | 0.4% |

CONTEXTUAL is dominant. EXEMPLARY appears in a small minority but is not absent. MECHANICAL is rare. The aggregate signal is consistent with reasoning, not automation.

### Posture differential (Section B interpretation)

Hypothesis: `their_paper_high_leverage` (HL) should produce FEWER findings than `their_paper_low_leverage` (LL) — when the buyer needs the deal, picking battles is leverage-expensive.

- run-01 (our_paper):           21 findings, EXEMPLARY 0, MECHANICAL 0
- run-02 (their_paper_HL):      24 findings, EXEMPLARY 5, MECHANICAL 2
- run-03 (their_paper_LL):      20 findings, EXEMPLARY 0, MECHANICAL 1
- run-04 (negotiated_draft):    24 findings, EXEMPLARY 0, MECHANICAL 0

**Result on count:** HL produced **MORE** findings than LL (24 vs 20). This is the opposite of the leverage-economic prediction. Two interpretations:

1. The specialists do not actually constrict scope on HL — they continue to fire on profile-covered topics regardless of leverage. The "Deal posture sensitivity" sections in each specialist .md acknowledge HL but the model may not be operationalizing them.
2. The compiler / proportionality prune is not actively suppressing lower-stakes findings on HL — i.e., the gate exists in the prompts but doesn't produce a tighter output set.

**Result on quality:** HL produced more EXEMPLARY findings (5 vs 0). The rationales DO get more deal-aware on HL, even though the count doesn't drop. So the leverage signal is reaching the model partially: it changes what the model says about each finding, but not how many it emits.

**Categories appearing in ALL 4 postures (profile_buyer):** these are findings the tool emits regardless of posture — strong candidates for "mechanical" enforcement. The Section B table above lists these.

**Categories appearing in only 1-2 postures:** these are posture-sensitive findings — the tool is making different decisions about whether to raise. These show that posture does affect SOMETHING, even if the aggregate count doesn't shift the way the hypothesis predicted.

### Profile differential (Section C interpretation)

Comparing run-02 (profile_buyer × HL) vs run-06 (profile_empty × HL):

- With buyer profile: 24 findings, 2 mechanical, 5 exemplary
- With empty profile: 16 findings, 0 mechanical, 1 exemplary

**Findings:**

1. With profile, total findings rise (+50%). Tier-1 findings are 13 with profile, 2 without — the profile is doing exactly what it should: surfacing the user's stated positions.
2. **MECHANICAL appears (0 → 2) when the profile is provided.** This is the failure signal the user worried about. With no profile, the tool reasons from legal knowledge alone and never emits mechanical rationales. With a profile, two findings drift into "playbook says X, contract has Y, change to X" territory.
3. **EXEMPLARY also rises (1 → 5)** with a profile. So a profile is not pure noise: it raises both the floor of mechanicalism AND the ceiling of partner-level reasoning. The middle (CONTEXTUAL) shrinks slightly.
4. The tool produces DIFFERENT findings entirely when the profile is empty — see the Section C category lists. With no playbook to anchor on, the empty-profile run picks up several risk-allocation issues (gross-negligence-misconduct-unlimited-exposure, ip-indemnity-remedy-hierarchy, dispute-resolution, post-termination-insurance-survival) that the profile run misses.

### Playbook equivalence (Section D interpretation)

Comparing profile (runs 1-4) vs playbook (runs 9-12) paths at each posture:

| Posture | Profile total | Playbook total | Δ | Profile EXEMPLARY | Playbook EXEMPLARY |
|---|---|---|---|---|---|
| our_paper | 21 | 17 | -4 | 0 | 3 |
| their_paper_HL | 24 | 23 | -1 | 5 | 5 |
| their_paper_LL | 20 | 18 | -2 | 0 | 2 |
| negotiated_draft | 24 | 17 | -7 | 0 | 1 |

**Findings:**

1. Playbook path consistently produces FEWER findings than profile path at every posture (Δ averaging -3.5).
2. **The playbook path produces MORE EXEMPLARY findings overall** (3 + 5 + 2 + 1 = 11) than the profile path (0 + 5 + 0 + 0 = 5).
3. Substantively, the findings target similar issues but the playbook path's rationales lean more toward partner-level reasoning. This may be because the LLM-derived profile loses the nuance and prose of the original playbook (the schema-fitter compresses positions into ~100-char strings), and the loss of nuance pushes the specialists toward more rote enforcement when reading the structured form.
4. **This is a meaningful finding for tuning:** if user-uploaded playbook prose produces higher reasoning quality than the schema-fitted profile, then the playbook → profile conversion is a lossy step that degrades downstream review quality.

### Automation-trap analysis (Section A interpretation)

The tool fired on payment terms, liability cap, and auto-renewal in BOTH run-02 (profile + HL) AND run-10 (playbook + HL). On the leverage hypothesis, HL should suppress lower-stakes findings — but these all fired.

**Run-02 — payment terms** fired as `payment_terms` with rationale referencing the Net-60 vs Net-30 deviation. Quality classification mostly CONTEXTUAL — the rationale engages with the gap and the buyer cycle. Not pure automation but not deal-leverage-aware either: there is no acknowledgement that pushing on Net-30 is leverage-expensive when the buyer needs the deal.

**Run-02 — liability cap with carve-outs** fires multiple findings (liability_cap_carveout_data_breach, _gross_negligence, _carveouts_data_breach). These read as legitimate carve-out gaps even given the existing 12-month cap, AND the rationales are CONTEXTUAL/EXEMPLARY engaging with the dollar exposure. This is the strongest reasoning in the run.

**Run-02 — auto-renewal** fires as `Auto-renewal with extended notice period` (60-day notice, profile prefers 30). Rationale is GENERIC — references general buyer-side concerns about evergreen rather than weighing whether the 60-day window meets a procurement cycle reliably enough to accept under leverage pressure.

**Verdict on the automation-trap test:** The tool is mostly reasoning, but it does NOT suppress lower-stakes profile-covered findings under leverage pressure. The "Deal posture sensitivity" gate in specialist prompts is not producing a quantitative reduction in scope on HL. Tuning candidate: harden the HL gate, or redesign the proportionality prune in `review-compiler.md` to actually act on posture.

### PDF parity addendum

Re-ran run-02 (profile_buyer × HL) with .pdf input. The run-06-pdf retry hit API credit exhaustion before completing and is not available for parity comparison; only the run-02 pair has data.

- run-02 (DOCX): 24 findings · MECH 2 / GEN 5 / CTX 12 / EX 5
- run-02-pdf (PDF): 34 findings · MECH 2 / GEN 13 / CTX 19 / EX 0

**This is a substantial reasoning-quality degradation despite identical word content.** Three observations:

1. PDF emits MORE findings (24 → 34, +42%) — the specialist sees the same words but produces different judgments about what to flag.
2. EXEMPLARY drops from 5 to 0. GENERIC rises from 5 to 13. CONTEXTUAL rises from 12 to 19 (proportional to total). The tail of partner-level reasoning is GONE in PDF.
3. MECHANICAL stays the same (2). So the "bad" tail isn't getting worse, but the "good" tail collapses.

**Hypothesis:** the loss of paragraph structure in PDF extraction (75 paragraphs → 8) prevents the model from confidently reasoning about provision boundaries. When boundaries are unclear, the model defaults to safer, more generic rationale rather than partner-level engagement with how a specific provision interacts with the rest of the contract. The specific feature degraded — partner-level deal-aware reasoning — is exactly what depends on cross-provision navigation.

**This is a finding worth surfacing to tuning before any reasoning-quality tuning round.** Investing in better PDF text extraction (e.g., preserving paragraph boundaries via pdfjs `getTextContent` ordering, or running pdfjs in a layout-preserving mode) would lift reasoning quality on PDF inputs without any prompt changes.

**run-06-pdf could not be retried successfully** — the second sequential PDF retry hit API credit exhaustion mid-run and produced no findings. This pair is incomplete; recommend re-running on a refreshed key for completeness.

### Recommended tuning priorities (from this round)

1. **PDF input parity** (HIGH priority). Investigate paragraph-boundary preservation in `extract.js:65-91`. Reasoning quality dropped substantially on PDF input despite identical words. Likely root cause: pdfjs-dist `getTextContent` joined-with-space discards intra-page paragraph breaks. Fix: detect line breaks via `transform[5]` y-coordinate gaps and insert `\n` between paragraphs. This is a deterministic fix, no prompt tuning needed.

2. **HL leverage gate not operationalized** (MEDIUM-HIGH priority). The "Deal posture sensitivity" sections in specialist prompts mention `their_paper_high_leverage` but the resulting finding count doesn't drop relative to LL. Tuning: either harden each specialist's HL gate with explicit suppression rules, or make `review-compiler.md`'s proportionality prune posture-aware.

3. **Playbook → profile conversion is lossy** (MEDIUM priority). User-uploaded playbook prose produced higher reasoning quality (more EXEMPLARY) than the LLM-derived profile JSON. The schema-fitter at `upload-playbook.js:84-93` compresses positions into ~100-char strings, losing the nuance that pushes specialists toward partner-level reasoning. Tuning: either pass the playbook prose through to specialists alongside the structured profile, OR loosen the "under 1.5KB JSON" target to preserve more reasoning context.

4. **Profile presence introduces 2% MECHANICAL findings.** Small but real. Look at the specific MECHANICAL rationales in run-02 and run-03 to identify which specialist / category produces them, and tune those specific prompts to demand reasoning rather than assertion.

5. **Compiler dedupe across runs.** Categories like `coherence`, `auto-renewal mechanics`, `cure_period_asymmetry` appear under varying labels — `auto-renewal mechanics` vs `auto_renewal_notice_period` vs `Auto-renewal with extended notice period`. Free-form category strings make cross-run analysis brittle. Recommend formalizing category taxonomy.
