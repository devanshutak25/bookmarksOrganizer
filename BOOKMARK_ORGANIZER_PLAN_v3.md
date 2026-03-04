# Bookmark Organizer — Implementation Plan v3

## Overview

A self-hosted, Docker-deployable web tool that takes a browser bookmark HTML export, walks the user through reviewing and tagging each bookmark one-by-one, then exports a cleanly reorganized bookmark HTML file with a new folder structure based on user-defined tag-to-folder mappings.

**Target users:** Personal use + friends. Expected bookmark count: <200.

**Stack:** Python (FastAPI) + SQLite + vanilla HTML/CSS/JS frontend. Optional Ollama integration for AI-assisted tag suggestions.

**HTTP client:** A single `httpx.AsyncClient` is created at app startup (`app.state.http_client`) with `timeout=10.0` and `max_redirects=5`, and closed on shutdown. All outbound HTTP (metadata scraping, Ollama calls) uses this shared client for connection pooling. No per-request client instantiation.

**Deploy:** Single Docker container. Docker Compose with optional Ollama service.

**Schema versioning:** No migration framework. If the schema changes between versions, users must reset (drop DB) and re-import. The DB is ephemeral work-in-progress state, not a permanent store — the source of truth is the original bookmark export and the final export.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Browser Tab                       │
│  ┌────────────────────────────┬─────────────────────┐│
│  │                            │   Action Panel      ││
│  │   Bookmark Preview Card    │   - Title edit      ││
│  │        ~60% width          │   - Tag management  ││
│  │                            │   - AI suggestions  ││
│  │   - Favicon + Title        │   - Dead/Skip/Next  ││
│  │   - URL (clickable)        │   - Progress bar    ││
│  │   - Meta description       │                     ││
│  │   - "Open in New Tab ↗"    │                     ││
│  └────────────────────────────┴─────────────────────┘│
└──────────────────────────────────────────────────────┘
          │ fetch API calls
          ▼
┌─────────────────────────┐      ┌──────────────────┐
│   FastAPI Backend        │─────▶│  Ollama (optional)│
│   - Bookmark CRUD        │      │  localhost:11434  │
│   - HTML parser          │      └──────────────────┘
│   - Metadata scraper     │
│   - Export generator     │
│   - SQLite database      │
└─────────────────────────┘
```

**Design decision — no iframe proxy:** Most bookmarked sites (GitHub, Reddit, YouTube, Medium, docs sites, SPAs) break inside iframes even after stripping `X-Frame-Options` and CSP headers. Regex-based frame-busting removal is fragile and incomplete. The proxy would be the most complex component for a feature that fails >50% of the time. Instead, we show a rich preview card with scraped metadata and an "Open in New Tab" link. This eliminates the proxy endpoint, its security surface area, and significant implementation complexity.

---

## Data Model (SQLite)

### Table: `bookmarks`

| Column            | Type    | Notes                                        |
|-------------------|---------|----------------------------------------------|
| id                | INTEGER | PRIMARY KEY AUTOINCREMENT                    |
| url               | TEXT    | UNIQUE, normalized                           |
| original_title    | TEXT    | From the imported HTML                       |
| custom_title      | TEXT    | Nullable — user-edited title                 |
| original_folder   | TEXT    | Original folder path from HTML (for reference only) |
| add_date          | INTEGER | Unix timestamp from original bookmark        |
| favicon           | TEXT    | Favicon URL or data URI from original        |
| status            | TEXT    | One of: `pending`, `tagged`, `dead`, `discarded` |
| ai_suggestions    | TEXT    | JSON array of suggested tag strings, nullable |
| ai_status         | TEXT    | NULL (not attempted), `done`, or `failed`. Prevents infinite retry of failed Ollama calls — set to `failed` on BOTH unreachable Ollama AND garbage/unparseable responses. |
| meta_title        | TEXT    | Scraped `<title>` from the live page         |
| meta_description  | TEXT    | Scraped meta description from the live page  |
| created_at        | TEXT    | ISO timestamp, default CURRENT_TIMESTAMP     |

**Indexes:** `CREATE INDEX idx_bookmarks_status ON bookmarks(status);` — used by `/api/bookmarks/next` and all filtered queries.

### Table: `tags`

| Column | Type    | Notes                     |
|--------|---------|---------------------------|
| id     | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name   | TEXT    | UNIQUE, lowercase trimmed |

### Table: `bookmark_tags`

| Column      | Type    | Notes                                      |
|-------------|---------|---------------------------------------------|
| bookmark_id | INTEGER | FK → bookmarks.id, ON DELETE CASCADE       |
| tag_id      | INTEGER | FK → tags.id, ON DELETE CASCADE            |
| PRIMARY KEY | —       | (bookmark_id, tag_id)                      |

### Table: `folders`

| Column    | Type    | Notes                                     |
|-----------|---------|-------------------------------------------|
| id        | INTEGER | PRIMARY KEY AUTOINCREMENT                 |
| name      | TEXT    | Folder display name                       |
| parent_id | INTEGER | FK → folders.id, nullable (null = root)   |
| sort_order| INTEGER | Position among siblings, default 0. Used to determine "first matching folder" for duplicate handling. |

**Constraints:** `UNIQUE(name, parent_id)` — prevents duplicate folder names under the same parent. SQLite treats multiple NULLs as distinct in UNIQUE constraints, so root-level folder name uniqueness is enforced at the application level: `POST /api/folders` and `PATCH /api/folders/{id}` must query `SELECT 1 FROM folders WHERE name = ? AND parent_id IS NULL` before insert/update when `parent_id` is NULL.

### Table: `folder_tags`

| Column    | Type    | Notes                                |
|-----------|---------|--------------------------------------|
| folder_id | INTEGER | FK → folders.id, ON DELETE CASCADE  |
| tag_id    | INTEGER | FK → tags.id, ON DELETE CASCADE, **UNIQUE** — enforces one-tag-one-folder at the schema level |
| PRIMARY KEY | —     | (folder_id, tag_id)                 |

### Table: `settings`

| Column | Type | Notes |
|--------|------|-------|
| key    | TEXT | PRIMARY KEY |
| value  | TEXT | JSON-encoded value |

Used for storing: `duplicate_handling` — controls which folder wins when a bookmark has tags mapping to multiple folders. Valid values: `"first"` (place in first matching folder by sort_order) or `"duplicate"` (place in all matching folders). Only these two options; per-conflict prompting was considered and rejected as not worth the UX cost for <200 bookmarks.

---

## API Endpoints

### Import

**`POST /api/import`**
- Accepts: multipart file upload (`.html` bookmark file)
- Action:
  1. Parse HTML using BeautifulSoup with `html.parser` (lenient)
  2. Extract all `<A>` tags: `HREF`, `ADD_DATE`, `ICON`, inner text (title)
  3. Determine folder path by walking the parent-map (see Parser section)
  4. Normalize URLs: lowercase scheme+host, strip trailing slashes, strip fragment, sort query params. **Note:** Fragment stripping means `page.html#section-a` and `page.html#section-b` become the same URL. Acceptable tradeoff for <200 bookmarks; avoids near-duplicate clutter.
  5. Deduplicate by normalized URL. Keep the first occurrence. Log duplicates count.
  6. Flatten all folders — store `original_folder` for reference but don't create folder structure
  7. Insert all bookmarks with `status = 'pending'`
