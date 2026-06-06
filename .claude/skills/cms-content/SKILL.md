---
name: cms-content
description: >
  Manage and audit public CMS content (Blog, Case Studies, Services, FAQs, Testimonials)
  for cloudless.gr stored in Notion. Check for AI formatting artifacts (literal dashes),
  missing required fields, unpublished items, and fix content issues.
  Use when auditing public pages, fixing AI-generated content, or publishing drafts.
argument-hint: "[audit | fix-dashes <db> | publish <page-id> | list [blog|cases|services|faqs|testimonials]]"
allowed-tools: >
  notion-fetch,
  notion-query-database-view,
  notion-search,
  notion-update-page,
  notion-get-comments
---

# CMS Content Skill

Manages cloudless.gr public content stored in Notion. All databases are in the
`Themis128/Cloudless` workspace.

## Known database IDs (all verified 2026-06-05)

| Section | DB page ID | View ID | Collection ID |
|---|---|---|---|
| Blog | `87ac6db3-b82e-4df9-844a-42abbc16a578` | `view://b7acdcd0-1012-454e-906b-022c57288057` | `c1c75072-3b39-424a-913f-494160e40568` |
| Case Studies | `7c50dc2a-0305-4f4a-81f8-5b0a251ac4d7` | `view://3055864d-3933-4ecd-a8be-9a88fac1cbbb` | `de8123dd-b8e9-4b79-b878-ece271d59b1b` |
| Testimonials | `157ceb35-d0b4-4661-a6c6-7798f6d87e7b` | `view://f6a855cb-a5f0-40bb-b02a-e2f0b52b0c6b` | `6b41763f-b91d-4a43-913d-fc6cd02083f4` |
| FAQs | `316acfca-94f4-44d3-8c85-7aa765c259a2` | `view://d2e109df-2a8e-4340-b174-0096408d8ca1` | `c8b95f20-9357-4ec5-95ab-1af14ce0684f` |
| Services | `98a4087c-8670-4818-a1dd-e515104c2331` | `view://50f59233-949f-4c4a-8a7e-4f2ce6623795` | `f440363e-054d-45b5-9aa1-c86468fd7927` |

## Step 0 — Argument routing

- `audit` (or empty) → full audit: Steps 1–5 across all databases
- `fix-dashes <db>` → Step 6: scan and fix AI dash formatting in `<db>` (`blog` | `cases` | `services` | `faqs` | `testimonials`)
- `publish <page-id>` → Step 7: set Status = Published on a single page
- `list <db>` → Step 1 for the named database only, print item table

---

## Step 1 — Query each database

For each known DB, call `notion-query-database-view` with the DB ID.
Extract: `Title`, `Status`, `GeneratedBy` (if present), and any required fields per DB.

**Blog required fields:** Title, Status, GeneratedBy, Slug, PublishedAt (Published checkbox)
**Case Studies required fields:** Title, Client, Industry, Results, Summary, Published (checkbox)
**Testimonials required fields:** Name, Role, Company, Quote, Published (checkbox)
**Services required fields:** Name, Description, Icon, Slug, Price, CTA, Published (checkbox)
**FAQs required fields:** Question, Answer, Category, Published (checkbox)

Real schema notes (verified 2026-06-05):
- Case Studies: field is `Client` (not Company); uses `Published` checkbox (not Status select)
- Testimonials: field is `Name` (not Author); uses `Published` checkbox (not Active)
- Services: has `Features` (newline-separated), `Price`, `CTA`, `StripePriceId`
- FAQs: has `Locale` multi-select (en/el/fr/de) — unset items show for all locales

For Services and FAQs where the DB ID is unknown:
```
# Search for the database
notion-search("Services")  →  pick the result matching cloudless.gr public services
notion-search("FAQ")       →  pick the FAQ database for cloudless.gr
```

Cache the found IDs in the conversation for reuse within this skill invocation.

---

## Step 2 — Status summary

For each database, count items by status:

```
Published / Active:   count
Draft / Review:       count  (flag ⚠️ if > 0 and no intention to leave as draft)
Missing required fields: count  (flag ❌)
```

Draft items are not visible on the public site. Confirm with the user before publishing.

---

## Step 3 — Required field check

For each item, verify all required fields (Step 1) are non-empty.

Flag as ❌ if any required field is empty, null, or a placeholder string
(e.g., "TODO", "TBD", "-", "placeholder", or a string under 5 characters).

Output a list per database:
```
Blog:
  ❌ "Draft Post Title" — missing: Slug, PublishedAt
  ✅ "Getting Started with cloudless" — all fields present
```

---

## Step 4 — AI content dash detection

For items where `GeneratedBy = AI` (Blog), or for all items in other databases,
fetch the full page body via `notion-fetch` and scan for dash artifacts.

