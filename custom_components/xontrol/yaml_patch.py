"""Targeted, comment-safe editing of the alexa: smart_home: filter:
include_entities: list inside configuration.yaml.

This intentionally does NOT do a full YAML round-trip. configuration.yaml
uses `!include` tags and hand-written comment banners that a generic YAML
load/dump would either choke on or silently discard -- the same risk that
was hit and fixed by hand during the original 2026-07-26 Alexa connector
troubleshooting session (see controlroom_session_2026-07-26.md). Instead
this locates the alexa: -> smart_home: -> filter: -> include_entities:
block purely by indentation and only rewrites the entity-list lines inside
it, leaving every other line in the file byte-for-byte untouched.
"""

from __future__ import annotations


class AlexaBlockNotFound(RuntimeError):
    """Raised when the alexa: smart_home: filter: include_entities: block
    can't be located in configuration.yaml."""


def _leading_spaces(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _find_child_line(lines: list[str], start: int, key: str) -> int:
    """Find the next line at a deeper indent than `lines[start]` whose
    stripped content starts with `key:`. Stops if indentation dedents back
    to `lines[start]`'s level or shallower before finding it."""
    base_indent = _leading_spaces(lines[start])
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if not line.strip():
            continue
        indent = _leading_spaces(line)
        if indent <= base_indent:
            break
        if line.strip().startswith(f"{key}:"):
            return i
    raise AlexaBlockNotFound(f"could not find '{key}:' under line {start + 1}")


def _extract_scalar_value(line: str, key: str) -> str:
    value = line.strip()[len(f"{key}:") :].strip()
    return value.strip('"').strip("'")


def read_alexa_config(config_yaml_text: str) -> dict:
    """Parses just enough of configuration.yaml to locate the alexa block.

    Returns a dict with client_id, client_secret, include_entities (list[str]),
    plus private line-index bookkeeping (_include_idx, _include_end_idx,
    _item_indent) used by patch_include_entities().
    """
    lines = config_yaml_text.splitlines()

    alexa_idx = next((i for i, l in enumerate(lines) if l.rstrip() == "alexa:"), None)
    if alexa_idx is None:
        raise AlexaBlockNotFound("no top-level 'alexa:' key in configuration.yaml")

    smart_home_idx = _find_child_line(lines, alexa_idx, "smart_home")
    client_id_idx = _find_child_line(lines, smart_home_idx, "client_id")
    client_secret_idx = _find_child_line(lines, smart_home_idx, "client_secret")
    filter_idx = _find_child_line(lines, smart_home_idx, "filter")
    include_idx = _find_child_line(lines, filter_idx, "include_entities")

    include_indent = _leading_spaces(lines[include_idx])
    item_indent = include_indent + 2  # fallback used only if the list is currently empty
    entities: list[str] = []
    end_idx = include_idx + 1
    for i in range(include_idx + 1, len(lines)):
        line = lines[i]
        if not line.strip():
            end_idx = i
            continue
        indent = _leading_spaces(line)
        if indent <= include_indent or not line.strip().startswith("- "):
            break
        item_indent = indent
        entities.append(line.strip()[2:].strip())
        end_idx = i + 1

    return {
        "client_id": _extract_scalar_value(lines[client_id_idx], "client_id"),
        "client_secret": _extract_scalar_value(lines[client_secret_idx], "client_secret"),
        "include_entities": entities,
        "_include_idx": include_idx,
        "_include_end_idx": end_idx,
        "_item_indent": item_indent,
    }


def patch_include_entities(config_yaml_text: str, new_entities: list[str]) -> str:
    """Returns the full configuration.yaml text with the include_entities
    list replaced by `new_entities`, leaving every other line untouched."""
    lines = config_yaml_text.splitlines(keepends=True)
    parsed = read_alexa_config(config_yaml_text)

    include_idx = parsed["_include_idx"]
    include_end_idx = parsed["_include_end_idx"]
    item_prefix = " " * parsed["_item_indent"]

    new_item_lines = [f"{item_prefix}- {entity}\n" for entity in sorted(new_entities)]

    return "".join(lines[: include_idx + 1] + new_item_lines + lines[include_end_idx:])
