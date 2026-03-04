from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_db

router = APIRouter()


class ResetBody(BaseModel):
    confirm: bool = False


@router.post("/reset")
async def reset_all(body: ResetBody):
    if not body.confirm:
        raise HTTPException(400, "Must confirm reset with {\"confirm\": true}")

    db = await get_db()
    try:
        await db.execute("DELETE FROM bookmark_tags")
        await db.execute("DELETE FROM folder_tags")
        await db.execute("DELETE FROM bookmarks")
        await db.execute("DELETE FROM tags")
        await db.execute("DELETE FROM folders")
        await db.execute("DELETE FROM settings")
        await db.commit()
        return {"reset": True}
    finally:
        await db.close()