- Returns: `{ "imported": 183, "duplicates_removed": 12 }`

### Background Jobs

**Job state tracking:** Each job stores its progress counters on `app.state` (e.g., `app.state.scrape_total`, `app.state.scrape_completed`). These are in-memory only and reset if the server restarts. This is acceptable because: (a) jobs don't survive server restarts anyway (they're `asyncio.Task`s), and (b) the `/api/jobs/status` endpoint can recompute approximate progress from the DB on startup by counting bookmarks with/without metadata.

**`POST /api/jobs/scrape`**
- Triggered after import (or manually)
- **Concurrency model:** Launches a single `asyncio.Task` stored on `app.state.scrape_task`. A second POST while a task is running returns `{ "status": "already_running" }`. Cancellation is coordinated via `app.state.scrape_cancel` (`asyncio.Event`): the worker checks this event between each bookmark and aborts if set. `POST /api/jobs/scrape/cancel` sets the event.
- Uses the shared `app.state.http_client` for all HTTP requests.
- For each bookmark with `status = 'pending'` and `meta_title IS NULL`:
  1. HTTP GET the URL (client already configured with timeout=10s, max_redirects=5)
  2. If response is HTML, parse only the first 50KB of `resp.text` for performance: extract `<title>`, `<meta name="description">`, `<meta property="og:title">`, `<meta property="og:description">`
  3. Store in `meta_title` and `meta_description`
  4. If request fails (timeout, 4xx, 5xx, DNS failure), set `meta_title = "[UNREACHABLE]"` — do NOT auto-mark as dead (user decides)
- Non-blocking — user can start triaging immediately
- Returns: `{ "status": "started", "total": 183 }` immediately

**`POST /api/jobs/scrape?retry_unreachable=true`**
- Re-scrapes bookmarks where `meta_title = '[UNREACHABLE]'`. Resets their `meta_title` to NULL first, then runs the normal scrape loop.

**`POST /api/jobs/ai-suggest`**
- Requires Ollama to be available at configured URL (default `http://localhost:11434`)
- **Concurrency model:** Same pattern as scrape — single `asyncio.Task` on `app.state.ai_task`, guarded against double-start, cancellable via `app.state.ai_cancel` (`asyncio.Event`).
- For each bookmark where `ai_suggestions IS NULL` and `ai_status IS NULL` and `meta_title IS NOT NULL` and `meta_title != '[UNREACHABLE]'`:
  1. Build prompt (see AI Tagging section below)
  2. Call Ollama `/api/generate` endpoint
  3. Parse response, store as JSON array in `ai_suggestions`, set `ai_status = 'done'`
  4. If response is unparseable (garbage), set `ai_status = 'failed'`, leave `ai_suggestions` as NULL
- If Ollama is globally unreachable (connection refused on first attempt), abort the entire job and return `{ "status": "skipped", "reason": "ollama_unavailable" }`
- Returns: `{ "status": "started", "total": 150 }` immediately

