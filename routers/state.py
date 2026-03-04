import asyncio
from fastapi import APIRouter, Request

from db import get_db
from models import AppStateOut, ProgressOut, JobStatus

router = APIRouter()


@router.get("/state", response_model=AppStateOut)
async def get_app_state(request: Request):
    db = await get_db()
    try:
        # Progress
        rows = await db.execute_fetchall(
            "SELECT status, COUNT(*) as cnt FROM bookmarks GROUP BY status"
        )
        counts = {r["status"]: r["cnt"] for r in rows}
        total = sum(counts.values())

        progress = ProgressOut(
            total=total,
            pending=counts.get("pending", 0),
            tagged=counts.get("tagged", 0),
            dead=counts.get("dead", 0),
            discarded=counts.get("discarded", 0),
        )

        # Scrape job status
        scrape_task = getattr(request.app.state, "scrape_task", None)
        scrape_running = scrape_task is not None and not scrape_task.done()
        if scrape_running:
            scrape_total = getattr(request.app.state, "scrape_total", 0)
            scrape_completed = getattr(request.app.state, "scrape_completed", 0)
        else:
            row = await db.execute_fetchall(
                "SELECT COUNT(*) as cnt FROM bookmarks WHERE meta_title IS NOT NULL"
            )
            scrape_completed = row[0]["cnt"] if row else 0
            scrape_total = total

        # AI job status
        ai_task = getattr(request.app.state, "ai_task", None)
        ai_running = ai_task is not None and not ai_task.done()
        if ai_running:
            ai_total = getattr(request.app.state, "ai_total", 0)
            ai_completed = getattr(request.app.state, "ai_completed", 0)
        else:
            row = await db.execute_fetchall(
                "SELECT COUNT(*) as cnt FROM bookmarks WHERE ai_status IN ('done', 'failed')"
            )
            ai_completed = row[0]["cnt"] if row else 0
            row2 = await db.execute_fetchall("SELECT COUNT(*) as cnt FROM bookmarks")
            ai_total = row2[0]["cnt"] if row2 else 0

        # Settings
        setting_row = await db.execute_fetchall(
            "SELECT value FROM settings WHERE key = 'duplicate_handling'"
        )
        dup_handling = "first"
        if setting_row:
            import json
            try:
                dup_handling = json.loads(setting_row[0]["value"])
            except Exception:
                pass

        return AppStateOut(
            has_bookmarks=total > 0,
            progress=progress,
            jobs={
                "scrape": JobStatus(total=scrape_total, completed=scrape_completed, running=scrape_running),
                "ai_suggest": JobStatus(total=ai_total, completed=ai_completed, running=ai_running),
            },
            duplicate_handling=dup_handling,
        )
    finally:
        await db.close()
