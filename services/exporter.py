from html import escape


def generate_bookmark_html(folder_tree: list[dict]) -> str:
    """
    Generate Netscape bookmark HTML format from folder tree.
    folder_tree structure matches /api/folders/preview output.
    """
    lines = [
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
        "<!-- This is an automatically generated file.",
        "     It will be parsed to restore the bookmarks. -->",
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        "<TITLE>Bookmarks</TITLE>",
        "<H1>Bookmarks</H1>",
        "<DL><p>",
    ]

    def render_folder(node, indent=1):
        prefix = "    " * indent
        lines.append(f'{prefix}<DT><H3>{escape(node["folder"])}</H3>')
        lines.append(f"{prefix}<DL><p>")
        for child in node.get("children", []):
            render_folder(child, indent + 1)
        for bm in node.get("bookmarks", []):
            title = escape(bm.get("custom_title") or bm["original_title"])
            href = escape(bm["url"])
            attrs = f'HREF="{href}"'
            if bm.get("add_date"):
                attrs += f' ADD_DATE="{bm["add_date"]}"'
            if bm.get("favicon"):
                attrs += f' ICON="{escape(bm["favicon"])}"'
            lines.append(f"{prefix}    <DT><A {attrs}>{title}</A>")
        lines.append(f"{prefix}</DL><p>")

    for folder in folder_tree:
        render_folder(folder)

    lines.append("</DL><p>")
    return "\n".join(lines)