**`GET /api/jobs/status`**
- Returns: `{ "scrape": { "total": 183, "completed": 47, "running": true }, "ai_suggest": { "total": 150, "completed": 30, "running": true } }`
- If no job is running, `completed` is derived from DB counts: scrape completed = `COUNT(*) WHERE meta_title IS NOT NULL`, AI completed = `COUNT(*) WHERE ai_status IN ('done', 'failed')`.

**`POST /api/jobs/scrape/cancel`**
- Sets `app.state.scrape_cancel` event. Worker exits after current bookmark completes.
- Returns: `{ "status": "cancelled" }` or `{ "status": "not_running" }`

**`POST /api/jobs/ai-suggest/cancel`**
- Sets `app.state.ai_cancel` event. Worker exits after current Ollama call completes.
- Returns: `{ "status": "cancelled" }` or `{ "status": "not_running" }`

### Triage

**`GET /api/bookmarks/next`**
- Returns the next bookmark with `status = 'pending'`, ordered by `id ASC`
- **Usage:** Called only on initial triage page load when no filter is active. Once the frontend has loaded, all navigation uses the ID list from `/api/bookmarks/ids`.
- Response:
```json
{
  "id": 47,
  "url": "https://example.com/article",
  "original_title": "Some Article",
  "custom_title": null,
  "meta_title": "Some Article - Example.com",
  "meta_description": "A description of the article",
  "ai_suggestions": ["python", "tutorial"],
  "original_folder": "Programming/Python",
  "add_date": 1609459200,
  "favicon": "data:image/png;base64,...",
  "status": "pending",
  "tags": []
}
```

**`GET /api/bookmarks?status=pending&status=tagged&page=1&per_page=20`**
- List bookmarks with optional status filter
- **Note:** `status` is a multi-value query param. Use `status: list[str] = Query(default=[])` in FastAPI to capture all values. Without explicit `list[str]`, only the last value is captured.
- Returns paginated list with tag names included

**`GET /api/bookmarks/{id}`**
- Returns single bookmark with its tags

**`GET /api/bookmarks/ids?status=pending`**
- Returns ordered list of bookmark IDs matching the filter: `{ "ids": [1, 5, 12, 47, ...] }`
- Used by the triage frontend to build the prev/next navigation sequence. The frontend caches this list and navigates by index. Re-fetched when the filter changes.
- Accepts the same multi-value `status` param as the list endpoint.

**`PATCH /api/bookmarks/{id}`**
- Body: `{ "custom_title": "New Title", "status": "tagged", "tags": ["python", "tutorial", "web"] }`
- **All fields are optional** (partial update). Auto-save sends only `custom_title` and `tags` without `status`. Explicit "Save & Next" sends all three.
- Action:
  1. Update `custom_title` and `status`
  2. For tags: look up or create each tag by name, then **delete-and-replace** all entries in `bookmark_tags` for this bookmark. This full-replace strategy is intentional — simpler than diffing, and SQLite handles it fine at this scale.
- Returns: updated bookmark object

**`GET /api/bookmarks/progress`**
- Returns: `{ "total": 183, "pending": 136, "tagged": 44, "dead": 2, "discarded": 1 }`

### Tags

**`GET /api/tags`**
- Returns: `[{ "id": 1, "name": "python", "count": 12 }, ...]`
- Sorted by count descending

**`GET /api/tags/search?q=pyt`**
- Returns matching tags for autocomplete
- Sorted by count descending, limit 10

**`DELETE /api/tags/{id}`**
- Removes tag and all bookmark_tags associations

**`PATCH /api/tags/{id}`**
- Body: `{ "name": "new-name" }`
- Rename a tag. If target name already exists, merge (move all bookmark_tags to existing tag, delete the old one).

### Folders

**`GET /api/folders`**
- Returns full folder tree:
```json
[
  {
    "id": 1,
    "name": "Programming",
    "parent_id": null,
    "sort_order": 0,
    "tags": ["python", "javascript", "rust"],
    "bookmark_count": 34,
    "children": [
      { "id": 2, "name": "Tutorials", "parent_id": 1, "sort_order": 0, "tags": ["tutorial"], "bookmark_count": 12, "children": [] }
    ]
  }
]
```

