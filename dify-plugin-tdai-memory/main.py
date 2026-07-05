import os

from dify_plugin import DifyPluginEnv, Plugin


DEFAULT_REQUEST_TIMEOUT = 120


def _max_request_timeout() -> int:
    try:
        timeout = int(os.environ.get("MAX_REQUEST_TIMEOUT", str(DEFAULT_REQUEST_TIMEOUT)))
    except (TypeError, ValueError):
        return DEFAULT_REQUEST_TIMEOUT
    return timeout if timeout > 0 else DEFAULT_REQUEST_TIMEOUT


plugin = Plugin(DifyPluginEnv(MAX_REQUEST_TIMEOUT=_max_request_timeout()))


if __name__ == "__main__":
    plugin.run()
