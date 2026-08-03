"""Memory file reader — direct read of memory pipeline artifacts (persona.md,
scene_blocks/*.md) from object storage with STS credential management.

The SDK user calls ``client.read_file(path)`` and gets the file content back.
Under the hood, we:
  1. Fetch STS temporary credentials from the platform (``POST /v2/cos/secret``)
  2. Cache credentials until they expire (auto-refresh)
  3. Sign a COS V5 GET request with the STS credentials
  4. Return the file content as a string

Storage backend (currently COS) is an implementation detail — the public API
is intentionally storage-agnostic.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

from .errors import TDAMError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# COS URL parser
# ---------------------------------------------------------------------------

def _parse_cos_url(cos_url: str) -> tuple[str, str, str]:
    """Parse a public or internal COS URL into ``(bucket, region, host)``."""
    host = urlparse(cos_url).hostname or ""
    public = re.match(r"^(.+?)\.cos\.(.+?)\.myqcloud\.com$", host)
    if public:
        return public.group(1), public.group(2), host
    internal = re.match(
        r"^(.+?)\.cos-internal\.(.+?)\.tencentcos\.cn$",
        host,
    )
    if internal:
        return internal.group(1), internal.group(2), host
    raise TDAMError(
        code=-1,
        message=(
            f"Cannot parse CosUrl: {cos_url!r} "
            "(expected a public myqcloud.com or internal tencentcos.cn COS URL)"
        ),
    )


# ---------------------------------------------------------------------------
# STS Credential
# ---------------------------------------------------------------------------

class StsCredential:
    """Parsed STS credential from ``POST /v2/cos/secret``.

    Platform response format::

        {
            "CosUrl": "https://{bucket}.cos.{region}.myqcloud.com",
            "TmpSecretId": "...",
            "TmpSecretKey": "...",
            "TmpToken": "...",
            "ExpirationTime": "2026-05-15T16:44:49+08:00",
            "PathPrefix": "memory_v2/cos_data/mem-xxx"
        }
    """

    __slots__ = (
        "tmp_secret_id", "tmp_secret_key", "token",
        "bucket", "region", "_cos_host", "prefix", "expires_at_epoch",
    )

    def __init__(self, data: Dict[str, Any]) -> None:
        self.tmp_secret_id: str = data["TmpSecretId"]
        self.tmp_secret_key: str = data["TmpSecretKey"]
        self.token: str = data.get("TmpToken", "")
        # Parse bucket + region from CosUrl
        self.bucket: str
        self.region: str
        self._cos_host: str
        self.bucket, self.region, self._cos_host = _parse_cos_url(data["CosUrl"])
        # PathPrefix — ensure trailing slash for key concatenation
        prefix = data.get("PathPrefix", "")
        self.prefix: str = prefix if prefix.endswith("/") else f"{prefix}/"
        # Parse ISO 8601 → epoch seconds
        expires_str = data.get("ExpirationTime", "")
        if expires_str:
            from datetime import datetime, timezone
            try:
                dt = datetime.fromisoformat(expires_str.replace("Z", "+00:00"))
                self.expires_at_epoch = dt.timestamp()
            except Exception:
                self.expires_at_epoch = time.time() + 1800  # 30 min fallback
        else:
            self.expires_at_epoch = time.time() + 1800

    def is_valid(self, buffer_seconds: float = 120) -> bool:
        """Check if credential is still valid (with 2-minute buffer)."""
        return time.time() < (self.expires_at_epoch - buffer_seconds)

    @property
    def cos_host(self) -> str:
        return self._cos_host


# ---------------------------------------------------------------------------
# STS Credential Manager
# ---------------------------------------------------------------------------

class StsCredentialManager:
    """Thread-safe STS credential cache with auto-refresh.

    - Fetches STS from platform ``POST /v2/cos/secret``
    - Caches until expiry (with 2-minute buffer)
    - Coalesces concurrent refresh requests
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        buffer_seconds: float = 120,
        timeout: float = 30,
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._service_id = service_id
        self._buffer = buffer_seconds
        self._timeout = timeout
        self._credential: Optional[StsCredential] = None
        self._lock = threading.Lock()
        self._client: Optional[httpx.Client] = None

    def get_credential(self) -> StsCredential:
        """Get a valid STS credential (cached or freshly fetched)."""
        if self._credential and self._credential.is_valid(self._buffer):
            return self._credential

        with self._lock:
            # Double-check after acquiring lock
            if self._credential and self._credential.is_valid(self._buffer):
                return self._credential
            return self._refresh()

    def invalidate(self) -> None:
        """Force invalidate cached credential (e.g. on 403)."""
        with self._lock:
            self._credential = None

    def _refresh(self) -> StsCredential:
        logger.debug("[cos] Refreshing STS credential via POST /v2/cos/secret ...")
        if self._client is None:
            self._client = httpx.Client(timeout=self._timeout)

        url = f"{self._endpoint}/v2/cos/secret"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "x-tdai-service-id": self._service_id,
            "Content-Type": "application/json",
        }
        resp = self._client.post(url, json={}, headers=headers)
        resp.raise_for_status()
        data = resp.json()

        cred = StsCredential(data)
        self._credential = cred
        logger.debug("[cos] STS refreshed: bucket=%s prefix=%s expires=%.0f",
                     cred.bucket, cred.prefix, cred.expires_at_epoch)
        return cred

    def close(self) -> None:
        if self._client is not None:
            self._client.close()


