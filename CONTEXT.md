# TencentDB Agent Memory Adapters

This context defines the vocabulary for connecting external agent runtimes to TencentDB Agent Memory. It distinguishes host integration shape from the memory service and its isolation model.

## Platform Integration

**Pi adapter**:
An integration that gives the Pi coding agent access to TencentDB Agent Memory while following Pi's package and extension conventions.
_Avoid_: Pi plugin when referring to the adapter as a whole

**Native extension**:
A Pi-hosted adapter that participates in Pi lifecycle events and exposes memory capabilities through Pi-native surfaces.
_Avoid_: proxy-only adapter, transport shim

**Proxy adapter**:
An integration that routes Pi model traffic through MemoryProxy, leaving memory injection and persistence to the service-side pipeline.
_Avoid_: native extension, direct-memory adapter

**v3 data-plane client**:
The adapter boundary that speaks directly to TencentDB Agent Memory's v3 memory endpoints for recall, search, and conversation persistence.
_Avoid_: proxy route, model provider

## Memory Lifecycle

**Capture turn**:
A completed user/assistant exchange persisted as raw L0 conversation evidence after the Pi run has settled.
_Avoid_: transcript upload, tool event

**Recall bundle**:
The bounded collection of relevant memory layers made available before a Pi run, including atomic memories and optional profile or scenario context.
_Avoid_: instruction payload, authorization context

**Degraded memory mode**:
The state in which Pi continues normally while TencentDB memory is unavailable or incompletely configured.
_Avoid_: hard failure, memory-disabled installation

**Capture marker**:
A non-context Pi session entry recording that one capture turn key was successfully accepted, so reloads can suppress the same turn.
_Avoid_: conversation message, memory record

## Memory Identity

**v3 isolation identity**:
The Team, Agent, and User identifiers that define the scope of a memory operation; Task is an optional narrower business dimension.
_Avoid_: session identity, API key

**Pi session identity**:
The identifier for one Pi conversation, used to correlate conversation evidence and prevent unrelated sessions from being conflated.
_Avoid_: tenant identity, Team identity
