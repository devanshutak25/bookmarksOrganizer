import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_db

router = APIRouter()


# --- Models ---

class FolderCreate(BaseModel):
    name: str
    parent_id: int | None = None
    sort_order: int | None = None


class FolderPatch(BaseModel):
    name: str | None = None
    parent_id: int | None = None
    sort_order: int | None = None


class FolderReorderItem(BaseModel):
    id: int
    parent_id: int | None = None
    sort_order: int


class FolderReorderBody(BaseModel):
    items: list[FolderReorderItem]


class FolderTagsBody(BaseModel):
    tags: list[str]


# --- Helpers ---

async def _build_folder_tree(db) -> list[dict]:
    """Build the full folder tree with tags and bookmark counts."""
    folders = await db.execute_fetchall(
        "SELECT id, name, parent_id, sort_order FROM folders ORDER BY sort_order, id"
    )
    # Get tags per folder
    folder_tags = await db.execute_fetchall(
        "SELECT ft.folder_id, t.name FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id"
    )
    tags_by_folder: dict[int, list[str]] = {}
    for row in folder_tags:
        tags_by_folder.setdefault(row["folder_id"], []).append(row["name"])

    # Get bookmark count per folder via tag mapping
    # A bookmark counts for a folder if any of its tags are assigned to that folder
    bm_counts = await db.execute_fetchall(
        """SELECT ft.folder_id, COUNT(DISTINCT bt.bookmark_id) as cnt
           FROM folder_tags ft
           JOIN bookmark_tags bt ON bt.tag_id = ft.tag_id
           JOIN bookmarks b ON b.id = bt.bookmark_id
           WHERE b.status NOT IN ('dead', 'discarded')
           GROUP BY ft.folder_id"""
    )
    count_by_folder = {row["folder_id"]: row["cnt"] for row in bm_counts}

    # Build tree
    nodes = {}
    for f in folders:
        nodes[f["id"]] = {
            "id": f["id"],
            "name": f["name"],
            "parent_id": f["parent_id"],
            "sort_order": f["sort_order"],
            "tags": tags_by_folder.get(f["id"], []),
            "bookmark_count": count_by_folder.get(f["id"], 0),
            "children": [],
        }

    roots = []
    for f in folders:
        node = nodes[f["id"]]
        if f["parent_id"] and f["parent_id"] in nodes:
            nodes[f["parent_id"]]["children"].append(node)
        else:
            roots.append(node)

    return roots


async def _check_root_uniqueness(db, name: str, exclude_id: int | None = None):
    """Enforce root-level folder name uniqueness (SQLite NULL UNIQUE gap)."""
    sql = "SELECT 1 FROM folders WHERE name = ? AND parent_id IS NULL"
    params = [name]
    if exclude_id is not None:
        sql += " AND id != ?"
        params.append(exclude_id)
    rows = await db.execute_fetchall(sql, params)
    if rows:
        raise HTTPException(409, f"Root folder '{name}' already exists")


# --- Endpoints ---

@router.get("/folders")
async def get_folders():
    db = await get_db()
    try:
        return await _build_folder_tree(db)
    finally:
        await db.close()


