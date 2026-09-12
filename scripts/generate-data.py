#!/usr/bin/env python3
"""Generate directive data for the systemd VS Code extension.

Parses the systemd man page XML sources and emits, for each checkout given on
the command line, a versioned data file data/directives-v<N>.json describing
every configuration directive, the section it belongs to, its man page
reference, a short summary, and (when easily detectable) the set of allowed
values. A data/manifest.json listing all supported versions is also written.

Usage:
    python3 scripts/generate-data.py [PATH_TO_SYSTEMD_REPO ...]

Each argument is a systemd source checkout; its version is read from
meson.version. When no arguments are given, the sibling directory ../systemd
is used.
"""

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ENTITY_DEF_RE = re.compile(r'<!ENTITY\s+(\w+)\s+"([^"]*)"')
ENTITY_USE_RE = re.compile(r"&(\w+);")
JINJA_RE = re.compile(r"\{\{.*?\}\}")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Variablelist classes that contain configuration directives we care about.
DIRECTIVE_CLASSES = {
    "unit-directives",
    "network-directives",
    "config-directives",
    "nspawn-directives",
    "home-directives",
}

# Man pages whose directives live in a single "Options" section: map the page
# name to the unit/config section(s) its directives belong to.  Pages that use
# explicit "[Section] Options" titles (e.g. systemd.unit, systemd.network,
# systemd.netdev, systemd.link, systemd.nspawn, networkd.conf) are handled
# automatically by parsing the title.
PAGE_DEFAULT_SECTIONS = {
    # unit file man pages
    "systemd.service": ["Service"],
    "systemd.exec": ["Service", "Socket", "Mount", "Swap"],
    "systemd.kill": ["Service", "Socket", "Mount", "Swap"],
    "systemd.resource-control": ["Slice", "Scope", "Service", "Socket", "Mount", "Swap"],
    "systemd.socket": ["Socket"],
    "systemd.timer": ["Timer"],
    "systemd.path": ["Path"],
    "systemd.mount": ["Mount"],
    "systemd.swap": ["Swap"],
    "systemd.slice": ["Slice"],
    "systemd.scope": ["Scope"],
    "systemd.automount": ["Automount"],
    # daemon/service configuration files
    "coredump.conf": ["Coredump"],
    "homed.conf": ["Home"],
    "iocost.conf": ["IOCost"],
    "journald.conf": ["Journal"],
    "journal-remote.conf": ["Remote"],
    "journal-upload.conf": ["Upload"],
    "logind.conf": ["Login"],
    "pstore.conf": ["PStore"],
    "resolved.conf": ["Resolve"],
    "sysext.conf": ["Extension"],
    "systemd-sleep.conf": ["Sleep"],
    "systemd-system.conf": ["Manager"],
    "timesyncd.conf": ["Time"],
    "udev.conf": ["Udev"],
}

# Unit file extension -> [Section] names that apply to that unit type.
UNIT_FILE_TYPES = {
    "service": ["Unit", "Install", "Service"],
    "socket": ["Unit", "Install", "Socket"],
    "timer": ["Unit", "Install", "Timer"],
    "path": ["Unit", "Install", "Path"],
    "mount": ["Unit", "Install", "Mount"],
    "swap": ["Unit", "Install", "Swap"],
    "automount": ["Unit", "Install", "Automount"],
    "target": ["Unit", "Install"],
    "slice": ["Unit", "Install", "Slice"],
    "scope": ["Unit", "Install", "Scope"],
    "device": ["Unit", "Install"],
}

# Man page -> data scope its directives belong to.
SCOPE_ROUTING = {
    "systemd.unit": "unit",
    "systemd.service": "unit",
    "systemd.exec": "unit",
    "systemd.kill": "unit",
    "systemd.resource-control": "unit",
    "systemd.socket": "unit",
    "systemd.timer": "unit",
    "systemd.path": "unit",
    "systemd.mount": "unit",
    "systemd.swap": "unit",
    "systemd.slice": "unit",
    "systemd.scope": "unit",
    "systemd.automount": "unit",
    "systemd.network": "network",
    "systemd.netdev": "netdev",
    "systemd.link": "link",
    "systemd.nspawn": "nspawn",
    "systemd.dnssd": "dnssd",
    "systemd.dns-delegate": "dns-delegate",
}

# Man pages that should be ignored entirely (no INI-style directives).
SKIP_PAGES = {
    "systemd.device",  # udev rules, not unit directives
    "crypttab",
    "user-system-options",  # command line options
    "directives-template",
    "common-variables",
    "tc",  # shared qdisc fragment, already covered by systemd.network
}

