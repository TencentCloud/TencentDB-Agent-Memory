import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export class DiagnosticService {
  constructor({ config, provenance = {}, gatewayClient, maxObjects = 10000 } = {}) {
    this.config = config;
    this.provenance = provenance;
    this.gatewayClient = gatewayClient;
    this.maxObjects = maxObjects;
  }

  async getLocalSnapshot() {
    const snapshot = {
      config_sources: [...new Set(Object.values(this.provenance))],
      state_version: 1,
      migration_required: true,
      outbox_pending: 0,
      turns: 0,
      markers: 0,
      locks: 0,
      last_successful_operation_at: null,
      warnings: [],
    };
    try {
      const manifest = JSON.parse(await readFile(join(this.config.stateDir, 'state.json'), 'utf8'));
      if (manifest?.version === 2) { snapshot.state_version = 2; snapshot.migration_required = false; }
      else if (Number.isInteger(manifest?.version) && manifest.version > 2) snapshot.warnings.push('future_state_version');
      else snapshot.warnings.push('invalid_state_manifest');
    } catch (error) {
      if (error?.code !== 'ENOENT') snapshot.warnings.push('invalid_state_manifest');
    }
    let seen = 0;
    const visit = async (directory, relativePath = '') => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error?.code === 'ENOENT') return; snapshot.warnings.push('state_scan_failed'); return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (seen >= this.maxObjects) { snapshot.warnings.push('state_scan_truncated'); return; }
        seen += 1;
        const nextRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { await visit(path, nextRelative); continue; }
        if (!entry.isFile()) { snapshot.warnings.push('special_state_object'); continue; }
        if (entry.name.endsWith('.lock')) snapshot.locks += 1;
        if (nextRelative.startsWith('outbox/') && entry.name.endsWith('.json')) snapshot.outbox_pending += 1;
        if (nextRelative.startsWith('captured/') && entry.name.endsWith('.json')) snapshot.markers += 1;
        if (nextRelative.includes('/turns/') && entry.name.endsWith('.json')) snapshot.turns += 1;
        if (entry.name.endsWith('.json')) {
          try {
            const value = JSON.parse(await readFile(path, 'utf8'));
            if (nextRelative.startsWith('captured/')) {
              const timestamp = value.completed_at ?? value.captured_at;
              if (typeof timestamp === 'string' && (!snapshot.last_successful_operation_at || timestamp > snapshot.last_successful_operation_at)) snapshot.last_successful_operation_at = timestamp;
            }
          } catch { snapshot.warnings.push('corrupt_state_object'); }
        }
      }
    };
    await visit(this.config.stateDir);
    snapshot.warnings = [...new Set(snapshot.warnings)].sort();
    return snapshot;
  }

  async probeGateway(deadlineMs = this.config.timeoutMs) {
    try {
      const result = await this.gatewayClient.health({ timeoutMs: deadlineMs });
      return result.status === 'ok' ? 'reachable' : 'degraded';
    } catch { return 'unreachable'; }
  }

  async getStatus({ includeGateway = false } = {}) {
    const local = await this.getLocalSnapshot();
    const gateway = includeGateway ? await this.probeGateway(this.config.timeoutMs) : 'not_checked';
    let status = local.warnings.length || local.migration_required || gateway === 'degraded' ? 'degraded' : 'healthy';
    if (gateway === 'unreachable') status = 'unavailable';
    return { status, gateway, ...local };
  }
}
