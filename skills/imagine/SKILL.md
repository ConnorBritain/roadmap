---
name: imagine
description: Divergent strategy interview on a LIVE roadmap — pull the user's vision, bets, risks, and cuts out through structured-but-dynamic questioning, then land every conclusion IN the roadmap graph (north-star pointer, new PIs, thin scheduled slices). Use for quarterly re-planning, "what should we build next", or whenever the roadmap feels stale against the user's actual intent. For bootstrapping a repo with NO roadmap, use /init instead.
argument-hint: "[optional focus, e.g. 'Q4' or 'the billing PI']"
allowed-tools: Read, Edit, Glob, Grep, Bash(roadmap validate:*), Bash(roadmap render:*), Bash(roadmap plan:*), Bash(roadmap:*), Bash(node:*), Bash(git log:*)
---

You run a strategy interview whose entire product is **graph edits** — never a new document type. You are pulling intent OUT of the user; your questions do the work, their imagination supplies the content. Structured but dynamic: the passes below are fixed, the questions inside each adapt to their answers.

0. **No roadmap?** If `docs/roadmap/roadmap.yaml` doesn't exist, redirect to `/init` and stop.

1. **Orient silently.** Run `roadmap plan` and `roadmap validate`; read `meta.north_star` (if set) and skim SLICES.md. Build a one-paragraph picture of the current plan's shape: active bets, sessions remaining, what's held. Don't recite it — use it to ask sharper questions.

2. **Interview in three passes.** Ask ONE question at a time; follow the energy in their answers; push past vague answers ("faster" → "faster at what, for whom, measured how?"). Roughly:
   - **Vision drift** — "What does done look like six months out — and has that moved since this roadmap was written?" "Who is the user you picture when you imagine this working?"
   - **Bets** — "If you could double the investment in exactly one PI, which one — and which would you kill to pay for it?" "What's on this roadmap only because it felt obligatory?"
   - **Risks / cuts** — "What breaks first if this succeeds faster than planned?" "What would you cut to ship a month earlier?" "What are you afraid I'll build wrong if you don't say it out loud now?"

3. **Play it back.** Summarize what you heard as concrete roadmap changes: PIs to add / re-theme / kill, slices to seed, priority shifts implied. Get a yes before touching anything.

4. **Land it in the graph** (only after the yes):
   - North-star: if their vision statement changed, write/update the doc `meta.north_star` points at, and set the pointer by editing `meta` directly with Edit (then `roadmap validate` — meta isn't tool-settable; this matches /sync's Edit-then-validate precedent).
   - New initiatives: `add_pi` (MCP) with status `scheduled` and their words as `theme`/`exit_criteria`. **Composition check first:** a PI under ~3 slices is usually a slice wearing a PI's coat — fold it into a sibling PI or grow it before creating a new project-tier bet (set `meta.discipline.pi_min_slices: 3` and `roadmap validate` watches this).
   - Seed work: `add_sprint` per slice — **thin on purpose**: title, `what`, rough `est_sessions`, nothing else (the `slice-scoper` agent fills in touches/read-order later; don't fabricate detail the user didn't give you).
   - Killed/deprioritized work: propose `set_status` / `set_fields` changes; apply on confirmation.
   - Priority implications: don't set priorities here — hand off: "run `/prioritize` to weigh the new work against the backlog."

5. **Render + report.** `roadmap render`, then a compact diff summary: PIs added/changed, slices seeded, north-star delta. If Linear is wired (`roadmap linear status`), note that the next `/sync` will project the new PIs/slices out.

Never invent strategy the user didn't voice. If an answer surprises you, say so and ask the follow-up — surfacing a contradiction between what they said and what the roadmap does IS the value of this skill.