**`POST /api/folders`**
- Body: `{ "name": "Programming", "parent_id": null, "sort_order": 0 }`
- `sort_order` defaults to appending after existing siblings if omitted
- **Root-level uniqueness check:** If `parent_id` is null, query for existing root folders with the same name and reject if found (SQLite UNIQUE constraint doesn't cover this case).
- Returns: created folder

**`PATCH /api/folders/{id}`**
- Body: `{ "name": "New Name", "parent_id": 3, "sort_order": 2 }`
- All fields optional
- Same root-level uniqueness check as POST when `parent_id` is null.

**`DELETE /api/folders/{id}`**
- Deletes folder and unlinks its tags. Child folders become root-level with `parent_id = NULL`. Their `sort_order` is reassigned sequentially after existing root folders to avoid collisions.

**`PUT /api/folders/reorder`**
- Body: `{ "items": [{ "id": 3, "parent_id": null, "sort_order": 0 }, { "id": 1, "parent_id": null, "sort_order": 1 }, ...] }`
- Accepts a flat list of `{ id, parent_id, sort_order }` tuples. Updates all in a single transaction. Used by drag-and-drop reorder/reparent in the organize page.
- Returns: `{ "updated": 5 }`

**`POST /api/folders/{id}/tags`**
- Body: `{ "tags": ["python", "javascript", "rust"] }` — accepts tag **names** (not IDs) to match the frontend's drag-and-drop UX where pills show names. Backend resolves names to IDs internally.
- Assigns tags to this folder. A tag can only belong to one folder (enforced by `UNIQUE(tag_id)` on `folder_tags`). If a tag is already assigned elsewhere, move it.

**`GET /api/folders/preview`**
- Returns the final folder structure with bookmarks placed:
```json
[
  {
    "folder": "Programming",
    "children": [
      {
        "folder": "Tutorials",
        "bookmarks": [
          { "title": "Learn Python", "url": "..." },
        ]
      }
    ],
    "bookmarks": [
      { "title": "Rust Book", "url": "..." }
    ]
  },
  {
    "folder": "_Unassigned",
    "bookmarks": [ ... ]
  }
]
```
- A bookmark is placed in a folder if ANY of its tags are assigned to that folder
- **Bookmarks with `status = 'dead'` or `status = 'discarded'` are excluded from the preview** (matching export behavior — preview is WYSIWYG for the final export)
- If a bookmark has tags in multiple folders, it appears in the FIRST matching folder (by `sort_order` among siblings, then by folder `id` for tiebreaking) unless `duplicate_handling` setting is `"duplicate"`, in which case it appears in all matching folders
- Bookmarks with no tags, or tags not assigned to any folder, go in `_Unassigned`

### Export

**`GET /api/export`**
- Generates and returns a Netscape bookmark HTML file
- Uses the folder structure from `/api/folders/preview` logic
- Format:
```html
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be parsed to restore the bookmarks. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>Programming</H3>
    <DL><p>
        <DT><H3>Tutorials</H3>
        <DL><p>
            <DT><A HREF="https://..." ADD_DATE="1609459200" ICON="data:...">Learn Python</A>
        </DL><p>
        <DT><A HREF="https://..." ADD_DATE="1609459200">Rust Book</A>
    </DL><p>
</DL><p>
```
- Title used: `custom_title` if set, otherwise `original_title`
- Preserve `ADD_DATE` and `ICON` from original import
- Bookmarks with `status = 'dead'` or `status = 'discarded'` are EXCLUDED from export
- Content-Disposition header: `attachment; filename="bookmarks_organized.html"`

**`GET /api/export?format=json`**
- Alternative export as JSON with full metadata (all tags, status, notes, original folder, etc.)

### Reset

**`POST /api/reset`**
- Drops all data. Clears all tables. Fresh start.
- Requires confirmation body: `{ "confirm": true }`

### App State

**`GET /api/state`**
- Returns the full initial state needed by the SPA on page load:
```json
{
  "has_bookmarks": true,
  "progress": { "total": 183, "pending": 136, "tagged": 44, "dead": 2, "discarded": 1 },
  "jobs": {
    "scrape": { "total": 183, "completed": 47, "running": true },
    "ai_suggest": { "total": 150, "completed": 30, "running": false }
  },
  "duplicate_handling": "first"
}
```
- The SPA calls this on every page load to determine: whether to show the import page or resume, whether background jobs are active, and current progress.

---

## AI Tagging (Ollama Integration)

### Configuration

Environment variables:
- `OLLAMA_URL` — default `http://ollama:11434` (Docker service name) or `http://localhost:11434`
- `OLLAMA_MODEL` — default `mistral` (good balance of speed and quality for this task)
- `AI_ENABLED` — default `true`. Set to `false` to disable entirely.

### Prompt Template

```
You are a bookmark tagging assistant. Given webpage metadata, suggest 1-4 short, lowercase tags for categorization.

Rules:
- Tags must be lowercase, single words or hyphenated (e.g., "machine-learning")
- Prefer REUSING existing tags from the list below when they fit
- Only suggest new tags if nothing in the existing list is a good match
- Return ONLY a JSON array of strings, nothing else

Existing tags in use: {existing_tags_list}

Webpage:
- URL: {url}
- Title: {title}
- Description: {description}

Respond with ONLY a JSON array like: ["tag1", "tag2", "tag3"]
```

### Implementation Notes

- Use `app.state.http_client` to call `POST {OLLAMA_URL}/api/generate` with `model`, `prompt`, `stream: false`
- Parse the response `.response` field as JSON
- If parsing fails, try to extract tags with a simple regex fallback (find anything that looks like `["...", "..."]`)
- **On parse failure after regex fallback:** set `ai_status = 'failed'`, leave `ai_suggestions` as NULL. This prevents infinite retries on subsequent job runs.
- **On successful parse:** set `ai_status = 'done'`, store result in `ai_suggestions`.
- If Ollama is globally unreachable (connection refused on first attempt), abort the entire job and return `{ "status": "skipped", "reason": "ollama_unavailable" }`
- Rate: process one bookmark per Ollama call, sequentially. At <200 bookmarks and ~1-2s per call, the full batch takes under 5 minutes.
- The batch job should be cancellable via `POST /api/jobs/ai-suggest/cancel`

---

## Frontend

### Tech Stack

- Vanilla HTML/CSS/JS. No build step. No framework.
- Served as static files by FastAPI (`StaticFiles` mount)
- Single-page app with hash-based routing: `#import`, `#triage`, `#organize`, `#export`

### Pages

#### 1. Import Page (`#import` — default landing)

**Layout:** Centered card, simple.

**Elements:**
- File upload area (drag-and-drop + click to browse). Accept `.html` files only.
- Upload button
- On upload: show progress spinner, then summary: "Imported 183 bookmarks (12 duplicates removed)"
- After import: two buttons — "Start Scraping Metadata" and "Skip to Triage"
  - If scraping started, show live progress: "Scraping: 47/183 complete"
  - If Ollama is available, automatically start AI suggestion job too. Show: "AI Suggestions: 30/150 complete"
- "Start Triage →" button (always available, even while background jobs run)
- If bookmarks already exist in DB (returning user), show: "You have 183 bookmarks (136 pending). Resume triage?" with options to resume or reset.

#### 2. Triage Page (`#triage`)

**Layout:** Two-panel split. Left: preview card (60%). Right: action panel (40%). Responsive — on mobile, stack vertically.

**Navigation model:** On page load, the frontend calls `/api/bookmarks/ids?status=pending` to get the ordered list of IDs. All prev/next navigation indexes into this cached list, fetching each bookmark via `/api/bookmarks/{id}`. The ID list is re-fetched when the filter changes. `/api/bookmarks/next` is only used as a fallback if the ID list is empty (e.g., first load before any filter is set).

**Left Panel — Bookmark Preview Card:**
- Large favicon (if available) + bookmark title (as heading)
- URL displayed (truncated, clickable — opens in new tab)
- Original folder path (dimmed, for context)
- Meta description (if scraped — may still be loading if scrape job is in progress)
- If `meta_title` differs from `original_title`, show both for comparison
- "Open in New Tab ↗" button — prominent, opens `window.open(url, '_blank')`
- If `meta_title == '[UNREACHABLE]'`, show a warning badge: "Site may be down"

**Right Panel — Actions:**
- **Header:** Progress indicator — `47 / 183` with a thin progress bar
- **Navigation:** `← Prev` and `Next →` buttons. Also keyboard shortcuts: left/right arrows.
- **URL:** Displayed as small, truncated, clickable link
- **Title field:** Editable text input. Pre-filled with: `custom_title` if set, else `meta_title` if available, else `original_title`. Placeholder: "Enter a title"
- **Tags section:**
  - Current tags shown as pills/chips with `×` to remove
  - Text input with autocomplete dropdown (searches existing tags via `/api/tags/search?q=...`)
  - Pressing Enter or comma creates the tag
  - New tags auto-created on the backend
- **AI Suggestions section** (only visible if `ai_suggestions` is non-null and non-empty):
  - Label: "AI suggests:"
  - Show suggestion tags as clickable pills — clicking one adds it to the tags list
  - Once a suggestion is accepted or all are dismissed, section collapses
- **Action buttons:**
  - `Mark Dead` — sets status to `dead`, auto-advances to next
  - `Discard` — sets status to `discarded`, auto-advances to next
  - `Skip` — does NOT change status, advances to next (user can come back)
  - `Save & Next` — sets status to `tagged` (requires at least one tag), advances to next. This is the PRIMARY action — visually prominent.
- **Keyboard shortcuts:**
  - `Ctrl+Enter` or `Cmd+Enter` — Save & Next
  - `d` — Mark Dead (when title input is not focused)
  - `→` — Next
  - `←` — Previous
- **Filter bar** (collapsible, above the main content):
  - Filter buttons: `All` | `Pending` | `Tagged` | `Dead` | `Discarded`
  - Shows count for each
  - When filtered, navigation (prev/next) moves within the filtered set. Changing filter re-fetches `/api/bookmarks/ids` with the new status param.

**Auto-save behavior:** When the user types in the title field or adds/removes tags, auto-save after 1 second debounce via `PATCH /api/bookmarks/{id}`. Do NOT set status to `tagged` on auto-save — only on explicit "Save & Next" click. **Race condition guard:** When "Save & Next" fires, cancel any pending debounce timer first. Auto-save sends only `custom_title` and `tags` fields; it never sends `status`. This ensures an in-flight auto-save cannot overwrite the status set by "Save & Next". **Note:** The PATCH endpoint does a full delete-and-replace of `bookmark_tags` on every call. This creates some write churn during rapid tag edits but is correct and simple; SQLite handles it fine at this scale.

#### 3. Organize Page (`#organize`)

**Layout:** Two-panel. Left: folder tree (40%). Right: tag pool + preview (60%).

**Left Panel — Folder Tree:**
- Shows current folder hierarchy as an indented tree
- Each folder shows: name, number of bookmarks that would land in it
- "Add Folder" button at root level
- Each folder has: rename (inline edit), delete, "Add Subfolder" button
- Folders are draggable for reordering / reparenting. On drop, the frontend computes the new `sort_order` values for all affected siblings and sends a single `PUT /api/folders/reorder` request.

**Right Panel — Tag Pool & Mapping:**
- **Tag Pool (top):** All tags shown as draggable pills with bookmark counts. Tags already assigned to a folder are dimmed/greyed. Unassigned tags are prominent.
- **Drag & Drop:** User drags a tag from the pool onto a folder in the left panel. This assigns the tag to that folder via `POST /api/folders/{id}/tags`.
- **Clicking a tag** shows a small popover listing the bookmarks that have this tag.
- **Bulk assign:** Multi-select tags (checkboxes), then click a folder to assign all selected.
- **Unassigned indicator:** Clear count of "X tags unassigned → Y bookmarks won't be in any folder"

**Preview section (bottom of right panel):**
- "Preview Export" button
- Shows the final folder tree with bookmarks placed (from `/api/folders/preview`)
- Expandable/collapsible folder nodes
- Highlights `_Unassigned` folder if it has bookmarks

**Setting:** Radio buttons for duplicate handling:
- "Place in first matching folder" (default)
- "Duplicate into all matching folders"

#### 4. Export Page (`#export`)

**Layout:** Centered card.

**Elements:**
- Summary stats: "Exporting 178 bookmarks in 12 folders (3 dead, 2 discarded excluded)"
- "Download Bookmarks HTML" button → triggers `/api/export` download
- "Download JSON (full metadata)" button → triggers `/api/export?format=json`
- Instructions text: "To import into your browser: Chrome → Bookmark Manager → ⋮ → Import bookmarks from HTML file"
- "Start Over" button → triggers `/api/reset` with confirmation dialog

### Styling

- Clean, minimal. Dark and light mode (respect `prefers-color-scheme`).
- CSS custom properties for theming.
- No CSS framework. Hand-written CSS.
- Monospace font for URLs. System font stack for everything else.
- Tag pills: rounded, colored background (generate consistent color from tag name hash).
- Progress bar: thin, colored, at the top of the triage panel.

---

## HTML Bookmark Parser — Detailed Implementation

The Netscape bookmark HTML format is not valid HTML. It uses unclosed `<DT>` and `<DL>` tags. BeautifulSoup with `html.parser` handles this reasonably well.

**Strategy:** Build a parent-map first by iterating `<DL>` → `<H3>` pairs in document order, then use it to resolve folder paths for each `<A>` tag. This is more robust than sibling-walking, which breaks across browser format differences (Firefox `<HR>` separators, missing `<p>` after `<DL>`, etc.).

**Browser format differences:** Chrome, Firefox, and Edge each produce slightly different HTML structures. **Test with exports from all three browsers.**

```python
from bs4 import BeautifulSoup
from urllib.parse import urlparse, urlencode, parse_qsl

def parse_bookmark_html(html_content: str) -> list[dict]:
    """
    Parse a Netscape-format bookmark HTML file.
    Returns list of bookmark dicts.
    
    Uses a parent-map approach: first pass builds a mapping from each <DL>
    to its folder name by finding the preceding <H3>. Second pass extracts
    <A> tags and walks the parent-map for folder paths.
    """
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # Build parent-map: map each <DL> element to its folder name
    dl_to_folder = {}
    for dl in soup.find_all('dl'):
        # The folder name for a <DL> is in the <H3> inside the <DT> that precedes it.
        # In the parse tree, this <DT> is typically the parent of the <DL>.
        parent_dt = dl.parent if dl.parent and dl.parent.name == 'dt' else None
        if parent_dt:
            h3 = parent_dt.find('h3', recursive=False)
            if h3:
                dl_to_folder[id(dl)] = h3.get_text(strip=True)
    
    bookmarks = []
    for a_tag in soup.find_all('a'):
        href = a_tag.get('href', '').strip()
        if not href or href.startswith('javascript:') or href.startswith('place:'):
            continue

        # Walk up the tree collecting folder names from the parent-map
        folders = []
        node = a_tag.parent
        while node:
            if node.name == 'dl' and id(node) in dl_to_folder:
                folders.append(dl_to_folder[id(node)])
            node = node.parent
        folders.reverse()
        folder_path = '/'.join(folders) if folders else ''

        bookmarks.append({
            'url': normalize_url(href),
            'original_title': a_tag.get_text(strip=True),
            'add_date': int(a_tag.get('add_date', 0) or 0),
            'favicon': a_tag.get('icon', ''),
            'original_folder': folder_path,
        })

    return bookmarks


def normalize_url(url: str) -> str:
    """
    Normalize URL for deduplication.
    Note: Fragments are stripped, so SPA-routed URLs differing only by
    fragment will be treated as duplicates. Acceptable for <200 bookmarks.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    host = parsed.netloc.lower()
    path = parsed.path.rstrip('/') or '/'
    # Sort query parameters — use parse_qsl (flat list of tuples) not parse_qs
    # (dict of lists) so multi-value params like ?a=2&a=1 sort correctly.
    if parsed.query:
        params = parse_qsl(parsed.query, keep_blank_values=True)
        sorted_query = urlencode(sorted(params))
    else:
        sorted_query = ''
    return f"{scheme}://{host}{path}" + (f"?{sorted_query}" if sorted_query else "")
```

---

## Export Generator — Detailed Implementation

```python
from html import escape

def generate_bookmark_html(folder_tree: list[dict]) -> str:
    """
    Generate Netscape bookmark HTML format from folder tree.
    folder_tree structure from /api/folders/preview endpoint.
    """
    lines = [
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
        '<!-- This is an automatically generated file.',
        '     It will be parsed to restore the bookmarks. -->',
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        '<TITLE>Bookmarks</TITLE>',
        '<H1>Bookmarks</H1>',
        '<DL><p>',
    ]

    def render_folder(node, indent=1):
        prefix = '    ' * indent
        lines.append(f'{prefix}<DT><H3>{escape(node["folder"])}</H3>')
        lines.append(f'{prefix}<DL><p>')
        for child in node.get('children', []):
            render_folder(child, indent + 1)
        for bm in node.get('bookmarks', []):
            title = escape(bm.get('custom_title') or bm['original_title'])
            href = escape(bm['url'])
            attrs = f'HREF="{href}"'
            if bm.get('add_date'):
                attrs += f' ADD_DATE="{bm["add_date"]}"'
            if bm.get('favicon'):
                # escape() is safe for both URL-based favicons (handles &)
                # and data URIs (base64 chars are not affected by HTML escaping)
                attrs += f' ICON="{escape(bm["favicon"])}"'
            lines.append(f'{prefix}    <DT><A {attrs}>{title}</A>')
        lines.append(f'{prefix}</DL><p>')

    for folder in folder_tree:
        render_folder(folder)

    lines.append('</DL><p>')
    return '\n'.join(lines)
```

---

## Metadata Scraper — Detailed Implementation

```python
import httpx
from bs4 import BeautifulSoup

async def scrape_metadata(url: str, client: httpx.AsyncClient) -> dict:
    """
    Fetch a URL and extract title + description metadata.
    Uses the shared httpx.AsyncClient passed from app.state.http_client
    (already configured with timeout=10s, max_redirects=5).
    Parses only the first 50KB of HTML for performance.
    Returns dict with meta_title and meta_description (both may be None).
    """
    try:
        resp = await client.get(url)

        if resp.status_code >= 400:
            return {"meta_title": "[UNREACHABLE]", "meta_description": None}

        content_type = resp.headers.get("content-type", "")
        if "text/html" not in content_type:
            return {"meta_title": None, "meta_description": None}

        # Parse only first 50KB — metadata is always in <head>
        html_snippet = resp.text[:51200]
        soup = BeautifulSoup(html_snippet, 'html.parser')

        # Title: prefer og:title > title tag
        og_title = soup.find('meta', property='og:title')
        title_tag = soup.find('title')
        meta_title = None
        if og_title and og_title.get('content'):
            meta_title = og_title['content'].strip()
        elif title_tag and title_tag.string:
            meta_title = title_tag.string.strip()

        # Description: prefer og:description > meta description
        og_desc = soup.find('meta', property='og:description')
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        meta_description = None
        if og_desc and og_desc.get('content'):
            meta_description = og_desc['content'].strip()
        elif meta_desc and meta_desc.get('content'):
            meta_description = meta_desc['content'].strip()

        return {"meta_title": meta_title, "meta_description": meta_description}

    except Exception:
        return {"meta_title": "[UNREACHABLE]", "meta_description": None}
```

---

## Docker Setup

### Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### docker-compose.yml

```yaml
services:
  bookmark-organizer:
    build: .
    ports:
      - "8080:8000"
    volumes:
      - ./data:/app/data    # SQLite DB persistence
    environment:
      - OLLAMA_URL=http://ollama:11434
      - OLLAMA_MODEL=mistral
      - AI_ENABLED=true
    depends_on:
      - ollama

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    # User must pull model manually: docker exec -it ollama ollama pull mistral

volumes:
  ollama_data:
```

### requirements.txt

```
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
httpx>=0.27.0
beautifulsoup4>=4.12.0
aiosqlite>=0.20.0
python-multipart>=0.0.9
```

### Data persistence

- SQLite database stored at `/app/data/bookmarks.db`
- Volume-mounted so data survives container recreation
- Database created on first startup if not exists

---

## File Structure

```
bookmark-organizer/
├── main.py                  # FastAPI app, startup (httpx client init), mount static files
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── db.py                    # SQLite connection, schema creation
├── models.py                # Pydantic models for request/response
├── routers/
│   ├── import_router.py     # POST /api/import
│   ├── bookmarks.py         # GET/PATCH /api/bookmarks/*
│   ├── tags.py              # GET/DELETE/PATCH /api/tags/*
│   ├── folders.py           # CRUD /api/folders/*, PUT /api/folders/reorder
│   ├── export.py            # GET /api/export
│   ├── jobs.py              # POST/GET /api/jobs/*
│   ├── settings.py          # GET/PATCH /api/settings
│   └── state.py             # GET /api/state (initial SPA state)
├── services/
│   ├── parser.py            # HTML bookmark parser (parent-map approach)
│   ├── scraper.py           # Metadata scraper
│   ├── ai_tagger.py         # Ollama integration
│   ├── exporter.py          # Bookmark HTML generator
│   └── url_utils.py         # URL normalization
├── static/
│   ├── index.html           # Single-page app shell
│   ├── css/
│   │   └── style.css        # All styles
│   └── js/
│       ├── app.js           # Router, init, global state
│       ├── api.js           # API client (fetch wrapper)
│       ├── import.js        # Import page logic
│       ├── triage.js        # Triage page logic
│       ├── organize.js      # Organize page logic
│       └── export.js        # Export page logic
└── data/
    └── bookmarks.db         # SQLite (created at runtime, volume-mounted)
```

---

## Build Order (Priority)

Build and test each phase end-to-end before moving to the next.

### Phase 1 — Skeleton + Import + Basic Triage (MVP core)

1. `main.py` — FastAPI app, CORS, static file mount, startup event (httpx client), shutdown event
2. `db.py` — SQLite schema creation (all tables), connection helper using `aiosqlite`
3. `models.py` — Pydantic models
4. `services/url_utils.py` — URL normalization function
5. `services/parser.py` — HTML bookmark parser with parent-map approach
6. `routers/import_router.py` — File upload + parse + insert
7. `routers/bookmarks.py` — GET next, GET by id, GET ids, PATCH, GET progress
8. `routers/tags.py` — GET all, GET search
9. `static/index.html` — App shell with hash router
10. `static/js/app.js` — Router
11. `static/js/api.js` — Fetch wrapper
12. `static/js/import.js` — Upload UI
13. `static/js/triage.js` — Two-panel triage UI with preview card (favicon, title, URL, meta description, "Open in New Tab"), ID-list navigation
14. `static/css/style.css` — Core styles

**Test:** Upload a real bookmark export. Triage through bookmarks. Verify tags are created and saved. Verify progress tracking works. Verify resume after page refresh.

### Phase 2 — Folder Management + Export Pipeline

1. `routers/folders.py` — Full folder CRUD + reorder endpoint + tag assignment + preview
2. `routers/export.py` — HTML + JSON export
3. `services/exporter.py` — Netscape HTML generator
4. `routers/settings.py` — Duplicate handling setting
5. `static/js/organize.js` — Folder tree + tag pool + drag-and-drop
6. `static/js/export.js` — Export page with download buttons

**Test:** Complete full pipeline: import → triage all → create folders → assign tags → preview → export → import the exported file into Chrome and verify structure.

### Phase 3 — Metadata Scraping + AI Suggestions

1. `services/scraper.py` — Async metadata scraper (50KB limit)
2. `services/ai_tagger.py` — Ollama integration (with `ai_status` = `failed` on garbage responses)
3. `routers/jobs.py` — Background job management (scrape + retry_unreachable + AI suggest + status + cancel)
4. Update `import.js` — Job trigger buttons + progress display
5. Update `triage.js` — Show AI suggestions as clickable pills, show scraped metadata

**Test:** Import bookmarks. Run scrape job. Verify metadata populates. Run AI suggest job (with Ollama running). Verify suggestions appear in triage UI. Verify graceful handling when Ollama is down. Test retry_unreachable.

### Phase 4 — Polish

1. Dark/light mode
2. Keyboard shortcuts in triage
3. Tag rename/merge in organize page
4. Filter bar in triage
5. Mobile responsive layout
6. Error handling + toast notifications
7. "Start Over" / reset functionality
8. README with setup instructions

---

## Edge Cases to Handle

1. **Empty bookmark file** — Show friendly message, don't create empty DB
2. **Bookmark with no title** — Use URL hostname as fallback title
3. **Bookmark with no URL** — Skip during import
4. **Extremely long URLs** — Truncate display, keep full URL in DB
5. **Non-UTF-8 bookmark files** — Try to detect encoding, fallback to latin-1
6. **Favicon data URIs that are very large** — Store them but consider truncating in the UI display
7. **User closes browser mid-triage** — All progress already saved to SQLite, resume on next visit
8. **Ollama returns garbage** — Validate that response is a JSON array of strings. If not, set `ai_status = 'failed'` and leave `ai_suggestions = null`. This prevents infinite retries.
9. **Duplicate tag names with different casing** — Normalize all tags to lowercase on creation
10. **Tag with zero bookmarks after reorganization** — Allow orphan tags, show warning in organize page
11. **Folder with no tags assigned** — Valid (parent folders often have no direct tags). Show bookmark count = sum of children.
12. **All bookmarks marked dead/discarded** — Export generates a valid but empty bookmark file. Show warning.
13. **Re-import over existing data** — Ask user: merge or reset? For v1, require reset before new import.
14. **Fragment-only URL differences** — Accepted as duplicates due to fragment stripping. Document this tradeoff.
15. **Server restart mid-job** — Job is lost (asyncio.Task). Job status endpoint returns `running: false`. User can re-trigger.