**Dash artifact pattern:** A rich-text paragraph block (type `paragraph`) whose
plain_text starts with `- ` or `• ` — these are literal dashes inserted by the AI
that should be either:
1. Proper Notion bulleted_list_item blocks (if they are genuinely a list)
2. Rewritten as flowing prose (if they are inline text masquerading as a list)

Also scan **property text fields** (Results, Summary, Answer, Quote, Description)
for the same pattern — these are stored as plain text and often contain `- line 1\n- line 2`.

```python
# Pattern to find in plain text properties
import re
dash_pattern = re.compile(r'(^|\n)[-•]\s+', re.MULTILINE)
```

Report each occurrence:
```
Case Studies / "Cloudless Analytics Launch":
  Field "Results":  "- Reduced query time by 60%\n- Eliminated manual exports"
  → Fix: convert to prose or use notion-update-page to rewrite as plain text
```

---

## Step 5 — Compile audit report

Output the full report:

```
CMS AUDIT: HEALTHY / ATTENTION NEEDED

Blog (N items):
  Published: N ✅  Draft: N ⚠️  AI-generated: N
  Field issues: [none | list]
  Dash artifacts: [none | N items with dashes → run fix-dashes blog]

Case Studies (N items):
  Published: N ✅  Other: N ⚠️
  Field issues: [none | list]
  Dash artifacts: [none | N items]

Testimonials (N items):
  Active: N ✅  Inactive: N
  Field issues: [none | list]
  Dash artifacts: [none | N items]

Services (N items):
  Active: N ✅
  Field issues: [none | list]
  Dash artifacts: [none | N items]

FAQs (N items):
  Published: N ✅  Unpublished: N ⚠️
  Field issues: [none | list]
  Dash artifacts: [none | N items]

Action items:
  ❌ URGENT  — [item] missing required fields → fill manually in Notion
  ⚠️ CONTENT — [N] items have AI dash artifacts → cms-content fix-dashes <db>
  ⚠️ STATUS  — [N] items are drafts → review and publish via cms-content publish <id>
```

---

## Step 6 — fix-dashes `<db>`

Argument: `blog` | `cases` | `services` | `faqs` | `testimonials`

For the specified database:

1. Query all items; fetch full page body for items with AI content (or all items for databases without `GeneratedBy`)
2. For each item where dash artifacts are found:
   a. Fetch current property text via `notion-fetch`
   b. Rewrite the text: convert `- item\n- item` sequences to flowing prose
      - If there are 3+ dashes in a row → rewrite as a comma-separated sentence or keep as proper list bullets
      - If a field has a single `- item` → drop the dash, capitalize the sentence
      - Preserve meaning; do not add new content
   c. Apply the fix via `notion-update-page` on the affected property
   d. Report: `✅ Fixed "Title" — Results field: removed N dashes`

**Rewrite heuristics:**
```
"- Reduced query time by 60%\n- Eliminated manual exports\n- Saved 3h/week"
→ "Reduced query time by 60%, eliminated manual exports, and saved 3 hours per week."

"- Increased revenue"
→ "Increased revenue."

"- React\n- Next.js\n- TypeScript"
→ leave as-is (technology list — better as bullets in Notion block editor)
   → mark for manual review instead of auto-fixing
```

Stop and confirm with the user before writing if the database has > 10 items to fix,
or if the text is ambiguous (short single-word bullet points).

**Dry-run mode:** print all proposed rewrites before applying any. Ask: "Apply N fixes? [y/N]"

---

## Step 7 — publish `<page-id>`

Set the Status property to `Published` (or `Active` for Testimonials/Services) on a single page.

```
notion-update-page:
  page_id: <page-id>
  properties:
    Status: Published   # or Active for non-blog databases
```

Fetch the page first to confirm title and current status before updating.
Print: `✅ Published: "Page Title" (was: Draft)`

---

## Common issues and fixes

| Issue | Database | Fix |
|---|---|---|
| AI dash artifacts in Results | Case Studies | `fix-dashes cases` |
| AI dash artifacts in Answer | FAQs | `fix-dashes faqs` |
| AI dash artifacts in Description | Services | `fix-dashes services` |
| AI dash artifacts in Quote | Testimonials | `fix-dashes testimonials` |
| Post not visible on site | Blog | Check Status = Published + Slug non-empty |
| Broken card on /case-studies | Case Studies | Check Company + Industry + Results non-empty |
| FAQ not showing | FAQs | Check Published = true + Category non-empty |
| Service missing icon | Services | Fill Icon in Notion, re-deploy cloudless.gr |

---

## Notes

- Never delete Notion content — use `Status = Archived` instead
- Always fetch before updating to avoid overwriting concurrent edits
- The `fix-dashes` action rewrites property text fields only — it does not touch Notion block content (page body) which requires a different API path (update-block)
- For body block fixes, print the proposed change and let the user apply it manually in the Notion editor