@router.post("/folders", status_code=201)
async def create_folder(body: FolderCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Folder name cannot be empty")

    db = await get_db()
    try:
        # Root uniqueness check
        if body.parent_id is None:
            await _check_root_uniqueness(db, name)

        # Validate parent exists
        if body.parent_id is not None:
            rows = await db.execute_fetchall(
                "SELECT 1 FROM folders WHERE id = ?", (body.parent_id,)
            )
            if not rows:
                raise HTTPException(404, "Parent folder not found")

        # Default sort_order: append after existing siblings
        sort_order = body.sort_order
        if sort_order is None:
            if body.parent_id is None:
                rows = await db.execute_fetchall(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM folders WHERE parent_id IS NULL"
                )
            else:
                rows = await db.execute_fetchall(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM folders WHERE parent_id = ?",
                    (body.parent_id,),
                )
            sort_order = rows[0]["next_order"]

        cursor = await db.execute(
            "INSERT INTO folders (name, parent_id, sort_order) VALUES (?, ?, ?)",
            (name, body.parent_id, sort_order),
        )
        await db.commit()

        return {
            "id": cursor.lastrowid,
            "name": name,
            "parent_id": body.parent_id,
            "sort_order": sort_order,
            "tags": [],
            "bookmark_count": 0,
            "children": [],
        }
    finally:
        await db.close()


@router.patch("/folders/{folder_id}")
async def patch_folder(folder_id: int, body: FolderPatch):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT * FROM folders WHERE id = ?", (folder_id,)
        )
        if not rows:
            raise HTTPException(404, "Folder not found")

        updates = []
        params = []

        new_parent = rows[0]["parent_id"]
        if body.parent_id is not None or (body.parent_id is None and "parent_id" in body.model_fields_set):
            new_parent = body.parent_id

        if body.name is not None:
            name = body.name.strip()
            if not name:
                raise HTTPException(400, "Folder name cannot be empty")
            # Root uniqueness if moving to root or already at root
            if new_parent is None:
                await _check_root_uniqueness(db, name, exclude_id=folder_id)
            updates.append("name = ?")
            params.append(name)

        if "parent_id" in body.model_fields_set:
            if body.parent_id is not None:
                # Can't parent to self
                if body.parent_id == folder_id:
                    raise HTTPException(400, "Cannot parent a folder to itself")
                parent_rows = await db.execute_fetchall(
                    "SELECT 1 FROM folders WHERE id = ?", (body.parent_id,)
                )
                if not parent_rows:
                    raise HTTPException(404, "Parent folder not found")
            updates.append("parent_id = ?")
            params.append(body.parent_id)

        if body.sort_order is not None:
            updates.append("sort_order = ?")
            params.append(body.sort_order)

        if updates:
            params.append(folder_id)
            await db.execute(
                f"UPDATE folders SET {', '.join(updates)} WHERE id = ?", params
            )
            await db.commit()

        row = await db.execute_fetchall("SELECT * FROM folders WHERE id = ?", (folder_id,))
        tag_rows = await db.execute_fetchall(
            "SELECT t.name FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.folder_id = ?",
            (folder_id,),
        )
        return {
            "id": row[0]["id"],
            "name": row[0]["name"],
            "parent_id": row[0]["parent_id"],
            "sort_order": row[0]["sort_order"],
            "tags": [r["name"] for r in tag_rows],
        }
    finally:
        await db.close()


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: int):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT 1 FROM folders WHERE id = ?", (folder_id,)
        )
        if not rows:
            raise HTTPException(404, "Folder not found")

        # Reparent children to root with sequential sort_order
        children = await db.execute_fetchall(
            "SELECT id FROM folders WHERE parent_id = ?", (folder_id,)
        )
        if children:
            max_row = await db.execute_fetchall(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM folders WHERE parent_id IS NULL AND id != ?",
                (folder_id,),
            )
            next_order = max_row[0]["next_order"]
            for child in children:
                await db.execute(
                    "UPDATE folders SET parent_id = NULL, sort_order = ? WHERE id = ?",
                    (next_order, child["id"]),
                )
                next_order += 1

        # Delete folder (cascade removes folder_tags)
        await db.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        await db.commit()
        return {"deleted": True}
    finally:
        await db.close()


@router.put("/folders/reorder")
async def reorder_folders(body: FolderReorderBody):
    db = await get_db()
    try:
        for item in body.items:
            await db.execute(
                "UPDATE folders SET parent_id = ?, sort_order = ? WHERE id = ?",
                (item.parent_id, item.sort_order, item.id),
            )
        await db.commit()
        return {"updated": len(body.items)}
    finally:
        await db.close()


@router.post("/folders/{folder_id}/tags")
async def assign_tags_to_folder(folder_id: int, body: FolderTagsBody):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT 1 FROM folders WHERE id = ?", (folder_id,)
        )
        if not rows:
            raise HTTPException(404, "Folder not found")

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

            # Remove from any existing folder (tag can only belong to one folder)
            await db.execute("DELETE FROM folder_tags WHERE tag_id = ?", (tag_id,))
            # Assign to this folder
            await db.execute(
                "INSERT INTO folder_tags (folder_id, tag_id) VALUES (?, ?)",
                (folder_id, tag_id),
            )

        await db.commit()

        tag_rows = await db.execute_fetchall(
            "SELECT t.name FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.folder_id = ?",
            (folder_id,),
        )
        return {"tags": [r["name"] for r in tag_rows]}
    finally:
        await db.close()


