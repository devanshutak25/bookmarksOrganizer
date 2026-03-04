import json
from fastapi import APIRouter, HTTPException, Query

from db import get_db
from models import BookmarkOut, BookmarkPatch, BookmarkIdsOut, ProgressOut

router = APIRouter()


def _parse_ai_suggestions(raw: str | None) -> list[str] | None:
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


async def _bookmark_with_tags(db, row) -> BookmarkOut:
    tag_rows = await db.execute_fetchall(
        "SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ?",
        (row["id"],),
    )
    return BookmarkOut(
        id=row["id"],
        url=row["url"],
        original_title=row["original_title"],
        custom_title=row["custom_title"],
        meta_title=row["meta_title"],
        meta_description=row["meta_description"],
        ai_suggestions=_parse_ai_suggestions(row["ai_suggestions"]),
        original_folder=row["original_folder"],
        add_date=row["add_date"],
        favicon=row["favicon"],
        status=row["status"],
        tags=[r["name"] for r in tag_rows],
    )


@router.get("/bookmarks/next", response_model=BookmarkOut | None)
async def get_next_bookmark():
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT * FROM bookmarks WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
        )
        if not rows:
            return None
        return await _bookmark_with_tags(db, rows[0])
    finally:
        await db.close()


@router.get("/bookmarks/ids", response_model=BookmarkIdsOut)
async def get_bookmark_ids(status: list[str] = Query(default=[])):
    db = await get_db()
    try:
        if status:
            placeholders = ",".join("?" for _ in status)
            rows = await db.execute_fetchall(
                f"SELECT id FROM bookmarks WHERE status IN ({placeholders}) ORDER BY id ASC",
                status,
            )
        else:
            rows = await db.execute_fetchall("SELECT id FROM bookmarks ORDER BY id ASC")
        return BookmarkIdsOut(ids=[r["id"] for r in rows])
    finally:
        await db.close()


@router.get("/bookmarks/progress", response_model=ProgressOut)
async def get_progress():
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT status, COUNT(*) as cnt FROM bookmarks GROUP BY status"
        )
        counts = {r["status"]: r["cnt"] for r in rows}
        total = sum(counts.values())
        return ProgressOut(
            total=total,
            pending=counts.get("pending", 0),
            tagged=counts.get("tagged", 0),
            dead=counts.get("dead", 0),
            discarded=counts.get("discarded", 0),
        )
    finally:
        await db.close()


@router.get("/bookmarks/{bookmark_id}", response_model=BookmarkOut)
async def get_bookmark(bookmark_id: int):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)
        )
        if not rows:
            raise HTTPException(404, "Bookmark not found")
        return await _bookmark_with_tags(db, rows[0])
    finally:
        await db.close()


@router.patch("/bookmarks/{bookmark_id}", response_model=BookmarkOut)
async def patch_bookmark(bookmark_id: int, body: BookmarkPatch):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)
        )
        if not rows:
            raise HTTPException(404, "Bookmark not found")

        # Update fields that were provided
        updates = []
        params = []
        if body.custom_title is not None:
            updates.append("custom_title = ?")
            params.append(body.custom_title)
        if body.status is not None:
            if body.status not in ("pending", "tagged", "dead", "discarded"):
                raise HTTPException(400, f"Invalid status: {body.status}")
            updates.append("status = ?")
            params.append(body.status)

        if updates:
            params.append(bookmark_id)
            await db.execute(
                f"UPDATE bookmarks SET {', '.join(updates)} WHERE id = ?",
                params,
            )

        # Handle tags: delete-and-replace
        if body.tags is not None:
            await db.execute("DELETE FROM bookmark_tags WHERE bookmark_id = ?", (bookmark_id,))
            for tag_name in body.tags:
                tag_name = tag_name.strip().lower()
                if not tag_name:
                    continue
                # Get or create tag
                existing = await db.execute_fetchall(
                    "SELECT id FROM tags WHERE name = ?", (tag_name,)
                )
                if existing:
                    tag_id = existing[0]["id"]
                else:
                    cursor = await db.execute("INSERT INTO tags (name) VALUES (?)", (tag_name,))
                    tag_id = cursor.lastrowid
                await db.execute(
                    "INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)",
                    (bookmark_id, tag_id),
                )

            await db.commit()
        elif updates:
            await db.commit()

        # Re-fetch and return
        rows = await db.execute_fetchall(
            "SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)
        )
        return await _bookmark_with_tags(db, rows[0])
    finally:
        await db.close()
