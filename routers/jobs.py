import asyncio
import json
from fastapi import APIRouter, Request, Query

from db import get_db
from services.scraper import scrape_metadata
from services.ai_tagger import suggest_tags, check_ollama_available, AI_ENABLED

router = APIRouter()


# --- Scrape job ---

async def _scrape_worker(app):
    """Background worker that scrapes metadata for all pending bookmarks."""
    cancel_event = app.state.scrape_cancel
    client = app.state.http_client

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id, url FROM bookmarks WHERE meta_title IS NULL ORDER BY id"
        )
        app.state.scrape_total = len(rows)
        app.state.scrape_completed = 0

        for row in rows:
            if cancel_event.is_set():
                break

            meta = await scrape_metadata(row["url"], client)
            await db.execute(
                "UPDATE bookmarks SET meta_title = ?, meta_description = ? WHERE id = ?",
                (meta["meta_title"], meta["meta_description"], row["id"]),
            )
            await db.commit()
            app.state.scrape_completed += 1
    finally:
        await db.close()


@router.post("/jobs/scrape")
async def start_scrape(request: Request, retry_unreachable: bool = Query(default=False)):
    # Check if already running
    task = getattr(request.app.state, "scrape_task", None)
    if task is not None and not task.done():
        return {"status": "already_running"}

    db = await get_db()
    try:
        if retry_unreachable:
            # Reset unreachable bookmarks so they get re-scraped
            await db.execute(
                "UPDATE bookmarks SET meta_title = NULL, meta_description = NULL WHERE meta_title = '[UNREACHABLE]'"
            )
            await db.commit()

        # Count how many need scraping
        rows = await db.execute_fetchall(
            "SELECT COUNT(*) as cnt FROM bookmarks WHERE meta_title IS NULL"
        )
        total = rows[0]["cnt"]
    finally:
        await db.close()

    if total == 0:
        return {"status": "nothing_to_scrape", "total": 0}

    # Launch background task
    request.app.state.scrape_cancel = asyncio.Event()
    request.app.state.scrape_total = total
    request.app.state.scrape_completed = 0
    request.app.state.scrape_task = asyncio.create_task(_scrape_worker(request.app))

    return {"status": "started", "total": total}


@router.post("/jobs/scrape/cancel")
async def cancel_scrape(request: Request):
    task = getattr(request.app.state, "scrape_task", None)
    if task is None or task.done():
        return {"status": "not_running"}

    request.app.state.scrape_cancel.set()
    return {"status": "cancelled"}


# --- AI suggest job ---

async def _ai_suggest_worker(app):
    """Background worker that gets AI tag suggestions via Ollama."""
    import logging
    logger = logging.getLogger(__name__)

    cancel_event = app.state.ai_cancel
    client = app.state.http_client

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT id, url, original_title, custom_title, meta_title, meta_description
               FROM bookmarks
               WHERE ai_suggestions IS NULL AND ai_status IS NULL
               ORDER BY id"""
        )
        app.state.ai_total = len(rows)
        app.state.ai_completed = 0
        logger.warning("AI worker: %d bookmarks to process", len(rows))

        # Get existing tags for the prompt
        tag_rows = await db.execute_fetchall("SELECT name FROM tags ORDER BY name")
        existing_tags = [r["name"] for r in tag_rows]

        for row in rows:
            if cancel_event.is_set():
                break

            meta_title = row["meta_title"] if row["meta_title"] != "[UNREACHABLE]" else None
            title = row["custom_title"] or meta_title or row["original_title"] or row["url"]
            description = row["meta_description"]

            suggestions, status = await suggest_tags(
                url=row["url"],
                title=title,
                description=description,
                existing_tags=existing_tags,
                client=client,
            )

            if status == "done" and suggestions:
                await db.execute(
                    "UPDATE bookmarks SET ai_suggestions = ?, ai_status = 'done' WHERE id = ?",
                    (json.dumps(suggestions), row["id"]),
                )
                # Add new tags to the existing list for subsequent prompts
                for t in suggestions:
                    if t not in existing_tags:
                        existing_tags.append(t)
            else:
                await db.execute(
                    "UPDATE bookmarks SET ai_status = 'failed' WHERE id = ?",
                    (row["id"],),
                )

            await db.commit()
            app.state.ai_completed += 1
    finally:
        await db.close()


@router.post("/jobs/ai-suggest")
async def start_ai_suggest(request: Request, retry_failed: bool = Query(default=False)):
    if not AI_ENABLED:
        return {"status": "skipped", "reason": "ai_disabled"}

    # Check if already running
    task = getattr(request.app.state, "ai_task", None)
    if task is not None and not task.done():
        return {"status": "already_running"}

    # Check Ollama availability before launching
    client = request.app.state.http_client
    available = await check_ollama_available(client)
    if not available:
        return {"status": "skipped", "reason": "ollama_unavailable"}

    db = await get_db()
    try:
        if retry_failed:
            await db.execute(
                "UPDATE bookmarks SET ai_suggestions = NULL, ai_status = NULL WHERE ai_status = 'failed'"
            )
            await db.commit()

        rows = await db.execute_fetchall(
            """SELECT COUNT(*) as cnt FROM bookmarks
               WHERE ai_suggestions IS NULL AND ai_status IS NULL"""
        )
        total = rows[0]["cnt"]
    finally:
        await db.close()

    if total == 0:
        return {"status": "nothing_to_suggest", "total": 0}

    # Launch background task
    request.app.state.ai_cancel = asyncio.Event()
    request.app.state.ai_total = total
    request.app.state.ai_completed = 0
    request.app.state.ai_task = asyncio.create_task(_ai_suggest_worker(request.app))

    return {"status": "started", "total": total}


@router.post("/jobs/ai-suggest/cancel")
async def cancel_ai_suggest(request: Request):
    task = getattr(request.app.state, "ai_task", None)
    if task is None or task.done():
        return {"status": "not_running"}

    request.app.state.ai_cancel.set()
    return {"status": "cancelled"}


# --- Job status ---

@router.get("/jobs/status")
async def get_job_status(request: Request):
    db = await get_db()
    try:
        total_row = await db.execute_fetchall("SELECT COUNT(*) as cnt FROM bookmarks")
        total = total_row[0]["cnt"]

        # Scrape status
        scrape_task = getattr(request.app.state, "scrape_task", None)
        scrape_running = scrape_task is not None and not scrape_task.done()
        if scrape_running:
            scrape_total = getattr(request.app.state, "scrape_total", 0)
            scrape_completed = getattr(request.app.state, "scrape_completed", 0)
        else:
            row = await db.execute_fetchall(
                "SELECT COUNT(*) as cnt FROM bookmarks WHERE meta_title IS NOT NULL"
            )
            scrape_completed = row[0]["cnt"]
            scrape_total = total

        # AI status
        ai_task = getattr(request.app.state, "ai_task", None)
        ai_running = ai_task is not None and not ai_task.done()
        if ai_running:
            ai_total = getattr(request.app.state, "ai_total", 0)
            ai_completed = getattr(request.app.state, "ai_completed", 0)
        else:
            row = await db.execute_fetchall(
                "SELECT COUNT(*) as cnt FROM bookmarks WHERE ai_status IN ('done', 'failed')"
            )
            ai_completed = row[0]["cnt"]
            ai_total = total

        return {
            "scrape": {"total": scrape_total, "completed": scrape_completed, "running": scrape_running},
            "ai_suggest": {"total": ai_total, "completed": ai_completed, "running": ai_running},
        }
    finally:
        await db.close()
