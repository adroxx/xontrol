"""HTTP API views backing the Xontrol panel.

GET  /api/xontrol/entities  -> Alexa-capable entities + current
                                exposure state, read live from
                                configuration.yaml, the entity/device/
                                area registries, and hass.states.
POST /api/xontrol/save      -> applies a new exposure list: purges
                                anything removed via a real Alexa
                                DeleteReport, patches
                                configuration.yaml, then restarts Core.
"""

from __future__ import annotations

import asyncio
import json
import logging

import aiohttp
import voluptuous as vol
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import alexa_events, yaml_patch
from .const import (
    ALEXA_AUTH_STORAGE_PATH,
    ALEXA_CAPABLE_DOMAINS,
    CONFIG_YAML_PATH,
    RESTART_DELAY_SECONDS,
)

_LOGGER = logging.getLogger(__name__)


def _read_file_sync(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _write_file_sync(path: str, content: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _build_row(entity_id, state, entry, dev_reg, area_reg, exposed: set[str]) -> dict:
    """Build one entity row, preferring registry data with a states-only fallback."""
    domain = entity_id.split(".", 1)[0]

    if entry is not None:
        platform = entry.platform
        entity_category = entry.entity_category.value if entry.entity_category else None
        disabled_by = entry.disabled_by.value if entry.disabled_by else None
        hidden_by = entry.hidden_by.value if entry.hidden_by else None
        area_id = entry.area_id
        device_id = entry.device_id
        reg_name = entry.name or entry.original_name
    else:
        platform = entity_category = disabled_by = hidden_by = None
        area_id = device_id = reg_name = None

    device_name = None
    if device_id:
        device = dev_reg.async_get(device_id)
        if device is not None:
            if area_id is None:
                area_id = device.area_id
            device_name = device.name_by_user or device.name

    area_name = None
    if area_id:
        area = area_reg.async_get_area(area_id)
        if area is not None:
            area_name = area.name

    friendly_name = state.attributes.get("friendly_name") if state is not None else None
    friendly_name = friendly_name or reg_name or entity_id

    icon = entry.icon if entry is not None else None
    if icon is None and state is not None:
        icon = state.attributes.get("icon")

    return {
        "entity_id": entity_id,
        "friendly_name": friendly_name,
        "icon": icon,
        "domain": domain,
        "integration": platform,
        "device_name": device_name,
        "area_name": area_name,
        "state": state.state if state is not None else None,
        "disabled": disabled_by is not None,
        "disabled_by": disabled_by,
        "hidden": hidden_by is not None,
        "hidden_by": hidden_by,
        "entity_category": entity_category,
        # HA has no formal "read-only" registry field -- diagnostic entities
        # are the closest existing concept, treated as read-only here as a
        # deliberate simplification, not a discovered API.
        "read_only": entity_category == "diagnostic",
        "exposed": entity_id in exposed,
    }


class EntitiesView(HomeAssistantView):
    """GET /api/xontrol/entities"""

    url = "/api/xontrol/entities"
    name = "api:xontrol:entities"

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]

        config_path = hass.config.path(CONFIG_YAML_PATH)
        config_text = await hass.async_add_executor_job(_read_file_sync, config_path)
        alexa_config = await hass.async_add_executor_job(
            yaml_patch.read_alexa_config, config_text
        )
        exposed = set(alexa_config["include_entities"])

        ent_reg = er.async_get(hass)
        dev_reg = dr.async_get(hass)
        area_reg = ar.async_get(hass)

        entities = []
        seen: set[str] = set()

        # Primary source: the entity registry, so disabled entities (which
        # have no state at all) still show up -- including one that's
        # currently exposed in configuration.yaml but happens to be
        # disabled, which a states-only approach would silently drop.
        for entry in ent_reg.entities.values():
            domain = entry.entity_id.split(".", 1)[0]
            if domain not in ALEXA_CAPABLE_DOMAINS:
                continue
            state = hass.states.get(entry.entity_id)
            entities.append(
                _build_row(entry.entity_id, state, entry, dev_reg, area_reg, exposed)
            )
            seen.add(entry.entity_id)

        # Fallback: any allowlisted-domain entity with a live state but no
        # registry entry (rare -- some legacy YAML platforms without
        # unique_id support don't get one).
        for state in hass.states.async_all():
            if state.entity_id in seen:
                continue
            domain = state.entity_id.split(".", 1)[0]
            if domain not in ALEXA_CAPABLE_DOMAINS:
                continue
            entities.append(
                _build_row(state.entity_id, state, None, dev_reg, area_reg, exposed)
            )

        entities.sort(key=lambda e: (e["domain"], (e["friendly_name"] or "").lower()))

        return self.json({"entities": entities})


class SaveView(HomeAssistantView):
    """POST /api/xontrol/save  body: {"entity_ids": [...]}"""

    url = "/api/xontrol/save"
    name = "api:xontrol:save"

    schema = vol.Schema({vol.Required("entity_ids"): [str]})

    async def post(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]

        try:
            body = self.schema(await request.json())
        except (vol.Invalid, json.JSONDecodeError) as err:
            return self.json_message(str(err), status_code=400)

        new_entities = set(body["entity_ids"])

        config_path = hass.config.path(CONFIG_YAML_PATH)
        config_text = await hass.async_add_executor_job(_read_file_sync, config_path)
        alexa_config = await hass.async_add_executor_job(
            yaml_patch.read_alexa_config, config_text
        )

        old_entities = set(alexa_config["include_entities"])
        removed = sorted(old_entities - new_entities)

        # Only removals need an explicit proactive event -- newly added
        # entities are picked up by Alexa's normal discovery after restart.
        failed: list[str] = []
        if removed:
            try:
                auth_path = hass.config.path(ALEXA_AUTH_STORAGE_PATH)
                auth_raw = await hass.async_add_executor_job(_read_file_sync, auth_path)
                auth_data = json.loads(auth_raw)
                refresh_token = auth_data.get("data", auth_data)["refresh_token"]

                session = async_get_clientsession(hass)
                access_token = await alexa_events.get_fresh_access_token(
                    session,
                    alexa_config["client_id"],
                    alexa_config["client_secret"],
                    refresh_token,
                )
                failed = await alexa_events.send_delete_report(
                    session, access_token, removed
                )
            except (
                aiohttp.ClientError,
                asyncio.TimeoutError,
                KeyError,
                FileNotFoundError,
                json.JSONDecodeError,
            ):
                _LOGGER.exception(
                    "Xontrol: failed to purge removed entities from Alexa; "
                    "keeping them in the filter so the next save retries them"
                )
                failed = removed

        # Anything that failed to purge stays in the filter so it isn't
        # silently forgotten -- it'll remain visible to Alexa until a future
        # save succeeds in purging it.
        final_entities = new_entities | set(failed)

        new_config_text = yaml_patch.patch_include_entities(
            config_text, list(final_entities)
        )
        await hass.async_add_executor_job(_write_file_sync, config_path, new_config_text)

        hass.async_create_task(_delayed_restart(hass))

        return self.json(
            {
                "status": "ok",
                "removed": removed,
                "purge_failed": failed,
                "restart_in_seconds": RESTART_DELAY_SECONDS,
            }
        )


async def _delayed_restart(hass: HomeAssistant) -> None:
    """Give the HTTP response time to reach the browser before Core restarts."""
    await asyncio.sleep(RESTART_DELAY_SECONDS)
    await hass.services.async_call("homeassistant", "restart", blocking=False)


def async_register_views(hass: HomeAssistant) -> None:
    hass.http.register_view(EntitiesView)
    hass.http.register_view(SaveView)
