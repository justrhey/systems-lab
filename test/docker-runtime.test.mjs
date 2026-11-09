import test from 'node:test';
import assert from 'node:assert/strict';
import { Infra } from '../infra.mjs';

test('missing system socket falls back to rootless and reuses that endpoint for Compose and stats', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] !== '--host') throw new Error('dial unix /var/run/docker.sock: connect: no such file or directory');
    return { stdout: JSON.stringify({ ServerVersion: '29.8.0', SecurityOptions: ['name=rootless'], CpuCfsQuota: true, MemoryLimit: true }) };
  };
  const infra = new Infra('/tmp/test-rootless-runtime', () => {}, runner);
  const status = await infra.connectDocker();
  assert.equal(calls.length, 2);
  assert.equal(status.available, true); assert.equal(status.rootless, true);
  assert.equal(status.cpuLimit, true); assert.equal(status.memoryLimit, true);
  assert.match(status.endpoint, /^unix:\/\/.*\/docker\.sock$/);
  assert.deepEqual(infra.composeArgs('ps').slice(0, 3), ['--host', status.endpoint, 'compose']);
  assert.deepEqual(infra.dockerArgs('stats').slice(0, 3), ['--host', status.endpoint, 'stats']);
  await infra.connectDocker();
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).args[1], status.endpoint);
});

test('running system Docker keeps its current context; unsupported caps block startup', async () => {
  const infra = new Infra('/tmp/test-system-runtime', () => {}, async () => ({ stdout: JSON.stringify({ ServerVersion: '29.8.0', SecurityOptions: [], CpuCfsQuota: false, MemoryLimit: true }) }));
  const status = await infra.connectDocker();
  assert.equal(status.rootless, false); assert.equal(infra.dockerHost, null);
  assert.equal(infra.composeArgs('ps')[0], 'compose');
  assert.throws(() => infra.startOperation(['up', '-d'], 'Starting'), /cannot enforce CPU and RAM/);
  infra.docker.available = false;
  assert.throws(() => infra.startOperation(['up', '-d'], 'Starting'), /Docker is not connected/);
  assert.equal(infra.operation, null);
});