# config file name -> man page (used to build configFiles).  systemd-system.conf
# documents both system.conf and user.conf.
CONFIG_FILES = {
    "system.conf": "systemd-system.conf",
    "user.conf": "systemd-system.conf",
    "coredump.conf": "coredump.conf",
    "homed.conf": "homed.conf",
    "iocost.conf": "iocost.conf",
    "journald.conf": "journald.conf",
    "journal-remote.conf": "journal-remote.conf",
    "journal-upload.conf": "journal-upload.conf",
    "logind.conf": "logind.conf",
    "oomd.conf": "oomd.conf",
    "pstore.conf": "pstore.conf",
    "resolved.conf": "resolved.conf",
    "sleep.conf": "systemd-sleep.conf",
    "sysext.conf": "sysext.conf",
    "timesyncd.conf": "timesyncd.conf",
    "udev.conf": "udev.conf",
    "networkd.conf": "networkd.conf",
    "repart.d": "repart.d",
}

# Config file man pages (routed to a per-file scope "config:<page>").
CONFIG_PAGES = set(CONFIG_FILES.values())

# Value detection
BOOLEAN_RE = re.compile(r"\bboolean\b|\bbool\b", re.IGNORECASE)
ONE_OF_RE = re.compile(r"one of\s*[^.]*", re.IGNORECASE)
SPECIAL_VALUES_RE = re.compile(r"special values?", re.IGNORECASE)
SECTION_RE = re.compile(r"\[([^\]]+)\]\s*Section Options")
INTRO_RE = re.compile(r"(?:if|when) set to\s*$", re.IGNORECASE)
BOUNDARY_RE = re.compile(r"(?:if|when) set to", re.IGNORECASE)

# Boolean values are self-explanatory: they get no per-value description.
BOOLEAN_VALUES = {"yes", "no", "true", "false", "on", "off"}

# XInclude element (namespaced) used for "Added in version X" notes.
XI_INCLUDE = "{http://www.w3.org/2001/XInclude}include"

# DocBook inline tags rendered as markdown code spans.
INLINE_CODE_TAGS = {
    "varname", "option", "literal", "filename", "command", "constant",
    "function", "keycap", "code", "symbol", "varlistentry",
}

# Maximum length of the hover summary, in characters.
SUMMARY_MAX = 800


