## Redline scope

When `markup_type` is `delete` or `replace`, the `source_text` you select must satisfy this rule: when the change is accepted, the surrounding text must be grammatically intact and substantively coherent. Choose between targeted scope and whole-clause scope based on what leaves clean text after accept.

ACCEPTABLE — targeted scope leaves clean text:
  Source: "Customer shall pay all invoices within sixty (60) days"
  Strike: "sixty (60)"
  Replace with: "thirty (30)"
  After accept: "Customer shall pay all invoices within thirty (30) days" ✓ clean

ACCEPTABLE — whole-clause scope when targeted would break grammar:
  Source: "Lattice may, in its sole discretion, modify, update, or improve the Subscription Services from time to time."
  Strike: entire sentence
  Replace with: "Lattice may modify, update, or improve the Subscription Services with thirty (30) days' written notice to Customer."
  After accept: clean replacement ✓

UNACCEPTABLE — partial scope leaves broken grammar:
  Source: "Lattice may, in its sole discretion, modify the Services."
  Strike: "in its sole discretion,"
  After accept: "Lattice may, modify the Services." ✗ orphan comma between subject and verb

Test before emitting: read the contract sentence with your strike removed (and replacement inserted, if any). If the resulting prose has orphan commas, dangling clauses, broken parallelism, or otherwise reads as if a grammar fragment was left behind, expand `source_text` to the smallest unit that yields clean prose. The reverse direction matters too: do not strike more than necessary if a tighter span yields clean text on its own.

## Drafting style
