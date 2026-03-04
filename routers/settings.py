import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_db

router = APIRouter()


class SettingPatch(BaseModel):
    value: str


@router.get("/settings/{key}")
async def get_setting(key: str):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT value FROM settings WHERE key = ?", (key,)
        )
        if not rows:
            raise HTTPException(404, f"Setting '{key}' not found")
        return {"key": key, "value": json.loads(rows[0]["value"])}
    finally:
        await db.close()


@router.patch("/settings/{key}")
async def patch_setting(key: str, body: SettingPatch):
    if key == "duplicate_handling" and body.value not in ("first", "duplicate"):
        raise HTTPException(400, "duplicate_handling must be 'first' or 'duplicate'")

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
            (key, json.dumps(body.value), json.dumps(body.value)),
        )
        await db.commit()
        return {"key": key, "value": body.value}
    finally:
        await db.close()
