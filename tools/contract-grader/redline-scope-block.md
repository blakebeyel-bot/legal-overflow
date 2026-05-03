## Redline scope

When `markup_type` is `delete` or `replace`, the `source_text` you select must satisfy this rule: when the change is accepted, the surrounding text must be grammatically intact and substantively coherent.

DEFAULT TO TARGETED SCOPE. The smallest substitution that yields clean grammar after accept is the right answer in nearly every case. Whole-clause scope is for the specific situations where targeted would break grammar OR where multiple connected terms must change together such that piecemeal edits would be incoherent.

ACCEPTABLE — targeted scope (PREFERRED):
  Source:  "Customer shall pay all invoices within sixty (60) days"
  Strike:  "sixty (60)"
  Replace: "thirty (30)"
  After accept: "Customer shall pay all invoices within thirty (30) days" ✓ clean — only the changed term is in the redline

ACCEPTABLE — whole-clause scope (only when targeted would break grammar OR multiple connected terms must change):
  Source:  "Lattice may, in its sole discretion, modify, update, or improve the Subscription Services from time to time."
  Strike:  entire sentence
  Replace: "Lattice may modify, update, or improve the Subscription Services with thirty (30) days' written notice to Customer."
  After accept: clean replacement — the new sentence reorganizes the structure (removes "in its sole discretion", adds notice obligation), so piecemeal edits would not work

UNACCEPTABLE — over-expansion (whole-clause used when targeted would suffice):
  Source:  "either Party provides written notice of non-renewal to the other Party at least sixty (60) days prior to the end of the then-current Subscription Term"
  WRONG:   strike the entire 25-word clause and re-insert it with "thirty (30)" in place of "sixty (60)"
  RIGHT:   strike just "sixty (60)" and replace with "thirty (30)"
  Why: re-inserting 24 unchanged words pollutes the redline with noise; reviewers cannot tell at a glance what actually changed

UNACCEPTABLE — partial scope leaves broken grammar:
  Source:  "Lattice may, in its sole discretion, modify the Services."
  Strike:  "in its sole discretion,"
  After accept: "Lattice may, modify the Services." ✗ orphan comma between subject and verb — should have included the trailing comma or restructured the sentence

Test before emitting: read the contract sentence with your strike removed (and replacement inserted, if any). If the resulting prose has orphan commas, dangling clauses, or broken parallelism, EXPAND `source_text` to capture the broken fragment. If the rewrite would only change a small number of terms and the surrounding language is unchanged, NARROW `source_text` to just those terms — do not include unchanged surrounding words inside the redline.

## Drafting style