# ---------------------------------------------------------------------------
# Async STS Credential Manager
# ---------------------------------------------------------------------------

class AsyncStsCredentialManager:
    """Async variant of StsCredentialManager."""

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        buffer_seconds: float = 120,
        timeout: float = 30,
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._service_id = service_id
        self._buffer = buffer_seconds
        self._timeout = timeout
        self._credential: Optional[StsCredential] = None
        import asyncio
        self._lock = asyncio.Lock()
        self._client: Optional[httpx.AsyncClient] = None

    async def get_credential(self) -> StsCredential:
        if self._credential and self._credential.is_valid(self._buffer):
            return self._credential

        async with self._lock:
            if self._credential and self._credential.is_valid(self._buffer):
                return self._credential
            return await self._refresh()

    def invalidate(self) -> None:
        self._credential = None

    async def _refresh(self) -> StsCredential:
        logger.debug("[cos] Refreshing STS credential (async) via POST /v2/cos/secret ...")
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)

        url = f"{self._endpoint}/v2/cos/secret"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "x-tdai-service-id": self._service_id,
            "Content-Type": "application/json",
        }
        resp = await self._client.post(url, json={}, headers=headers)
        resp.raise_for_status()
        data = resp.json()

        cred = StsCredential(data)
        self._credential = cred
        return cred

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()


# ---------------------------------------------------------------------------
# COS V5 Signature
# ---------------------------------------------------------------------------

def _cos_v5_sign(
    secret_id: str,
    secret_key: str,
    method: str,
    path: str,
    host: str,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None,
) -> str:
    """Generate COS V5 Authorization header value for a GET request.

    References:
      https://cloud.tencent.com/document/product/436/7778
    """
    now = int(time.time())
    q_sign_time = f"{start_time or (now - 60)};{end_time or (now + 600)}"
    q_key_time = q_sign_time

    # Step 1: SignKey
    sign_key = hmac.new(
        secret_key.encode("utf-8"),
        q_key_time.encode("utf-8"),
        hashlib.sha1,
    ).hexdigest()

    # Step 2: HttpString
    # For GET with no query params and only host header
    http_string = f"{method.lower()}\n{path}\n\nhost={host}\n"

    # Step 3: StringToSign
    sha1_http_string = hashlib.sha1(http_string.encode("utf-8")).hexdigest()
    string_to_sign = f"sha1\n{q_sign_time}\n{sha1_http_string}\n"

    # Step 4: Signature
    signature = hmac.new(
        sign_key.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha1,
    ).hexdigest()

    return (
        f"q-sign-algorithm=sha1"
        f"&q-ak={secret_id}"
        f"&q-sign-time={q_sign_time}"
        f"&q-key-time={q_key_time}"
        f"&q-header-list=host"
        f"&q-url-param-list="
        f"&q-signature={signature}"
    )


# ---------------------------------------------------------------------------
# Memory File Reader (sync)
# ---------------------------------------------------------------------------

