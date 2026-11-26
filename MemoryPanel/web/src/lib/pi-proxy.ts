const extensionPath = './MemoryCore/pi-plugin';

function quoteShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function piProxyEndpoint(base: string, instanceId: string): string {
  return `${base.replace(/\/+$/, '')}/pi/${instanceId}/v1`;
}

export function piProxySetup(
  base: string,
  instanceId: string,
  model: string,
  userKeyPlaceholder: string,
): string {
  return [
    `export TDAI_PROXY_URL=${quoteShell(base.replace(/\/+$/, ''))}`,
    `export TDAI_SPACE_ID=${quoteShell(instanceId)}`,
    'export TDAI_AGENT_SOURCE=pi',
    "export TDAI_TEAM_ID='<team-id>'",
    "export TDAI_AGENT_ID='<agent-id>'",
    `export TDAI_USER_KEY=${quoteShell(userKeyPlaceholder)}`,
    `export TDAI_MODEL=${quoteShell(model)}`,
    "# export TDAI_TASK_ID='<task-id>'",
    '',
    `pi -e ${quoteShell(extensionPath)} --provider tdai --model "$TDAI_MODEL"`,
  ].join('\n');
}
