# BakuEstate-AI — Agent & Engineering Architecture Guide

## 1. Scope & Product Overview

BakuEstate-AI is an autonomous, end-to-end real estate intelligence, video production, and CRM platform designed for the Baku property market:
- **Scraper & Ingestion**: Automated monitoring and scraping of new listings from bina.az and local sources.
- **Multimodal AI Engine**: Property description analysis, marketing angle generation, and script writing using Google Gemini models.
- **Automated Video Factory**: Multimodal voiceover synthesis (Edge-TTS / ElevenLabs) and dynamic reel/video rendering via Remotion and FFmpeg.
- **Cloud CRM & Storage**: Supabase Postgres (tables for listings, render versions, change events, publication logs, and leads) + Supabase Storage for audio/video assets.
- **Web Management Dashboard**: Next.js 16 App Router (`web/`) deployed on Vercel with real-time listing status, video player, WhatsApp direct actions, owner outreach CRM, and AI Cockpit.

Target directory: `C:\Users\HP\BakuEstate-AI`.

---

## 2. Directory Architecture & Boundaries

```
C:\Users\HP\BakuEstate-AI
├── src/                  # Python Core Pipeline
│   ├── scraper/          # Bina.az scrapers and listing parsers
│   ├── pipeline/         # Gemini script generation and orchestrator
│   ├── audio/            # TTS generation and voice selection
│   ├── video/            # FFmpeg & Remotion render adapters
│   └── sync/             # Supabase and Notion synchronization
├── web/                  # Next.js 16 Web Dashboard & CRM
│   ├── app/              # App Router (pages: /, /listings, /listings/[bina_id], /analytics, /leads)
│   ├── components/       # React client & server components (ListingsClient, ListingDetailClient, Cockpit)
│   ├── lib/              # Supabase clients, formatters, type definitions, sorters
│   └── __tests__/        # Vitest test suite for web CRM features
├── supabase/             # Database schemas, migrations, and seed scripts
├── scripts/              # Automation, watchdog recovery, and maintenance scripts
└── docs/                 # Architectural specifications, EGM designs, and changelogs
```

---

## 3. Core Operating Rules & Engineering Discipline

### 3.1 Model & Agent Pinning
- **Primary Model**: Strictly `gemini-3.8-flash-high` per user directive. Do not switch models autonomously.

### 3.2 Evidence Before Assertions (Zero-Glazing)
- Never claim a feature, fix, or tool is "working" or "tested" without executing real verification commands and inspecting output in the same turn.
- Web fixes must be validated with Vitest (`npm test` in `web/`) and/or real browser checks via Chrome DevTools MCP.
- Python changes must be validated with pytest or dry-run scripts.

### 3.3 Skill & Document Reading Integrity
- When opening or activating any `SKILL.md` file, always read the entire file from start to finish without arbitrary truncation (`EndLine` limits).

### 3.4 Git & Deployment Safety
- Preserve working directory cleanliness. Inspect `git status` before and after changes.
- Use atomic, descriptive commits with Conventional Commit format (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Never commit secrets, service role keys, `.env` files, or binary test dumps.
- Deploys to Vercel production must be verified with HTTP status checks or DevTools inspection.

---

## 4. Workflow Routing

Follow this strict separation of workflows:
1. **Ideation, Requirements, & Architecture (EGM)**:
   - Brainstorming & Requirements: `egm-brainstorm`
   - Drafting Design Docs & RFCs: `egm-draft`
   - Reviewing Architecture & Specs: `egm-review` / `egm-review-loop`
   - Drift Detection & Alignment: `egm-drift-report`
2. **Technical Engineering, Coding & Verification (Superpowers)**:
   - Execution Planning: `writing-plans`
   - Code Implementation: `executing-plans`, `subagent-driven-development`
   - Quality & Verification: `test-driven-development`, `systematic-debugging`, `verification-before-completion`
