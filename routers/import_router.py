import json
from fastapi import APIRouter, UploadFile, File, HTTPException

from db import get_db
from models import ImportOut
from services.parser import parse_bookmark_html

router = APIRouter()


@router.post("/import", response_model=ImportOut)
async def import_bookmarks(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".html"):
        raise HTTPException(400, "Only .html bookmark files are accepted")

    content = await file.read()
    # Try UTF-8 first, fallback to latin-1
    try:
        html_content = content.decode("utf-8")
    except UnicodeDecodeError:
        html_content = content.decode("latin-1")

    bookmarks, duplicates = parse_bookmark_html(html_content)

    if not bookmarks:
        raise HTTPException(400, "No bookmarks found in the uploaded file")

    db = await get_db()
    try:
        # Check if bookmarks already exist — require reset first
        row = await db.execute_fetchall("SELECT COUNT(*) as cnt FROM bookmarks")
        if row[0][0] > 0:
            raise HTTPException(
                409,
                "Bookmarks already exist. Reset before importing again."
            )

        inserted = 0
        for bm in bookmarks:
            try:
                await db.execute(
                    """INSERT INTO bookmarks (url, original_title, add_date, favicon, original_folder, status)
                       VALUES (?, ?, ?, ?, ?, 'pending')""",
                    (bm["url"], bm["original_title"], bm["add_date"], bm["favicon"], bm["original_folder"]),
                )
                inserted += 1
            except Exception:
                # Skip duplicate URLs (shouldn't happen after parser dedup, but defensive)
                duplicates += 1

        await db.commit()
        return ImportOut(imported=inserted, duplicates_removed=duplicates)
    finally:
        await db.close()
