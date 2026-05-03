"""
Modal deployment of the PyMuPDF contract-markup service.

Deploy:    modal deploy modal_app.py
Endpoint:  printed by deploy. Looks like:
  https://<workspace>--legal-overflow-pdf-markup-apply-markup.modal.run

The Node pipeline (fanout-background.js) POSTs:
  POST /apply
  Content-Type: application/json
  Body: { "pdf_b64": "<base64-encoded PDF bytes>", "findings": [...] }

Response:
  200 OK
  Content-Type: application/json
  Body: { "pdf_b64": "<base64-encoded marked PDF>", "applied": int, "unanchored": [...] }

Auth: a shared bearer token. The Node side sends Authorization: Bearer <SECRET>
and Modal compares it to the secret stored under `MARKUP_SHARED_TOKEN`.
"""
from __future__ import annotations

import base64
import os

import modal

# Image: PyMuPDF for PDF markup + FastAPI for Modal's @fastapi_endpoint.
# fastapi[standard] pulls in starlette, uvicorn, etc. — Modal's web endpoint
# decorator needs them at runtime. As of modal v1, FastAPI is no longer
# auto-included; you must add it explicitly.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("pymupdf==1.27.2", "fastapi[standard]==0.115.6")
    .add_local_python_source("markup")  # bundles markup.py from this dir
)

app = modal.App("legal-overflow-pdf-markup", image=image)

# Shared secret used by the Node side to authenticate. Create with:
#   modal secret create legal-overflow-markup MARKUP_SHARED_TOKEN=<random-256-bit>
markup_secret = modal.Secret.from_name("legal-overflow-markup")


@app.function(
    secrets=[markup_secret],
    timeout=300,           # 5 min — handles even very long contracts
    memory=2048,           # PyMuPDF + a 50-page PDF easily fits
    min_containers=0,      # scale to zero when idle (free tier-friendly)
)
@modal.fastapi_endpoint(method="POST", docs=True)
def apply_markup(req: dict):
    """Apply markup to a PDF. See module docstring for request shape."""
    from fastapi import HTTPException, Header
    import markup

    # Bearer-token auth via the request body — fastapi_endpoint accepts a
    # plain dict; for header-based auth use a separate endpoint signature.
    # Simpler: require a `token` field in the request body matching our secret.
    expected_token = os.environ.get("MARKUP_SHARED_TOKEN")
    if not expected_token:
        raise HTTPException(500, "Server misconfigured: MARKUP_SHARED_TOKEN not set")
    if req.get("token") != expected_token:
        raise HTTPException(401, "Invalid token")

    pdf_b64 = req.get("pdf_b64")
    findings = req.get("findings") or []
    if not pdf_b64:
        raise HTTPException(400, "Missing pdf_b64")

    pdf_bytes = base64.b64decode(pdf_b64)
    author = req.get("author")  # optional; defaults to "Legal Overflow"
    result = markup.apply_pdf_markup(pdf_bytes, findings, author=author)

    return {
        "pdf_b64": base64.b64encode(result["pdf"]).decode("ascii"),
        "applied": result["applied"],
        "unanchored": result["unanchored"],
    }


@app.local_entrypoint()
def smoke_test():
    """Quick local-call test. Run with: modal run modal_app.py"""
    import json
    from pathlib import Path

    findings_path = Path(__file__).parent.parent / "contract-grader" / "runs" / "run-02-pdf.json"
    pdf_path = Path(__file__).parent.parent / "contract-grader" / "test_contracts" / "msa_reasoning_test.pdf"

    findings = json.loads(findings_path.read_text(encoding="utf-8"))
    findings = findings.get("accepted_findings") or findings.get("findings") or []
    pdf_b64 = base64.b64encode(pdf_path.read_bytes()).decode("ascii")

    result = apply_markup.remote({
        "token": os.environ.get("MARKUP_SHARED_TOKEN", ""),
        "pdf_b64": pdf_b64,
        "findings": findings,
    })
    out = Path(__file__).parent / "modal-smoke-output.pdf"
    out.write_bytes(base64.b64decode(result["pdf_b64"]))
    print(f"applied={result['applied']} unanchored={len(result['unanchored'])}, wrote {out}")
