"""Async Alexa Event Gateway client.

Ported from the standalone Control Room/Tools/alexa_purge/alexa_purge.py
tool (2026-07-26) so Xontrol can send Alexa.Discovery.DeleteReport
events natively, with no external script and no Claude in the loop.

See that tool's docstring / controlroom_session_2026-07-26.md (v6.10,
section B) for the full investigation behind this auth model: Amazon's
proactive-events auth is a separate OAuth flow from account linking, using
the skill's "Send Alexa Events" client_id/client_secret to refresh the
token HA's own alexa component already stores in .storage/alexa_auth.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

import aiohttp

from .const import (
    EVENT_GATEWAY_URL,
    LWA_TOKEN_URL,
    MAX_ENDPOINTS_PER_REQUEST,
    MAX_RETRIES,
    RETRY_BACKOFF_SECONDS,
)

_LOGGER = logging.getLogger(__name__)


def entity_id_to_endpoint_id(entity_id: str) -> str:
    """HA's alexa component uses `<domain>#<object_id>` as the endpointId,
    confirmed empirically against a real Discovery response on 2026-07-26."""
    return entity_id.replace(".", "#", 1)


async def get_fresh_access_token(
    session: aiohttp.ClientSession,
    client_id: str,
    client_secret: str,
    refresh_token: str,
) -> str:
    """Exchanges HA's stored Alexa refresh_token for a fresh access_token."""
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    async with session.post(LWA_TOKEN_URL, data=data) as resp:
        resp.raise_for_status()
        body = await resp.json(content_type=None)
    return body["access_token"]


async def send_delete_report(
    session: aiohttp.ClientSession,
    access_token: str,
    entity_ids: list[str],
) -> list[str]:
    """Sends Alexa.Discovery.DeleteReport for each entity_id, batched at
    MAX_ENDPOINTS_PER_REQUEST with retry/backoff per batch (Amazon returned
    a bare INTERNAL_SERVICE_EXCEPTION on a 148-endpoint single request in
    testing -- see const.py comment). Returns the entity_ids that were NOT
    successfully deleted after all retries, so the caller can keep them in
    its baseline for the next attempt rather than silently losing them.
    """
    endpoint_ids = [entity_id_to_endpoint_id(e) for e in entity_ids]
    failed_endpoint_ids: list[str] = []

    batches = [
        endpoint_ids[i : i + MAX_ENDPOINTS_PER_REQUEST]
        for i in range(0, len(endpoint_ids), MAX_ENDPOINTS_PER_REQUEST)
    ]

    for batch_num, chunk in enumerate(batches, start=1):
        event = {
            "event": {
                "header": {
                    "namespace": "Alexa.Discovery",
                    "name": "DeleteReport",
                    "messageId": str(uuid.uuid4()),
                    "payloadVersion": "3",
                },
                "payload": {
                    "endpoints": [{"endpointId": eid} for eid in chunk],
                    "scope": {"type": "BearerToken", "token": access_token},
                },
            }
        }

        last_error: str | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                async with session.post(
                    EVENT_GATEWAY_URL,
                    data=json.dumps(event),
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {access_token}",
                    },
                ) as resp:
                    if resp.status >= 400:
                        body = await resp.text()
                        raise aiohttp.ClientResponseError(
                            resp.request_info,
                            resp.history,
                            status=resp.status,
                            message=body,
                        )
                    _LOGGER.info(
                        "Xontrol: DeleteReport batch %s/%s -> HTTP %s (%s endpoints)",
                        batch_num, len(batches), resp.status, len(chunk),
                    )
                last_error = None
                break
            except (aiohttp.ClientError, asyncio.TimeoutError) as err:
                last_error = str(err)
                if attempt < MAX_RETRIES:
                    wait = RETRY_BACKOFF_SECONDS * attempt
                    _LOGGER.warning(
                        "Xontrol: DeleteReport batch %s/%s attempt %s failed (%s); "
                        "retrying in %ss",
                        batch_num, len(batches), attempt, last_error, wait,
                    )
                    await asyncio.sleep(wait)

        if last_error:
            _LOGGER.error(
                "Xontrol: DeleteReport batch %s/%s FAILED after %s attempts: %s -- "
                "endpoints: %s",
                batch_num, len(batches), MAX_RETRIES, last_error, chunk,
            )
            failed_endpoint_ids.extend(chunk)
        else:
            await asyncio.sleep(0.3)  # small pacing gap between successful batches

    return [eid.replace("#", ".", 1) for eid in failed_endpoint_ids]
