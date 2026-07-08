"""memory-tencentdb Dify Plugin — entry point.

Register the memory-tencentdb provider so Dify discovers it when the
plugin is loaded. Providers defined in manifest.yaml are auto-imported;
this module provides the concrete class that the framework instantiates.
"""

from .provider import MemoryTencentdbProvider

__all__ = ["MemoryTencentdbProvider"]

# Dify Plugin SDK auto-imports providers listed in manifest.yaml.
# The provider class is the single public export of this package.
