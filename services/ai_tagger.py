import json
import os
import re

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "mistral")
AI_ENABLED = os.environ.get("AI_ENABLED", "true").lower() == "true"

PROMPT_TEMPLATE = """You are a bookmark tagging assistant. Given webpage metadata, suggest 1-4 short, lowercase tags for categorization.

Rules:
- Tags must be lowercase, single words or hyphenated (e.g., "machine-learning")
- Prefer REUSING existing tags from the list below when they fit
- Only suggest new tags if nothing in the existing list is a good match
- Return ONLY a JSON array of strings, nothing else

Existing tags in use: {existing_tags}

Webpage:
- URL: {url}
- Title: {title}
- Description: {description}

Respond with ONLY a JSON array like: ["tag1", "tag2", "tag3"]"""


def _parse_tag_response(text: str) -> list[str] | None:
    """Parse Ollama response into a list of tag strings. Returns None on failure."""
    # Try direct JSON parse
    try:
        result = json.loads(text.strip())
        if isinstance(result, list) and all(isinstance(t, str) for t in result):
            return [t.strip().lower() for t in result if t.strip()]
    except (json.JSONDecodeError, TypeError):
        pass

    # Regex fallback: find anything that looks like ["...", "..."]
    match = re.search(r'\[([^\]]+)\]', text)
    if match:
        try:
            result = json.loads(f"[{match.group(1)}]")
            if isinstance(result, list) and all(isinstance(t, str) for t in result):
                return [t.strip().lower() for t in result if t.strip()]
        except (json.JSONDecodeError, TypeError):
            pass

    return None


async def suggest_tags(
    url: str,
    title: str,
    description: str | None,
    existing_tags: list[str],
    client: httpx.AsyncClient,
) -> tuple[list[str] | None, str]:
    """
    Call Ollama to get tag suggestions for a bookmark.
    Returns (suggestions, status) where status is 'done' or 'failed'.
    """
    prompt = PROMPT_TEMPLATE.format(
        existing_tags=", ".join(existing_tags) if existing_tags else "(none yet)",
        url=url,
        title=title or "(no title)",
        description=description or "(no description)",
    )

    try:
        resp = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
            timeout=60.0,
        )
        resp.raise_for_status()
        data = resp.json()
        response_text = data.get("response", "")

        tags = _parse_tag_response(response_text)
        if tags:
            return tags, "done"
        else:
            return None, "failed"

    except Exception:
        # Per-bookmark failure (not global unreachable — that's checked at job level)
        return None, "failed"


async def check_ollama_available(client: httpx.AsyncClient) -> bool:
    """Check if Ollama is reachable."""
    try:
        resp = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5.0)
        return resp.status_code == 200
    except Exception:
        return False
