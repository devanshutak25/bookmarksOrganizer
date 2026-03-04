# Bookmark Organizer

A self-hosted web app for importing, triaging, organizing, and exporting browser bookmarks. Built with Python (FastAPI) + SQLite + vanilla HTML/CSS/JS.

## Features

- **Import** — Upload Netscape bookmark HTML files (Chrome, Firefox, Edge, etc.). Duplicates are detected automatically.
- **Triage** — Review bookmarks one at a time. Add tags, edit titles, mark dead links, or discard. Keyboard shortcuts and auto-save included.
- **Organize** — Create a folder hierarchy, then drag-and-drop tags onto folders. Each tag maps to one folder. Preview the final structure before exporting.
- **Export** — Download organized bookmarks as Netscape HTML (re-importable into any browser) or JSON.
- **Metadata scraping** — Fetch page titles and descriptions from live URLs (background job).
- **AI tag suggestions** — Optional Ollama integration to auto-suggest tags per bookmark.
- **Dark/light mode** — Toggleable, persisted in localStorage.

## Quick Start

### Local (Python)

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

Open http://localhost:8000

### Docker

```bash
docker compose up --build
```

Open http://localhost:8080

The Docker Compose setup includes an Ollama container for AI tag suggestions. To pull a model:

```bash
docker compose exec ollama ollama pull mistral
```

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `data/bookmarks.db` | SQLite database path |
| `AI_ENABLED` | `false` | Enable AI tag suggestions |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `mistral` | Ollama model name |

## Keyboard Shortcuts (Triage)

| Key | Action |
|---|---|
| `Arrow Left/Right` | Navigate bookmarks |
| `Ctrl+Enter` | Save & Next |
| `D` | Mark as dead |

## Project Structure

```
main.py              FastAPI app + router mounting
db.py                SQLite schema + connection helper
models.py            Pydantic models
routers/
  import_router.py   POST /api/import
  bookmarks.py       Bookmark CRUD + progress
  tags.py            Tag list/search/rename/delete
  folders.py         Folder CRUD + tag assignment + preview
  export.py          GET /api/export (HTML/JSON)
  jobs.py            Background scrape + AI suggest jobs
  settings.py        Key-value settings
  state.py           GET /api/state (SPA init)
  reset.py           POST /api/reset
services/
  parser.py          Netscape bookmark HTML parser
  url_utils.py       URL normalization
  scraper.py         Metadata fetcher (title, description, favicon)
  ai_tagger.py       Ollama AI tag suggestion
  exporter.py        Netscape HTML generator
static/
  index.html         SPA shell
  css/style.css      All styles (light/dark themes)
  js/
    app.js           Router, theme toggle, toast notifications
    api.js           Fetch wrapper for all API endpoints
    import.js        Import page + job controls
    triage.js        Triage page + filter bar
    organize.js      Organize page + folder tree + tag pool
    export.js        Export page + reset
```

## API Overview

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/import` | Upload bookmark HTML file |
| `GET` | `/api/bookmarks/ids` | List bookmark IDs (filterable by status) |
| `GET` | `/api/bookmarks/{id}` | Get single bookmark |
| `PATCH` | `/api/bookmarks/{id}` | Update bookmark (title, tags, status) |
| `GET` | `/api/bookmarks/progress` | Triage progress counts |
| `GET` | `/api/tags` | List all tags with counts |
| `GET` | `/api/tags/search?q=` | Search tags by name |
| `PATCH` | `/api/tags/{id}` | Rename or merge tag |
| `DELETE` | `/api/tags/{id}` | Delete tag |
| `GET` | `/api/folders` | List folder tree |
| `POST` | `/api/folders` | Create folder |
| `PATCH` | `/api/folders/{id}` | Rename/move folder |
| `DELETE` | `/api/folders/{id}` | Delete folder |
| `POST` | `/api/folders/{id}/tags` | Assign tags to folder |
| `GET` | `/api/folders/preview` | Preview export structure |
| `GET` | `/api/export?format=html` | Download organized bookmarks |
| `POST` | `/api/jobs/scrape` | Start metadata scraping job |
| `POST` | `/api/jobs/ai-suggest` | Start AI suggestion job |
| `GET` | `/api/jobs/status` | Get background job status |
| `POST` | `/api/reset` | Delete all data |

## License

MIT
