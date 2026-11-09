import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialInfra, makeCompose, estimate, validateInfra, stackName, Infra } from '../infra.mjs';

test('every runtime and migration container has CPU, RAM, swap and log limits', () => {
  const config = structuredClone(initialInfra);
  for (const r of Object.values(config.resources)) r.enabled = true;
  const compose = makeCompose(config, '/tmp/lab', 'synthetic-test-secret');
  assert.equal(Object.keys(compose.services).length, 14);
  for (const [id, s] of Object.entries(compose.services)) {
    assert.ok(s.cpus > 0, id);
    assert.match(s.mem_limit, /^\d+m$/, id);
    assert.equal(s.memswap_limit, s.mem_limit, id);
    assert.ok(s.pids_limit > 0, id);
    assert.equal(s.logging.options['max-size'], '5m');
    for (const published of s.ports || []) assert.ok(published.startsWith('127.0.0.1:'), id);
  }
  assert.equal(compose.services.api.depends_on.migrate.condition, 'service_completed_successfully');
  assert.match(compose.services.api.environment.DATABASE_URL, /@postgres:5432\/freshphones_lab$/);
  assert.equal(compose.services.api.environment.NODE_ENV, 'development');
  assert.equal(compose.services.postgres.ports, undefined);
});
test('settings reject NaN, path traversal, missing services and impossible database budgets', () => {
  for (const change of [
    c => { c.resources.api.cpu = NaN; },
    c => { c.resources.api.ram = -1; },
    c => { c.dockerfile = '../Dockerfile'; },
    c => { c.databaseBuffers = 1024; },
    c => { c.redisMemory = 250; },
  ]) {
    const config = structuredClone(initialInfra); change(config);
    assert.throws(() => validateInfra(config));
  }
});
test('cost estimate uses enabled caps and explicit rates, not measured usage or provider pricing', () => {
  const c = structuredClone(initialInfra);
  c.rates = { cpuHour: 1, ramGBHour: 1, storageGBMonth: 1, hours: 1 };
  assert.deepEqual(estimate(c), { cpu: 4.25, ram: 3968, monthly: 28.125 });
  c.resources.kafka.enabled = true;
  assert.equal(estimate(c).cpu, 5.25);
  assert.equal(estimate(c).ram, 5504);
});
test('custom project uses its own Dockerfile without FreshPhones migrations or worker', () => {
  const c = structuredClone(initialInfra); c.mode = 'custom'; c.dockerfile = 'deploy/Dockerfile';
  const stack = makeCompose(c, '/tmp/lab', 'test');
  assert.equal(stack.services.api, undefined);
  assert.equal(stack.services.worker, undefined);
  assert.equal(stack.services.migrate, undefined);
  assert.equal(stack.services.web.build.dockerfile, 'deploy/Dockerfile');
});

test('each project has distinct Compose identity and bind-mount configuration', () => {
  const a = structuredClone(initialInfra); a.mode = 'custom'; a.projectPath = '/tmp/team-a/shop';
  const b = structuredClone(a); b.projectPath = '/tmp/team-b/shop';
  assert.notEqual(stackName(a), stackName(b));
  assert.equal(stackName(initialInfra), 'systems-lab-freshphones');
  assert.equal(makeCompose(a, '/tmp/lab-a', 'test').name, stackName(a));
  assert.equal(makeCompose(b, '/tmp/lab-b', 'test').name, stackName(b));
});

test('preparing a second project preserves the first project configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'systems-lab-projects-'));
  const infra = new Infra(root, () => {}); infra.secret = 'synthetic-test-secret';
  const a = structuredClone(initialInfra); a.mode = 'custom'; a.projectPath = path.join(root, 'one');
  const b = structuredClone(a); b.projectPath = path.join(root, 'two');
  for (const c of [a,b]) { await mkdir(c.projectPath); await writeFile(path.join(c.projectPath, 'Dockerfile'), 'FROM scratch\n'); }
  const first = await infra.prepare(a);
  const before = await readFile(first.path, 'utf8');
  const second = await infra.prepare(b);
  assert.notEqual(first.path, second.path);
  assert.equal(await readFile(first.path, 'utf8'), before);
  assert.equal(JSON.parse(await readFile(second.path, 'utf8')).name, stackName(b));
  assert.ok(infra.composeArgs('ps').includes(stackName(b)));
});

test('overall environment budget rejects allocations beyond total CPU or RAM', () => {
  const c=structuredClone(initialInfra);c.plan={cpu:4.25,ram:3968,allocation:'manual',billing:{model:'estimate',price:0,credit:0}};
  assert.doesNotThrow(()=>validateInfra(c));
  c.plan.cpu=4;assert.throws(()=>validateInfra(c),/overall environment plan/);
  c.plan.cpu=4.25;c.plan.ram=3904;assert.throws(()=>validateInfra(c),/overall environment plan/);
});
test('subscription projections separate base fee, credit and estimated overage', () => {
  const c=structuredClone(initialInfra);c.plan={cpu:4.25,ram:3968,allocation:'manual',billing:{model:'fixed',price:12,credit:0}};
  assert.equal(estimate(c).monthly,12);assert.equal(estimate(c).overage,0);
  c.plan.billing={model:'metered',price:12,credit:12};
  const full=estimate(c);assert.ok(full.resourceEstimate>12);assert.equal(full.overage,full.resourceEstimate-12);assert.equal(full.monthly,12+full.overage);
  c.plan.billing.credit=1000;assert.equal(estimate(c).overage,0);assert.equal(estimate(c).monthly,12);
  c.plan.billing.price=NaN;assert.throws(()=>validateInfra(c),/subscription/);
});


test('detected services allow removal of API, worker and dependencies without dangling Compose references',()=>{
  const c=structuredClone(initialInfra);c.mode='detected';
  for(const r of Object.values(c.resources))r.enabled=false;
  c.definition={version:1,entry:'shop',services:{shop:{kind:'app',dockerfile:'deploy/Dockerfile',port:8080,dependsOn:['redis'],environment:{REDIS_URL:'${LAB_REDIS_URL}'}},redis:{kind:'redis'},worker:{kind:'app',dockerfile:'deploy/Dockerfile',command:['node','worker.js'],dependsOn:['redis']}}};
  c.resources.shop={enabled:true,cpu:1,ram:512};
  const compose=makeCompose(c,'/tmp/lab','synthetic-secret');
  assert.deepEqual(Object.keys(compose.services),['shop']);
  assert.equal(compose.services.shop.depends_on,undefined);
  assert.deepEqual(compose.services.shop.ports,['127.0.0.1:18080:8080']);
  assert.match(compose.services.shop.environment.REDIS_URL,/synthetic-secret/);
  c.resources.worker.enabled=true;
  assert.deepEqual(makeCompose(c,'/tmp/lab','test').services.worker.command,['node','worker.js']);
  c.resources.worker.enabled=false;assert.equal(makeCompose(c,'/tmp/lab','test').services.worker,undefined);
});
