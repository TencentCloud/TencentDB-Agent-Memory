# Keep Pi v3 Native Memory Separate from Proxy Routing

We will deliver the issue 926 integration as an independent `adapters/pi` package that speaks directly to the v3 memory data plane, while retaining `MemoryCore/pi-plugin` as the existing proxy-routing extension. The two paths serve different contracts: the native package provides Pi lifecycle recall, capture, and tools; the proxy extension delegates those capabilities to MemoryProxy. Keeping them separate preserves the upstream proxy behavior and lets each integration evolve against its own host contract.
