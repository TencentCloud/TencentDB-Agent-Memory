# Protocolo de despliegue del MemoryProxy (tdai-proxy)

**Estado:** VIGENTE (2026-08-29, tras incidente de pin obsoleto 28-08)
**Alcance:** despliegue del proxy en este repo; la verificación final la hace
la compuerta de arranque del repo krathos (`bin/ensure-tencent-stack`).

## Por qué existe este protocolo

El 28-08 el proxy se redesplegó con imagen nueva (`fix-3872670`) pero el pin
del lanzador quedó viejo → todo inicio de sesión del agente bloqueado. La
ronda adversarial del 29-08 determinó que la causa raíz es de **proceso**:
desplegar es manual e informal. Este documento lo convierte en procedimiento.

Reglas de oro (cada una cubre un incidente real):

1. **Nunca taggear `latest`** para `tdai-proxy`. `latest` es la imagen vieja o
   una futura no verificada; la compuerta de krathos la bloquea por diseño.
2. **El tag siempre lleva el commit fuente**: `agentmemory/memory-proxy:fix-<commit-corto>`.
   Es la forma de saber SIEMPRE qué código corre, sin `docker inspect`.
3. **Nunca `docker stop tdai-proxy` desde la sesión que circula por él** —
   cortarías tu propio canal de control (incidente 26-08). Si el deploy es
   desde una sesión del agente, avisar al coach/humano o usar ventana de
   mantenimiento coordinada.
4. **Backup antes de recrear** (incidente 26-08: sin backup de config en
   caliente fue arriesgado): snapshot del contenedor actual + `config.yaml`.

## El procedimiento (en orden, sin saltos)

```bash
# 0. Precondiciones
cd ~/www/tencentMemoryAgent
git status                      # working tree limpio en lo posible
                                # (pnpm-lock.yaml sucio es drift conocido, no tocar)
git log --oneline -1            # anota el commit que vas a desplegar
# nunca despliegues código que no esté commiteado

# 1. Construir con tag de commit (NO latest)
cd MemoryProxy
DOCKER_BUILDKIT=1 docker build -t agentmemory/memory-proxy:fix-$(git rev-parse --short HEAD) .

# 2. Probar ANTES de tocar el contenedor vivo
docker run --rm agentmemory/memory-proxy:fix-$(git rev-parse --short HEAD) --version 2>/dev/null || true
# tests unitarios si aplica:
cd MemoryProxy && pnpm vitest run src/__tests__ 2>/dev/null || npx vitest run src/__tests__

# 3. Verificar que config.yaml vigente conserva externalGatewayUrl
#    (start-all.sh regenera config y lo puede borrar — incidente 26-08)
grep -A2 "externalGatewayUrl" deploy/global-images/.proxy-config/config.yaml

# 4. Actualizar .env del deploy ANTES de recrear
#    deploy/global-images/.env → PROXY_IMAGE=agentmemory/memory-proxy:fix-<commit>

# 5. Recrear SOLO el proxy (no start-all.sh completo: recrearía core/hub)
cd deploy/global-images && ./start-proxy.sh

# 6. Verificación post-deploy (compuerta completa)
./verify.sh --skip-llm
curl -s http://127.0.0.1:8096/health | jq .
# respuesta esperada: {"status":"ok",...,"upstream":"https://api.z.ai/api/anthropic/v1",...}

# 7. Probar los flujos de memoria desde fuera (smoke mínimo)
#    búsqueda atómica con la identidad del agente → debe devolver resultados

# 8. Si algo falla: rollback = volver .env a la imagen anterior + ./start-proxy.sh
#    (las imágenes viejas NUNCA se borran con docker rmi; son el rollback)
```

## Lo que la compuerta de krathos valida después

Al arrancar una sesión, `bin/ensure-tencent-stack` (repo krathos) exige:

- el tag pertenece a la familia `agentmemory/memory-proxy:(fix|release)-[0-9a-f]+`
- el contenedor corre exactamente la imagen que su tag nombra
  (detecta rebuild retagueado sin recrear)
- core → hub → proxy healthy, en ese orden, + 4 endpoints

Si este protocolo se siguió, la compuerta pasa sin tocar nada.

## Registro

Todo despliegue deja línea en `memory/audit.log` (repo krathos) con: commit
desplegado, tag, resultado de `/health` y cualquier incidencia.
