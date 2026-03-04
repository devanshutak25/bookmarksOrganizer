from urllib.parse import urlparse, urlencode, parse_qsl


def normalize_url(url: str) -> str:
    """
    Normalize URL for deduplication.
    Strips fragments, lowercases scheme+host, strips trailing slashes, sorts query params.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    host = parsed.netloc.lower()
    path = parsed.path.rstrip("/") or "/"
    if parsed.query:
        params = parse_qsl(parsed.query, keep_blank_values=True)
        sorted_query = urlencode(sorted(params))
    else:
        sorted_query = ""
    return f"{scheme}://{host}{path}" + (f"?{sorted_query}" if sorted_query else "")
