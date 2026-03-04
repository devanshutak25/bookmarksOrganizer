import httpx
from bs4 import BeautifulSoup


async def scrape_metadata(url: str, client: httpx.AsyncClient) -> dict:
    """
    Fetch a URL and extract title + description metadata.
    Uses the shared httpx.AsyncClient (timeout=10s, max_redirects=5).
    Parses only the first 50KB of HTML for performance.
    """
    try:
        resp = await client.get(url)

        if resp.status_code >= 400:
            return {"meta_title": "[UNREACHABLE]", "meta_description": None}

        content_type = resp.headers.get("content-type", "")
        if "text/html" not in content_type:
            return {"meta_title": None, "meta_description": None}

        # Parse only first 50KB — metadata is always in <head>
        html_snippet = resp.text[:51200]
        soup = BeautifulSoup(html_snippet, "html.parser")

        # Title: prefer og:title > title tag
        og_title = soup.find("meta", property="og:title")
        title_tag = soup.find("title")
        meta_title = None
        if og_title and og_title.get("content"):
            meta_title = og_title["content"].strip()
        elif title_tag and title_tag.string:
            meta_title = title_tag.string.strip()

        # Description: prefer og:description > meta description
        og_desc = soup.find("meta", property="og:description")
        meta_desc = soup.find("meta", attrs={"name": "description"})
        meta_description = None
        if og_desc and og_desc.get("content"):
            meta_description = og_desc["content"].strip()
        elif meta_desc and meta_desc.get("content"):
            meta_description = meta_desc["content"].strip()

        return {"meta_title": meta_title, "meta_description": meta_description}

    except Exception:
        return {"meta_title": "[UNREACHABLE]", "meta_description": None}
