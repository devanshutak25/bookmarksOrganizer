from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from db import get_db
from models import TagOut

router = APIRouter()


class TagPatch(BaseModel):
    name: str


@router.get("/tags", response_model=list[TagOut])
async def get_tags():
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT t.id, t.name, COUNT(bt.bookmark_id) as count
               FROM tags t
               LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
               GROUP BY t.id
               ORDER BY count DESC, t.name ASC"""
        )
        return [TagOut(id=r["id"], name=r["name"], count=r["count"]) for r in rows]
    finally:
        await db.close()


@router.get("/tags/search", response_model=list[TagOut])
async def search_tags(q: str = Query(default="")):
    if not q.strip():
        return []
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT t.id, t.name, COUNT(bt.bookmark_id) as count
               FROM tags t
               LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
               WHERE t.name LIKE ?
               GROUP BY t.id
               ORDER BY count DESC, t.name ASC
               LIMIT 10""",
            (f"%{q.strip().lower()}%",),
        )
        return [TagOut(id=r["id"], name=r["name"], count=r["count"]) for r in rows]
    finally:
        await db.close()


@router.delete("/tags/{tag_id}")
async def delete_tag(tag_id: int):
    db = await get_db()
    try:
        rows = await db.execute_fetchall("SELECT 1 FROM tags WHERE id = ?", (tag_id,))
        if not rows:
            raise HTTPException(404, "Tag not found")
        # CASCADE deletes bookmark_tags and folder_tags entries
        await db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
        await db.commit()
        return {"deleted": True}
    finally:
        await db.close()


@router.patch("/tags/{tag_id}")
async def rename_tag(tag_id: int, body: TagPatch):
    new_name = body.name.strip().lower()
    if not new_name:
        raise HTTPException(400, "Tag name cannot be empty")

    db = await get_db()
    try:
        rows = await db.execute_fetchall("SELECT id, name FROM tags WHERE id = ?", (tag_id,))
        if not rows:
            raise HTTPException(404, "Tag not found")

        old_name = rows[0]["name"]
        if old_name == new_name:
            return {"id": tag_id, "name": new_name, "merged": False}

        # Check if target name already exists — if so, merge
        existing = await db.execute_fetchall(
            "SELECT id FROM tags WHERE name = ? AND id != ?", (new_name, tag_id)
        )

        if existing:
            target_id = existing[0]["id"]
            # Move all bookmark_tags from old tag to target, skipping duplicates
            await db.execute(
                """INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id)
                   SELECT bookmark_id, ? FROM bookmark_tags WHERE tag_id = ?""",
                (target_id, tag_id),
            )
            # Move folder_tags: if target already has a folder assignment, just delete the old one
            await db.execute("DELETE FROM folder_tags WHERE tag_id = ?", (tag_id,))
            # Delete the old tag (cascade cleans up remaining bookmark_tags)
            await db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
            await db.commit()
            return {"id": target_id, "name": new_name, "merged": True}
        else:
            # Simple rename
            await db.execute("UPDATE tags SET name = ? WHERE id = ?", (new_name, tag_id))
            await db.commit()
            return {"id": tag_id, "name": new_name, "merged": False}
    finally:
        await db.close()
