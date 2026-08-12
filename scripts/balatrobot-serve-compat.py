"""Launch the pinned BalatroBot CLI with a robust local health probe.

BalatroBot 1.5.2 starts its HTTP listener immediately before registering all
Lua endpoints.  Its stock launcher treats the transient empty response as a
fatal JSON decoding error instead of retrying.  Keep the upstream CLI and
manager intact, but replace only that probe while this version is pinned.
"""

from __future__ import annotations

import asyncio
import importlib

import httpx

from balatrobot.manager import BalatroInstance, HEALTH_TIMEOUT


async def _wait_for_health_compat(
    self: BalatroInstance, timeout: float = HEALTH_TIMEOUT
) -> None:
    url = f"http://{self._config.host}:{self._config.port}"
    payload = {"jsonrpc": "2.0", "method": "health", "params": {}, "id": 1}
    loop = asyncio.get_running_loop()
    started = loop.time()

    while loop.time() - started < timeout:
        try:
            # This is always a loopback connection.  Ignoring proxy settings
            # also prevents a machine-wide proxy from intercepting localhost.
            async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
                result = data.get("result") if isinstance(data, dict) else None
                if isinstance(result, dict) and result.get("status") == "ok":
                    return
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            # Connection refusal, an incomplete startup response, and a brief
            # endpoint-not-ready reply are all expected during Lua bootstrap.
            pass
        await asyncio.sleep(0.5)

    raise RuntimeError(
        f"Health check failed after {timeout}s on "
        f"{self._config.host}:{self._config.port}"
    )


BalatroInstance._wait_for_health = _wait_for_health_compat


async def _serve_until_game_exits(config) -> None:
    """Keep the RPC host alive only while its Balatro child is alive.

    Upstream 1.5.2 sleeps forever after the game window closes.  On a machine
    that repeatedly runs the controller this leaves uv/Python launcher trees
    behind.  Polling the owned child lets the context manager perform its
    normal cleanup without touching any unrelated Balatro process.
    """
    async with BalatroInstance(config) as instance:
        print(f"Balatro running on port {instance.port}. Press Ctrl+C to stop.")
        while instance.process.poll() is None:
            await asyncio.sleep(1)
        print("Balatro exited; shutting down its BalatroBot launcher.")


# Patch the command module before Typer dispatches to serve().
serve_module = importlib.import_module("balatrobot.cli.serve")

serve_module._serve = _serve_until_game_exits

from balatrobot.cli import main  # noqa: E402  (patch before importing the CLI)


if __name__ == "__main__":
    main()
