import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gpt-oss:20b")
AI_ENABLED = os.environ.get("AI_ENABLED", "true").lower() == "true"

SYSTEM_PROMPT = """You are a bookmark tagging assistant. Given webpage metadata, suggest 1-4 short, lowercase tags for categorization.

Rules:
- Tags must be lowercase, single words or hyphenated (e.g., "machine-learning")
- Prefer REUSING existing tags from the provided list when they fit
- Only suggest new tags if nothing in the existing list is a good match
- Return ONLY a JSON array of strings, nothing else"""

USER_TEMPLATE = """Existing tags in use: {existing_tags}

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
    Call Ollama chat API to get tag suggestions for a bookmark.
    Each call is a fresh chat conversation.
    Returns (suggestions, status) where status is 'done' or 'failed'.
    """
    user_message = USER_TEMPLATE.format(
        existing_tags=", ".join(existing_tags) if existing_tags else "(none yet)",
        url=url,
        title=title or "(no title)",
        description=description or "(no description)",
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    try:
        resp = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={"model": OLLAMA_MODEL, "messages": messages, "stream": False},
            timeout=httpx.Timeout(120.0),
        )
        resp.raise_for_status()
        data = resp.json()
        response_text = data.get("message", {}).get("content", "")
        logger.warning("Ollama response for %s: %s", url[:60], response_text[:200])

        tags = _parse_tag_response(response_text)
        if tags:
            return tags, "done"
        else:
            logger.warning("Failed to parse tags from: %s", response_text[:200])
            return None, "failed"

    except Exception as e:
        logger.error("Ollama chat error for %s: %s: %s", url[:60], type(e).__name__, e)
        return None, "failed"


async def check_ollama_available(client: httpx.AsyncClient) -> bool:
    """Check if Ollama is reachable."""
    try:
        resp = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5.0)
        return resp.status_code == 200
    except Exception:
        return False
