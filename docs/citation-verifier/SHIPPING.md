# Citation Verifier — Shipping Protocol

How to deploy a round of fixes so the user always tests against the latest
build, with a per-round snapshot URL preserved for diagnostic purposes.

## Per-round deploy steps

For each Round N, run the deploy TWICE with two aliases:

```bash
# 1. Snapshot for this round (preserved for diff/regression purposes)
NODE_OPTIONS="--dns-result-order=ipv4first" \
  netlify deploy --dir=dist --functions=netlify/functions --alias=citation-r$N

# 2. Rolling alias the user always tests against
NODE_OPTIONS="--dns-result-order=ipv4first" \
  netlify deploy --dir=dist --functions=netlify/functions --alias=citation-test
```

`--dns-result-order=ipv4first` works around a Node v24 IPv6 DNS issue on
Windows that otherwise causes `getaddrinfo ENOTFOUND api.netlify.com`.

## Round-summary message contract

The summary message MUST always include:

1. **Stable URL** — `https://citation-test--resplendent-lollipop-59d4c4.netlify.app`
   (this is what the user pastes briefs into).
2. **Round snapshot URL** — `https://citation-r$N--resplendent-lollipop-59d4c4.netlify.app`
   (preserved if we need to diff between rounds or roll back).
3. **A line stating "citation-test now mirrors r$N"** so the user is never
   uncertain which build is live on the stable URL.

## Why both URLs

- **citation-test** is the URL the user has bookmarked. If we don't update
  it, the user will paste briefs into a stale build and report bugs that
  are already fixed.
- **citation-rN** preserves a snapshot so if a later round regresses, we
  can compare outputs against the prior round without rebuilding from a
  git tag.

## Production cut

Only after the user explicitly approves the citation-test results:

```bash
NODE_OPTIONS="--dns-result-order=ipv4first" netlify deploy --prod
```

Never ship `--prod` without explicit user approval in chat.

## GitHub push

Direct pushes to `main` are blocked by sandbox policy. Always:

```bash
git checkout -b round-$N-<short-slug>
git push -u origin round-$N-<short-slug>
git checkout main  # leave local tree on main
```

Then report the PR-creation URL in the round summary so the user can
merge via the GitHub UI.
