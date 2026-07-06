import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginRuntime } from '../src/plugins';

test('Phase 1 commands return real runtime data and help output', async () => {
  const runtime = new PluginRuntime('owner');

  const ping = await runtime.dispatch('ping', { sender: 'owner', owner: 'owner', args: [] });
  assert.match(ping, /PONG \d+ms/);

  const alive = await runtime.dispatch('alive', { sender: 'owner', owner: 'owner', args: [] });
  assert.match(alive, /ULTRON STATUS/);
  assert.match(alive, /Plugins:/);
  assert.match(alive, /AI Provider:/);

  const stats = await runtime.dispatch('stats', { sender: 'owner', owner: 'owner', args: [] });
  assert.match(stats, /Memory:/);
  assert.match(stats, /CPU:/);
  assert.match(stats, /DB:/);
  assert.match(stats, /Messages:/);

  const help = await runtime.dispatch('help', { sender: 'owner', owner: 'owner', args: [] });
  assert.match(help, /Identity:/);

  const update = await runtime.dispatch('update', { sender: 'owner', owner: 'owner', args: [] });
  assert.match(update, /Changes available|Update confirmed/);
});
