# MCP Server - Red-Team Assessment Summary

## Gate Architecture
[G0: Input validation] -> [G1: API Key (HMAC)] -> [G2: Rate limit (sliding window)]
-> [G3: Circuit breaker (10 fail -> 60s)] -> [G4: Audit log] -> Tool Handler

## Findings
- G1: HMAC constant-time, timing-attack resistant. SECURE
- G2: Sliding window 60/60s. Known weakness: resets per stdio process (architectural)
- G3: 10 failures -> 60s cooldown. Known weakness: resets per stdio process (architectural)
- G0: Batch/concat/null-byte/unicode/RTL/prototype-pollution all rejected. SECURE
- G4: No tool parameter can suppress logging. SECURE

## Recommendation
Stdio gates provide defense-in-depth against accidental abuse (config errors, runaway loops).
Production deployments should use agentgateway (LF/Solo.io) for session-persistent enforcement.