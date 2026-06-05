---
description: Audit all public-facing CMS databases (Blog, Case Studies, Services, FAQs, Testimonials) in Notion for cloudless.gr
---

Snapshot the current state of all cloudless.gr public CMS content in Notion.

Use the Notion MCP tools to query each database. Known database IDs:

| Section | Notion DB page ID |
|---|---|
| Blog | `87ac6db3-b82e-4df9-844a-42abbc16a578` |
| Case Studies | `7c50dc2a-0305-4f4a-81f8-5b0a251ac4d7` |
| Testimonials | `157ceb35-d0b4-4661-a6c6-7798f6d87e7b` |
| FAQs | `316acfca-94f4-44d3-8c85-7aa765c259a2` |
| Services | `98a4087c-8670-4818-a1dd-e515104c2331` |

---

## 1. Blog posts

Query the Blog database — list all pages with Title, Status, GeneratedBy, and PublishedAt:

```
notion-query-database-view:
  database_id: c1c75072-3b39-424a-913f-494160e40568
  filter: none (all items)
  properties: Title, Status, GeneratedBy, PublishedAt, Slug
```

Flag:
- Items with `Status = Draft` or `Status = Review` → not live
- Items with `GeneratedBy = AI` → check content for literal dashes (see below)
- Items missing `Slug` or `PublishedAt` → will break routing

---

## 2. Case Studies

Query the Case Studies database:

```
notion-query-database-view:
  database_id: de8123dd-b8e9-4b79-b878-ece271d59b1b
  properties: Title, Status, Company, Industry, Results
```

Flag:
- Items with `Published ≠ true`
- Items missing `Client`, `Industry`, or `Results` (required for the public card)
- Short `Results` values (< 20 chars) → likely a placeholder like "- Increased revenue"
- `CoverImage` empty (cards may render without image but worth flagging)

---

## 3. Testimonials

Fetch the DB then query its view `view://f6a855cb-a5f0-40bb-b02a-e2f0b52b0c6b`.

Fields: Name, Role, Company, Quote, Rating, Published, Avatar, Featured, Order, Service.

Flag:
- Entries with `Published ≠ true`
- Quotes that start with `- ` (literal dash from AI generation)
- Missing Name, Role, Company, or Quote
- `Avatar` empty (will render initials fallback — flag but not blocking)

---

## 4. Services

Query view `view://50f59233-949f-4c4a-8a7e-4f2ce6623795`.

Fields: Name, Description, Features, Icon, Category, Price, CTA, Slug, Published, Order, StripePriceId.

Flag:
- Items with `Published ≠ true`
- Missing `Description`, `Icon`, or `Slug`
- `Features` text lines starting with `- ` (AI dash formatting) — newline-only separation is OK
- `StripePriceId` empty if the CTA routes to Stripe checkout (not just contact form)

---

## 5. FAQs

Query view `view://d2e109df-2a8e-4340-b174-0096408d8ca1`.

Fields: Question, Answer, Category, Locale, Published, Order.

Flag:
- Items with `Published ≠ true`
- `Answer` values starting with `- ` or containing lines starting with `- ` (AI formatting)
- Missing `Category`
- `Locale` unset — app may default to showing all items or en-only; verify expected behaviour

---

## AI content dash check

For each item where `GeneratedBy = AI` (Blog) or in databases known to have AI content,
fetch the full page body and scan for markdown-style dashes used as bullet points:

Pattern to find: lines starting with `- ` in rich text blocks (paragraph or bulleted_list_item)
where the content type is `paragraph` (not `bulleted_list_item`) — these are literal dashes
that should be either proper Notion bullet blocks or reformatted prose.

---

## Report format

```
PUBLIC PAGES: HEALTHY / ATTENTION NEEDED

Blog (N items):
  Published:  N  ✅
  Draft/Review: N  ⚠️
  AI-generated: N  [content checked ✅ / dashes found ❌]
  Issues: [list or "none"]

Case Studies (N items):
  Published:  N  ✅
  Other:      N  ⚠️
  Issues: [list or "none"]

Testimonials (N items):
  Active:   N  ✅
  Inactive: N
  Issues: [list or "none"]

Services (N items):
  Active: N  ✅
  Issues: [list or "none"]

FAQs (N items):
  Published: N  ✅
  Issues: [list or "none"]

Action items:
  - [database] / [item title]: [issue] → [fix command or manual action]
```

For any AI content dashes found, run the `cms-content` skill with `fix-dashes <database>`.
