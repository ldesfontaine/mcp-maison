import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeOpenCloud } from './fakes.js';
import { callTool, listen, startMcp, textOf } from './helpers.js';

const TOKEN = 'lucas-token-0123456789abcdef';
const OPENCLOUD_TOKEN = 'oc-api-token-0123456789';
let openCloud: ReturnType<typeof fakeOpenCloud>;
let openCloudServer: Awaited<ReturnType<typeof listen>>;
let mcp: Awaited<ReturnType<typeof startMcp>>;
let badTokenMcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => {
  openCloud = fakeOpenCloud(OPENCLOUD_TOKEN);
  openCloudServer = await listen(openCloud.app);
  const env = { AUTH_MODE: 'tokens', MCP_TOKENS: `lucas:${TOKEN}`, TOOL_GROUPS: 'core,opencloud', OPENCLOUD_URL: openCloudServer.url };
  mcp = await startMcp({ ...env, OPENCLOUD_TOKEN });
  badTokenMcp = await startMcp({ ...env, OPENCLOUD_TOKEN: 'revoked-token-0123456789' });
});
afterAll(async () => { await mcp.stop(); await badTokenMcp.stop(); openCloudServer.server.close(); });

describe('groupe opencloud (client du /mcp d\'openCloud)', () => {
  it('relaie les lectures avec le jeton d\'API et rend le JSON d\'openCloud', async () => {
    const overview = await callTool(mcp.url, TOKEN, 'opencloud_overview');
    expect(JSON.parse(textOf(overview))).toEqual({ version: 'v0.0.1', counts: { machines: 2 } });
    const machines = await callTool(mcp.url, TOKEN, 'opencloud_list_machines');
    expect(JSON.parse(textOf(machines)).machines[0].name).toBe('vps-1');
    await callTool(mcp.url, TOKEN, 'opencloud_list_alerts', { status: 'resolved' });
    expect(openCloud.calls.map((call) => call.name)).toEqual(['get_overview', 'list_machines', 'list_alerts']);
    expect(openCloud.calls[2].args).toEqual({ status: 'resolved' });
  });

  it('jeton refusé par openCloud : message lisible, journalisé en échec', async () => {
    const result = await callTool(badTokenMcp.url, TOKEN, 'opencloud_overview');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/jeton refusé \(401\).*OPENCLOUD_TOKEN/);
    const [entry] = await badTokenMcp.audit.recent({ tool: 'opencloud_overview' });
    expect(entry).toMatchObject({ ok: false, user: 'lucas' });
  });
});
