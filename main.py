import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from db import init_db
from routers import import_router, bookmarks, tags, state, folders, export, settings, reset, jobs


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    app.state.http_client = httpx.AsyncClient(timeout=120.0, follow_redirects=True, max_redirects=5)
    # Job tracking state
    app.state.scrape_task = None
    app.state.scrape_cancel = None
    app.state.scrape_total = 0
    app.state.scrape_completed = 0
    app.state.ai_task = None
    app.state.ai_cancel = None
    app.state.ai_total = 0
    app.state.ai_completed = 0
    yield
    await app.state.http_client.aclose()


app = FastAPI(title="Bookmark Organizer", lifespan=lifespan)

app.include_router(import_router.router, prefix="/api")
app.include_router(bookmarks.router, prefix="/api")
app.include_router(tags.router, prefix="/api")
app.include_router(state.router, prefix="/api")
app.include_router(folders.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(reset.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))
