import json
from fastapi import APIRouter, Query
from fastapi.responses import Response

from db import get_db
from routers.folders import preview_export
from services.exporter import generate_bookmark_html

router = APIRouter()


@router.get("/export")
async def export_bookmarks(format: str = Query(default="html")):
    if format == "json":
        return await _export_json()

    # HTML export
    folder_tree = await preview_export()
    html = generate_bookmark_html(folder_tree)
    return Response(
        content=html,
        media_type="text/html",
        headers={"Content-Disposition": 'attachment; filename="bookmarks_organized.html"'},
    )


async def _export_json():
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT b.*, GROUP_CONCAT(t.name) as tag_names
               FROM bookmarks b
               LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id
               LEFT JOIN tags t ON t.id = bt.tag_id
               WHERE b.status NOT IN ('dead', 'discarded')
               GROUP BY b.id
               ORDER BY b.id"""
        )
        bookmarks = []
        for r in rows:
            bookmarks.append({
                "id": r["id"],
                "url": r["url"],
                "original_title": r["original_title"],
                "custom_title": r["custom_title"],
                "original_folder": r["original_folder"],
                "add_date": r["add_date"],
                "favicon": r["favicon"],
                "status": r["status"],
                "meta_title": r["meta_title"],
                "meta_description": r["meta_description"],
                "tags": r["tag_names"].split(",") if r["tag_names"] else [],
            })

        content = json.dumps(bookmarks, indent=2, ensure_ascii=False)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="bookmarks_organized.json"'},
        )
    finally:
        await db.close()
