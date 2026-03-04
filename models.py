from pydantic import BaseModel


# --- Bookmarks ---

class BookmarkOut(BaseModel):
    id: int
    url: str
    original_title: str
    custom_title: str | None = None
    meta_title: str | None = None
    meta_description: str | None = None
    ai_suggestions: list[str] | None = None
    original_folder: str = ""
    add_date: int = 0
    favicon: str = ""
    status: str = "pending"
    tags: list[str] = []


class BookmarkPatch(BaseModel):
    custom_title: str | None = None
    status: str | None = None
    tags: list[str] | None = None


class BookmarkIdsOut(BaseModel):
    ids: list[int]


class BookmarkSummaryOut(BaseModel):
    id: int
    title: str
    url: str
    status: str


class BookmarkSummariesOut(BaseModel):
    items: list[BookmarkSummaryOut]


class ProgressOut(BaseModel):
    total: int
    pending: int
    tagged: int
    dead: int
    discarded: int


# --- Tags ---

class TagOut(BaseModel):
    id: int
    name: str
    count: int = 0


# --- Import ---

class ImportOut(BaseModel):
    imported: int
    duplicates_removed: int


# --- State ---

class JobStatus(BaseModel):
    total: int
    completed: int
    running: bool


class AppStateOut(BaseModel):
    has_bookmarks: bool
    progress: ProgressOut
    jobs: dict[str, JobStatus]
    duplicate_handling: str = "first"