@router.get("/folders/preview")
async def preview_export():
    db = await get_db()
    try:
        # Get duplicate_handling setting
        setting_row = await db.execute_fetchall(
            "SELECT value FROM settings WHERE key = 'duplicate_handling'"
        )
        dup_handling = "first"
        if setting_row:
            try:
                dup_handling = json.loads(setting_row[0]["value"])
            except Exception:
                pass

        # Get all folders ordered by sort_order, id
        folders = await db.execute_fetchall(
            "SELECT id, name, parent_id, sort_order FROM folders ORDER BY sort_order, id"
        )

        # Get folder->tag mappings
        folder_tag_rows = await db.execute_fetchall(
            "SELECT ft.folder_id, ft.tag_id FROM folder_tags ft"
        )
        # tag_id -> folder_id (one-to-one due to UNIQUE(tag_id))
        tag_to_folder: dict[int, int] = {r["tag_id"]: r["folder_id"] for r in folder_tag_rows}
        # folder_id -> [tag_ids]
        folder_to_tags: dict[int, list[int]] = {}
        for r in folder_tag_rows:
            folder_to_tags.setdefault(r["folder_id"], []).append(r["tag_id"])

        # Get all active bookmarks with their tags
        bm_rows = await db.execute_fetchall(
            """SELECT b.id, b.url, b.original_title, b.custom_title, b.add_date, b.favicon
               FROM bookmarks b
               WHERE b.status NOT IN ('dead', 'discarded')
               ORDER BY b.id"""
        )

        bm_tag_rows = await db.execute_fetchall(
            """SELECT bt.bookmark_id, bt.tag_id
               FROM bookmark_tags bt
               JOIN bookmarks b ON b.id = bt.bookmark_id
               WHERE b.status NOT IN ('dead', 'discarded')"""
        )
        bm_to_tags: dict[int, list[int]] = {}
        for r in bm_tag_rows:
            bm_to_tags.setdefault(r["bookmark_id"], []).append(r["tag_id"])

        # Place bookmarks into folders
        # folder_id -> [bookmark dicts]
        folder_bookmarks: dict[int, list[dict]] = {f["id"]: [] for f in folders}
        unassigned: list[dict] = []
        placed_ids: set[int] = set()  # track for "first" mode

        # Build a folder sort key for "first matching folder" logic
        # Sort key: (sort_order, id) — but we need the effective ordering
        folder_order: dict[int, int] = {}
        for idx, f in enumerate(folders):
            folder_order[f["id"]] = idx

        for bm in bm_rows:
            bm_dict = {
                "id": bm["id"],
                "url": bm["url"],
                "original_title": bm["original_title"],
                "custom_title": bm["custom_title"],
                "add_date": bm["add_date"],
                "favicon": bm["favicon"],
            }
            bm_tags = bm_to_tags.get(bm["id"], [])
            if not bm_tags:
                unassigned.append(bm_dict)
                continue

            # Find matching folders for this bookmark's tags
            matching_folders: set[int] = set()
            for tid in bm_tags:
                if tid in tag_to_folder:
                    matching_folders.add(tag_to_folder[tid])

            if not matching_folders:
                unassigned.append(bm_dict)
                continue

            if dup_handling == "duplicate":
                for fid in matching_folders:
                    folder_bookmarks[fid].append(bm_dict)
            else:
                # "first" — place in the first matching folder by sort order
                first_fid = min(matching_folders, key=lambda fid: folder_order.get(fid, 999999))
                folder_bookmarks[first_fid].append(bm_dict)

        # Build tree structure for response
        nodes: dict[int, dict] = {}
        for f in folders:
            nodes[f["id"]] = {
                "folder": f["name"],
                "children": [],
                "bookmarks": folder_bookmarks.get(f["id"], []),
            }

        roots = []
        for f in folders:
            node = nodes[f["id"]]
            if f["parent_id"] and f["parent_id"] in nodes:
                nodes[f["parent_id"]]["children"].append(node)
            else:
                roots.append(node)

        if unassigned:
            roots.append({
                "folder": "_Unassigned",
                "children": [],
                "bookmarks": unassigned,
            })

        return roots
    finally:
        await db.close()
