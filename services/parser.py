from bs4 import BeautifulSoup

from services.url_utils import normalize_url


def parse_bookmark_html(html_content: str) -> list[dict]:
    """
    Parse a Netscape-format bookmark HTML file.
    Uses a parent-map approach: maps each <DL> to its folder name via the preceding <H3>.
    """
    soup = BeautifulSoup(html_content, "html.parser")

    # Build parent-map: map each <DL> element to its folder name
    dl_to_folder: dict[int, str] = {}
    for dl in soup.find_all("dl"):
        parent_dt = dl.parent if dl.parent and dl.parent.name == "dt" else None
        if parent_dt:
            h3 = parent_dt.find("h3", recursive=False)
            if h3:
                dl_to_folder[id(dl)] = h3.get_text(strip=True)

    bookmarks = []
    seen_urls: set[str] = set()
    duplicates = 0

    for a_tag in soup.find_all("a"):
        href = a_tag.get("href", "").strip()
        if not href or href.startswith("javascript:") or href.startswith("place:"):
            continue

        normalized = normalize_url(href)

        if normalized in seen_urls:
            duplicates += 1
            continue
        seen_urls.add(normalized)

        # Walk up the tree collecting folder names
        folders = []
        node = a_tag.parent
        while node:
            if node.name == "dl" and id(node) in dl_to_folder:
                folders.append(dl_to_folder[id(node)])
            node = node.parent
        folders.reverse()
        folder_path = "/".join(folders) if folders else ""

        title = a_tag.get_text(strip=True)
        if not title:
            # Fallback: use URL hostname as title
            from urllib.parse import urlparse
            title = urlparse(normalized).netloc or normalized

        bookmarks.append({
            "url": normalized,
            "original_title": title,
            "add_date": int(a_tag.get("add_date", 0) or 0),
            "favicon": a_tag.get("icon", ""),
            "original_folder": folder_path,
        })

    return bookmarks, duplicates
