---
description: Audit all public-facing CMS databases (Blog, Case Studies, Services, FAQs, Testimonials) in Notion for cloudless.gr
---

Snapshot the current state of all cloudless.gr public CMS content in Notion.

Use the Notion MCP tools to query each database. Known database IDs:

| Section | Notion DB ID |
|---|---|
| Blog | `c1c75072-3b39-424a-913f-494160e40568` |
| Case Studies | `de8123dd-b8e9-4b79-b878-ece271d59b1b` |
| Testimonials | `157ceb35-d0b4-4661-a6c6-7798f6d87e7b` |

For Services and FAQs, search first if IDs are unknown:
```
notion-search: "Services"
notion-search: "FAQs"
```

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
- Items with `Status ≠ Published`
- Items missing `Company`, `Industry`, or `Results` (required for the public card)
- Short `Results` values (< 20 chars) → likely a placeholder like "- Increased revenue"

---

## 3. Testimonials

Fetch the Testimonials database or page:

```
notion-fetch:
  url or id: 157ceb35-d0b4-4661-a6c6-7798f6d87e7b
```

If it is a database, query it for: Author, Role, Company, Quote, Active.

Flag:
- Entries with `Active = false` (or missing)
- Quotes that start with `- ` (literal dash from AI generation)
- Missing Author, Role, or Company

---

## 4. Services

Search for the Services database, then query it:

```
notion-search: "Services"  →  find the DB for cloudless.gr public services page
notion-query-database-view: <services_db_id>
  properties: Title, Description, Icon, Status, Order
```

Flag:
- Items not marked Active/Published
- Missing `Description` or `Icon`
- `Description` values starting with `- ` or `• ` (AI dash formatting)

---

## 5. FAQs

Search for the FAQs database, then query it:

```
notion-search: "FAQ"  →  find the FAQ DB
notion-query-database-view: <faq_db_id>
  properties: Question, Answer, Category, Published, Order
```

Flag:
- Items not published
- `Answer` values that start with `- ` or contain a line starting with `- ` (AI formatting)
- Missing `Category`

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
