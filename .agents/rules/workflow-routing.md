# BakuEstate-AI Workflow Routing & Standards

1. Use EGM (`egm-brainstorm`, `egm-draft`, `egm-review`) for conceptual feature design, requirements gathering, and architectural proposals.
2. Use Superpowers (`writing-plans`, `executing-plans`, `test-driven-development`, `verification-before-completion`) for implementation and verification.
3. Every test suite must pass before committing:
   - Web: `cd web && pnpm test` (or `npm test`)
   - Typecheck: `cd web && npx tsc --noEmit`
4. Always provide verifiable tool output before reporting tasks as completed.
