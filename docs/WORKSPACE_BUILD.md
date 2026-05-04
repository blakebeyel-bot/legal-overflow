# Workspace build — your action checklist

This is your master checklist for adding the chat / library / projects /
tabular reviews / workflows / DOCX redline workspace to Legal Overflow.

**Total of your time across all 6 phases: ~2 hours, spread over weeks.**

Architecture: clean-room re-implementation inspired by the Mike open-source
project. No AGPL code copied — every line written from scratch in our stack
(Astro + Netlify Functions + Edge Functions + Supabase + Fly.io for
LibreOffice).

---

## Phase 0 — Setup (~30 min, one-time)

### 0.1 — Get API keys

You already have Anthropic. Get two more:

**OpenAI**: https://platform.openai.com/api-keys
- Create new secret key, name it `legal-overflow-prod`
- Save the `sk-proj-...` value somewhere — you can't see it again

**Google AI / Gemini**: https://aistudio.google.com/app/apikey
- Create API key in a project called "Legal Overflow"
- Save the `AIza...` value

### 0.2 — Generate BYOK encryption key

In any PowerShell window:
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the 64-char result. This is `BYOK_ENCRYPTION_KEY`.

### 0.3 — Add 3 env vars to Netlify

URL: https://app.netlify.com/projects/resplendent-lollipop-59d4c4/configuration/env

| Key | Value |
|---|---|
| `OPENAI_API_KEY` | `sk-proj-...` |
| `GOOGLE_AI_API_KEY` | `AIza...` |
| `BYOK_ENCRYPTION_KEY` | 64-char hex string |

### 0.4 — Run the SQL migration

After Claude pushes `supabase/migrations/0014_workspace_schema.sql`:

1. Go to https://supabase.com/dashboard → SQL Editor → New query
2. Open the migration file in your file explorer
3. Copy ALL of it, paste, click **Run**
4. Should see "Success. No rows returned"

### 0.5 — Create Storage bucket

1. Supabase → Storage → New bucket
2. Name: `library`
3. Public: **OFF**
4. Create

---

## Phase 1 — Chat tab (~5 min of your time)

When Claude says "Phase 1 ready":
1. `git push origin main`
2. Wait ~3 min for Netlify build
3. Go to `/workspace/`
4. Test:
   - "Workspace" tab in nav → click → land on workspace home
   - New chat → ask "what is force majeure?" → response streams smoothly
   - Switch model toggle (Claude / GPT / Gemini) → confirm each works
   - Refresh page → chat persists
   - Sign out + back in → chat persists
   - In `/account/`, paste your personal Anthropic key → new chat uses it
   - In incognito, sign up new user → confirm `/workspace/` blocked by approval gate

---

## Phase 2 — Document library (~5 min)

1. Push, wait 3 min
2. `/workspace/library/`
3. Test:
   - Upload a PDF → appears in library
   - Click doc → see metadata + "Use in chat" button
   - Start chat from library → doc auto-attached
   - Start a different chat → attach SAME doc from library (no re-upload)
   - Rename, delete — both work

---

## Phase 4 — Tabular reviews (~10 min)

1. Push, wait 3 min
2. Upload 3 NDAs to library
3. `/workspace/reviews/` → New review
4. Pick 3 NDAs, add 4 columns (Term length, Mutual?, Governing law, Liability cap)
5. Run → watch grid populate in 30–90s
6. Each cell has answer + "show source" link with quote + page
7. Sort columns work
8. Export Excel works

---

## Phase 3 — Projects / folders (~5 min)

1. Push, wait 3 min
2. `/workspace/projects/` → New project "Test Matter"
3. Test:
   - Upload doc inside project → scoped (not in global library)
   - Start chat inside project → scoped (not in global chats)
   - Create folder, drag doc into it
   - Global library hides project docs
   - Global chats hides project chats

---

## Phase 5 — Workflows (~10 min)

1. Push, wait 3 min
2. As admin, `/admin/workflows/` → create "FL MSA review checklist"
3. Type: chat workflow, write checklist body, publish to all
4. As user (incognito), `/workspace/workflows/` → workflow appears
5. "Use in chat" → loads checklist → attach MSA → response uses checklist
6. Repeat for tabular workflow type — confirm creates tabular review with preset columns

---

## Phase 6 — DOCX tracked changes (~30-45 min)

### 6.1 — Sign up for Fly.io
- https://fly.io/app/sign-up
- Add credit card (required even for free tier)
- Create org "Legal Overflow"

### 6.2 — Install Fly CLI
PowerShell as admin:
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```
Restart PowerShell, then:
```powershell
fly auth login
fly auth whoami
```

### 6.3 — Deploy LibreOffice service
After Claude writes `libreoffice-service/`:
```powershell
cd C:\Users\blake.beyel\Desktop\Website\libreoffice-service
fly launch    # Claude will tell you what to pick at each prompt
fly deploy    # ~5 min
```
Copy the URL it prints (e.g., `https://legal-overflow-libreoffice.fly.dev`).

### 6.4 — Wire to Netlify
Add 2 env vars in Netlify:
- `LIBREOFFICE_SERVICE_URL` = Fly URL
- `LIBREOFFICE_SERVICE_TOKEN` = random string Claude generates

### 6.5 — Push & test
1. Push main repo
2. In a workspace chat, attach a .docx
3. Type: "Redline this MSA for standard concerns. Apply tracked changes."
4. Wait ~30-60s
5. Click "Download redlined version" → opens in Word with real track changes
6. Verify Accept/Reject works in Word

---

## Time investment summary

| Phase | Your time | Cadence |
|---|---|---|
| 0 | 30 min | Once, upfront |
| 1 | 5 min | After Claude ships chat |
| 2 | 5 min | After Claude ships library |
| 4 | 10 min | After Claude ships tabular reviews |
| 3 | 5 min | After Claude ships projects |
| 5 | 10 min | After Claude ships workflows |
| 6 | 45 min | After Claude ships redlines |
| **Total** | **~2 hours** | |

Claude's time: ~5-7 weeks of focused work, one phase at a time.