class MemoryFileReader:
    """Sync memory file reader with STS auto-management.

    Reads memory pipeline artifacts (persona.md, scene_blocks/*.md, …) from
    object storage. The storage backend is COS today but the public API is
    storage-agnostic.

    Usage::

        reader = MemoryFileReader(sts_manager)
        content = reader.read("scene_blocks/cooking-recipes.md")
    """

    def __init__(
        self,
        sts_manager: StsCredentialManager,
        timeout: float = 30,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self._sts = sts_manager
        self._client = client or httpx.Client(timeout=timeout)

    def read(self, path: str) -> str:
        """Read a memory file by relative path.

        The final COS key is: ``{prefix}{path}``

        Returns file content as UTF-8 string.
        Raises ``TDAMError`` on failure.
        """
        cred = self._sts.get_credential()
        full_key = f"{cred.prefix}{path}"
        cos_path = f"/{full_key}"
        host = cred.cos_host

        auth = _cos_v5_sign(
            secret_id=cred.tmp_secret_id,
            secret_key=cred.tmp_secret_key,
            method="GET",
            path=cos_path,
            host=host,
        )

        headers: Dict[str, str] = {
            "Host": host,
            "Authorization": auth,
        }
        if cred.token:
            headers["x-cos-security-token"] = cred.token

        url = f"https://{host}{cos_path}"
        logger.debug("[cos] GET %s", url)

        resp = self._client.get(url, headers=headers)

        if resp.status_code == 403:
            # Invalidate and retry once
            logger.warning("[cos] 403 on GET %s — invalidating STS and retrying", path)
            self._sts.invalidate()
            cred = self._sts.get_credential()
            full_key = f"{cred.prefix}{path}"
            cos_path = f"/{full_key}"
            host = cred.cos_host
            auth = _cos_v5_sign(
                secret_id=cred.tmp_secret_id,
                secret_key=cred.tmp_secret_key,
                method="GET",
                path=cos_path,
                host=host,
            )
            headers = {"Host": host, "Authorization": auth}
            if cred.token:
                headers["x-cos-security-token"] = cred.token
            url = f"https://{host}{cos_path}"
            resp = self._client.get(url, headers=headers)

        if resp.status_code == 404:
            raise TDAMError(code=404, message=f"File not found: {path}")

        if resp.status_code != 200:
            raise TDAMError(
                code=resp.status_code,
                message=f"COS GET failed: HTTP {resp.status_code} — {resp.text[:200]}",
            )

        return resp.text

    def close(self) -> None:
        if isinstance(self._client, httpx.Client):
            self._client.close()


# ---------------------------------------------------------------------------
# Async Memory File Reader
# ---------------------------------------------------------------------------

class AsyncMemoryFileReader:
    """Async memory file reader with STS auto-management."""

    def __init__(
        self,
        sts_manager: AsyncStsCredentialManager,
        timeout: float = 30,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._sts = sts_manager
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def read(self, path: str) -> str:
        cred = await self._sts.get_credential()
        full_key = f"{cred.prefix}{path}"
        cos_path = f"/{full_key}"
        host = cred.cos_host

        auth = _cos_v5_sign(
            secret_id=cred.tmp_secret_id,
            secret_key=cred.tmp_secret_key,
            method="GET",
            path=cos_path,
            host=host,
        )

        headers: Dict[str, str] = {
            "Host": host,
            "Authorization": auth,
        }
        if cred.token:
            headers["x-cos-security-token"] = cred.token

        url = f"https://{host}{cos_path}"
        resp = await self._client.get(url, headers=headers)

        if resp.status_code == 403:
            self._sts.invalidate()
            cred = await self._sts.get_credential()
            full_key = f"{cred.prefix}{path}"
            cos_path = f"/{full_key}"
            host = cred.cos_host
            auth = _cos_v5_sign(
                secret_id=cred.tmp_secret_id,
                secret_key=cred.tmp_secret_key,
                method="GET",
                path=cos_path,
                host=host,
            )
            headers = {"Host": host, "Authorization": auth}
            if cred.token:
                headers["x-cos-security-token"] = cred.token
            url = f"https://{host}{cos_path}"
            resp = await self._client.get(url, headers=headers)

        if resp.status_code == 404:
            raise TDAMError(code=404, message=f"File not found: {path}")

        if resp.status_code != 200:
            raise TDAMError(
                code=resp.status_code,
                message=f"COS GET failed: HTTP {resp.status_code} — {resp.text[:200]}",
            )

        return resp.text

    async def close(self) -> None:
        if isinstance(self._client, httpx.AsyncClient):
            await self._client.aclose()