def _localname(tag):
    """Strip an XML namespace, returning the bare element name."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _collapse(s):
    """Collapse whitespace runs in inline text to single spaces."""
    return re.sub(r"\s+", " ", s).strip()


def _render_children(elem):
    """Render an element's children (plus text/tail) to markdown fragments."""
    parts = []
    if elem.text:
        parts.append(elem.text)
    for child in elem:
        parts.append(render_markdown(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def render_markdown(elem):
    """Convert a DocBook element subtree to a compact markdown string."""
    tag = _localname(elem.tag)

    if tag == "para":
        return _collapse(_render_children(elem)) + "\n\n"

    if tag == "itemizedlist":
        out = []
        for li in elem.findall("listitem"):
            out.append("- " + _collapse(_render_children(li)) + "\n")
        return "".join(out) + "\n"

    if tag == "orderedlist":
        out = []
        for i, li in enumerate(elem.findall("listitem"), 1):
            out.append(f"{i}. " + _collapse(_render_children(li)) + "\n")
        return "".join(out) + "\n"

    if tag == "listitem":
        return _render_children(elem)

    if tag == "emphasis":
        return "*" + _collapse(_render_children(elem)) + "*"

    if tag == "ulink":
        url = elem.get("url", "")
        return f"[{_collapse(_render_children(elem))}]({url})"

    if tag == "citerefentry":
        title = elem.findtext("refentrytitle", "")
        vol = elem.findtext("manvolnum", "")
        return f"`{title}({vol})`" if vol else f"`{title}`"

    if tag == "replaceable":
        return _collapse(_render_children(elem))

    if tag in INLINE_CODE_TAGS:
        return "`" + _collapse(_render_children(elem)) + "`"

    # Fallback: render children as-is.
    return _render_children(elem)


def summary_markdown(listitem):
    """Render the first non-empty paragraph(s) of a <listitem> as markdown."""
    parts = []
    for para in listitem.findall("para"):
        md = render_markdown(para).strip()
        if md:
            parts.append(md)
        if sum(len(p) for p in parts) >= SUMMARY_MAX:
            break
    text = "\n\n".join(parts).strip()
    if len(text) > SUMMARY_MAX:
        text = text[: SUMMARY_MAX - 3].rstrip() + "..."
    return text


def added_version(listitem):
    """Return the "Added in version X" number, or None.

    systemd marks this with <xi:include href="version-info.xml" xpointer="vX"/>.
    """
    for elem in listitem.iter():
        if elem.tag == XI_INCLUDE and elem.get("href") == "version-info.xml":
            xp = elem.get("xpointer", "")
            m = re.match(r"v(\d+)", xp)
            if m:
                return m.group(1)
    return None


def strip_tags(elem):
    """Return the plain-text content of an XML element."""
    parts = []
    for text in elem.itertext():
        parts.append(text)
    return " ".join("".join(parts).split())


def directive_names(term):
    """Extract directive names from a <term> element.

    A term looks like <varname>Type=</varname> or, for shared descriptions,
    contains several <varname> entries.  Trailing '=' and inline
    <replaceable> placeholders are stripped.
    """
    names = []
    for varname in term.findall("varname"):
        text = strip_tags(varname)
        text = re.sub(r"=.*$", "", text).strip()
        text = re.sub(r"<.*?>", "", text)  # remove any leftover markup
        if text:
            names.append(text)
    return names


def enum_values(listitem):
    """Best-effort extraction of allowed values for a directive.

    Recognizes two common phrasings and collects the <option>/<literal> values
    they introduce:
      * "One of a, b, c"                     -> a, b, c
      * "Takes a boolean or special value(s) X or Y" -> X, Y (boolean added separately)
    """
    values = []
    for para in listitem.findall("para"):
        raw = "".join(para.itertext())
        if ONE_OF_RE.search(raw) or SPECIAL_VALUES_RE.search(raw):
            for tag in ("option", "literal"):
                for el in para.iter(tag):
                    v = strip_tags(el).strip()
                    if v and v not in values:
                        values.append(v)
    return values


def _inline_tokens(para):
    """Flatten a <para>'s inline content into a token list.

    Returns [("text", str) | ("value", str) | ("md", str)] where:
      - "text" is raw prose (may contain "If set to" boundaries);
      - "value" is the plain value of an <option>/<literal>;
      - "md" is the rendered markdown of any other inline element.
    """
    tokens = []
    if para.text:
        tokens.append(("text", para.text))
    for child in para:
        tag = _localname(child.tag)
        if tag in ("option", "literal"):
            tokens.append(("value", strip_tags(child).strip()))
        else:
            tokens.append(("md", render_markdown(child)))
        if child.tail:
            tokens.append(("text", child.tail))
    return tokens


def _cleanup_desc(text):
    """Trim leading "(the default)", punctuation and whitespace from a value description."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^\s*(?:\((?:the\s+)?default\))?\s*[,;:]?\s*", "", text)
    return text.strip()


def _find_value_desc(listitem, value):
    """Find and return the markdown description of a single value.

    systemd man pages explain a value as "If set to X, ..." (or "When set to
    X, ...").  We locate that phrasing, then capture the prose up to the next
    "If/When set to" boundary, preserving inline markdown.
    """
    for para in listitem.iter("para"):
        tokens = _inline_tokens(para)
        n = len(tokens)
        for i in range(n):
            if tokens[i][0] != "value" or tokens[i][1] != value:
                continue
            if i == 0 or tokens[i - 1][0] != "text" or not INTRO_RE.search(tokens[i - 1][1]):
                continue
            parts = []
            for j in range(i + 1, n):
                kind, payload = tokens[j]
                if kind == "text":
                    sp = BOUNDARY_RE.split(payload, maxsplit=1)
                    parts.append(sp[0])
                    if len(sp) > 1:
                        break
                else:
                    parts.append(payload)
            desc = _cleanup_desc("".join(parts))
            if desc:
                return desc
    return None


def value_descriptions(listitem, values, is_boolean):
    """Return a {value: markdown description} map for the enumerable values.

    Boolean values are skipped only when the directive actually takes a
    boolean (e.g. `ProtectSystem=`), so an enum value that happens to be the
    string "no"/"off" (e.g. `Restart=no`) still gets described.
    """
    target = [v for v in values if not (is_boolean and v in BOOLEAN_VALUES)]
    if not target:
        return {}
    docs = {}
    for value in target:
        desc = _find_value_desc(listitem, value)
        if desc:
            docs[value] = desc
    return docs


def build_parent_map(root):
    """Return a dict mapping each element to its parent element."""
    parents = {}
    for parent in root.iter():
        for child in parent:
            parents[child] = parent
    return parents


def section_for(variablelist, parents, page_default):
    """Determine the [Section] a variablelist belongs to.

    Walk up the ancestor tree looking for a title of the form
    "[Section] Section Options".  If none is found, use the page default.
    """
    node = variablelist
    while node is not None:
        if node.tag in ("refsect1", "refsect2"):
            title = node.find("title")
            if title is not None:
                text = strip_tags(title)
                m = SECTION_RE.search(text)
                if m:
                    return m.group(1)
        node = parents.get(node)
    return page_default


def load_entities(man_dir):
    """Load custom entities from custom-entities.ent.in.

    Jinja placeholders are resolved to the entity name itself (readable enough
    for documentation summaries); plain values are used verbatim.
    """
    entities = {}
    ent_file = man_dir / "custom-entities.ent.in"
    if ent_file.is_file():
        for name, value in ENTITY_DEF_RE.findall(ent_file.read_text(encoding="utf-8")):
            if JINJA_RE.search(value):
                value = name
            entities[name] = value
    return entities


def preprocess(xml_text, entities):
    """Resolve custom entities so the XML can be parsed with ElementTree."""
    def replace(m):
        name = m.group(1)
        if name in entities:
            val = entities[name]
            return val.replace("&", "&amp;").replace("<", "&lt;")
        return m.group(0)  # leave unknown/standard entities alone
    return ENTITY_USE_RE.sub(replace, xml_text)


def parse_page(path, page_default_sections, entities):
    """Parse one man page and return a dict: section -> list of directives."""
    raw = path.read_text(encoding="utf-8")
    tree = ET.ElementTree(ET.fromstring(preprocess(raw, entities)))
    root = tree.getroot()

    refmeta = root.find(".//refmeta")
    man_page = None
    man_volume = None
    if refmeta is not None:
        entry = refmeta.find("refentrytitle")
        if entry is not None and entry.text:
            man_page = entry.text.strip()
        vol = refmeta.find("manvolnum")
        if vol is not None and vol.text:
            man_volume = vol.text.strip()

    if man_page is None:
        man_page = path.stem

    parents = build_parent_map(root)

    directives_by_section = {}
    for variablelist in root.iter("variablelist"):
        klass = variablelist.get("class")
        if klass not in DIRECTIVE_CLASSES:
            continue
        section = section_for(variablelist, parents, None)
        target_sections = [section] if section is not None else page_default_sections
        if not target_sections:
            continue

        for varlistentry in variablelist.findall("varlistentry"):
            listitem = varlistentry.find("listitem")
            if listitem is None:
                continue
            # A varlistentry may document several directives across multiple
            # <term> elements (e.g. <term>Before=</term><term>After=</term>).
            names = []
            for term in varlistentry.findall("term"):
                names.extend(directive_names(term))
            if not names:
                continue
            summary = summary_markdown(listitem)
            values = enum_values(listitem)
            full_text = " ".join(listitem.itertext())
            is_boolean = BOOLEAN_RE.search(full_text) is not None
            if is_boolean:
                # "Takes a boolean" (possibly "or the special values X or Y"):
                # boolean values are always valid, so merge them in.
                for v in ("yes", "no", "true", "false", "on", "off"):
                    if v not in values:
                        values.append(v)
            added = added_version(listitem)
            docs = value_descriptions(listitem, values, is_boolean)
            for name in names:
                for s in target_sections:
                    entry = {
                        "name": name,
                        "manPage": man_page,
                        "manVolume": man_volume or "",
                        "summary": summary,
                        "values": values,
                        "addedIn": added or "",
                    }
                    if docs:
                        entry["valueDocs"] = docs
                    directives_by_section.setdefault(s, []).append(entry)
    return directives_by_section


def merge_directives(directives):
    """Deduplicate directives within a section, merging value sets."""
    by_name = {}
    for d in directives:
        existing = by_name.get(d["name"])
        if existing is None:
            by_name[d["name"]] = dict(d)
        else:
            merged = set(existing.get("values") or [])
            merged.update(d.get("values") or [])
            existing["values"] = sorted(merged)
            if not existing["summary"] and d["summary"]:
                existing["summary"] = d["summary"]
            if not existing.get("addedIn") and d.get("addedIn"):
                existing["addedIn"] = d["addedIn"]
            merged_docs = dict(existing.get("valueDocs") or {})
            for k, v in (d.get("valueDocs") or {}).items():
                if k not in merged_docs:
                    merged_docs[k] = v
            if merged_docs:
                existing["valueDocs"] = merged_docs
    result = list(by_name.values())
    result.sort(key=lambda d: d["name"].lower())
    return result


def version_key(repo):
    """Return the leading numeric part of meson.version (e.g. '262')."""
    version_file = repo / "meson.version"
    if not version_file.is_file():
        return "unknown"
    text = version_file.read_text().strip()
    m = re.match(r"\d+", text)
    return m.group(0) if m else "unknown"


def build_data(repo, man_dir):
    """Parse one systemd checkout and return the directives data dict."""
    version = version_key(repo)
    version_file = repo / "meson.version"
    full_version = version_file.read_text().strip() if version_file.is_file() else version
    entities = load_entities(man_dir)

    scopes = {}  # scope name -> {sections: {section -> [directives]}}
    for xml in sorted(man_dir.glob("*.xml")):
        page = xml.stem
        if page in SKIP_PAGES:
            continue
        if page in SCOPE_ROUTING:
            scope = SCOPE_ROUTING[page]
        elif page in CONFIG_PAGES:
            scope = f"config:{page}"
        else:
            continue
        defaults = PAGE_DEFAULT_SECTIONS.get(page, [])
        parsed = parse_page(xml, defaults, entities)
        if not parsed:
            continue
        scope_data = scopes.setdefault(scope, {"sections": {}})
        for section, directives in parsed.items():
            scope_data["sections"].setdefault(section, [])
            scope_data["sections"][section].extend(directives)

    # Deduplicate and sort every section of every scope.
    for scope in scopes.values():
        for section in scope["sections"]:
            scope["sections"][section] = merge_directives(scope["sections"][section])

    def scope_sections(scope):
        data = scopes.get(scope, {})
        return sorted(data.get("sections", {}).keys())

    # Build fileTypes: unit types + network/netdev/link/nspawn/dnssd/dns-delegate.
    file_types = {}
    for ext, secs in UNIT_FILE_TYPES.items():
        file_types[ext] = {
            "scope": "unit",
            "sections": secs,
            "doc": f"systemd.{ext}",
        }
    for ext, scope, doc in (
        ("network", "network", "systemd.network"),
        ("netdev", "netdev", "systemd.netdev"),
        ("link", "link", "systemd.link"),
        ("nspawn", "nspawn", "systemd.nspawn"),
        ("dnssd", "dnssd", "systemd.dnssd"),
        ("dns-delegate", "dns-delegate", "systemd.dns-delegate"),
    ):
        file_types[ext] = {
            "scope": scope,
            "sections": scope_sections(scope),
            "doc": doc,
        }

    # Build filenames (daemon/config files).
    filenames = {}
    for filename, page in CONFIG_FILES.items():
        scope = f"config:{page}"
        filenames[filename] = {
            "scope": scope,
            "sections": scope_sections(scope),
            "doc": page,
        }

    data = {
        "version": 1,
        "generatedFrom": f"systemd-{full_version}",
        "scopes": scopes,
        "fileTypes": file_types,
        "filenames": filenames,
    }

    total = sum(len(d["sections"].get(s, [])) for d in scopes.values()
                for s in d["sections"])
    return data, total


def _version_sort_key(entry):
    v = entry["version"]
    try:
        return int(v)
    except ValueError:
        return -1


def main():
    repos = [Path(a) for a in sys.argv[1:]]
    if not repos:
        repos = [Path(__file__).resolve().parents[2] / "systemd"]

    out_dir = Path(__file__).resolve().parent.parent / "data"
    out_dir.mkdir(exist_ok=True)

    entries = []
    for repo in repos:
        man_dir = repo / "man"
        if not man_dir.is_dir():
            print(f"error: man directory not found: {man_dir}", file=sys.stderr)
            sys.exit(1)
        key = version_key(repo)
        data, total = build_data(repo, man_dir)
        out_file = out_dir / f"directives-v{key}.json"
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        entries.append({
            "version": key,
            "file": out_file.name,
            "generatedFrom": data["generatedFrom"],
        })
        print(f"wrote {out_file}  ({total} directives)")

    entries.sort(key=_version_sort_key)
    manifest = {"versions": entries}
    manifest_file = out_dir / "manifest.json"
    with open(manifest_file, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {manifest_file}  (supported versions: "
          f"{', '.join(e['version'] for e in entries)})")


if __name__ == "__main__":
    main()
