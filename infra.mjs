import os from 'node:os';
import {validateDefinition, addApplications, nginxConfig} from './project-definition.mjs';
import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const execute = promisify(execFile);

export const initialInfra = {
  mode: 'freshphones', projectPath: '/home/nami/Desktop/projects/Apps/fresh-phones-ph',
  dockerfile: 'Dockerfile', appPort: 3000, entryPort: 18080,
  databaseConnections: 60, databaseBuffers: 128, redisMemory: 128, storageGB: 20,
  rates: { cpuHour: 0.02, ramGBHour: 0.004, storageGBMonth: 0.10, hours: 730 },
  resources: {
    nginx: { enabled: true, cpu: .25, ram: 128 },
    web: { enabled: true, cpu: 1, ram: 1024 },
    api: { enabled: true, cpu: 1, ram: 1024 },
    worker: { enabled: true, cpu: .5, ram: 512 },
    postgres: { enabled: true, cpu: 1, ram: 1024 },
    redis: { enabled: true, cpu: .5, ram: 256 },
    kafka: { enabled: false, cpu: 1, ram: 1536 },
    rabbitmq: { enabled: false, cpu: .5, ram: 512 },
    mongodb: { enabled: false, cpu: 1, ram: 1024 },
    mysql: { enabled: false, cpu: 1, ram: 1024 },
    minio: { enabled: false, cpu: .5, ram: 512 },
    prometheus: { enabled: false, cpu: .5, ram: 512 },
    grafana: { enabled: false, cpu: .5, ram: 512 },
  },
};
export function validateInfra(config) {
  if (!['detected', 'freshphones', 'custom'].includes(config.mode)) throw new Error('Choose detected services or a custom Dockerfile project.');
  if (!path.isAbsolute(config.projectPath)) throw new Error('Use an absolute project folder.');
  if (typeof config.dockerfile !== 'string' || path.isAbsolute(config.dockerfile) || config.dockerfile.split(/[\\/]/).includes('..')) throw new Error('Dockerfile must be inside the project.');
  for (const key of ['appPort', 'entryPort']) if (!Number.isInteger(config[key]) || config[key] < 1024 || config[key] > 65535) throw new Error('Use ports from 1024 to 65535.');
  if(config.mode==='detected')validateDefinition(config.definition);
  for (const [id, value] of Object.entries(config.resources)) {
    if ((!(id in initialInfra.resources) && !(config.mode==='detected' && config.definition.services[id]?.kind==='app')) || typeof value.enabled !== 'boolean' || !Number.isFinite(value.cpu) || value.cpu < .1 || value.cpu > 16 || !Number.isInteger(value.ram) || value.ram < 64 || value.ram > 16384) throw new Error('Each service needs 0.1–16 CPU cores and 64–16384 MiB RAM.');
  }
  for (const id of Object.keys(initialInfra.resources)) if (!config.resources[id]) throw new Error(`Missing resource settings for ${id}.`);
  for (const [key, min, max] of [['databaseConnections', 20, 1000], ['databaseBuffers', 16, 4096], ['redisMemory', 16, 8192], ['storageGB', 1, 10000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}.`);
  }
  if (config.databaseBuffers > config.resources.postgres.ram / 2) throw new Error('Keep PostgreSQL shared buffers at or below half its RAM cap.');
  if (config.redisMemory > config.resources.redis.ram * .75) throw new Error('Leave at least 25% of Redis RAM for overhead.');
  for (const key of Object.keys(initialInfra.rates)) if (!Number.isFinite(config.rates[key]) || config.rates[key] < 0 || config.rates[key] > 10000) throw new Error('Invalid cost assumption.');
  if (config.plan) {
    const p = config.plan;
    if (!Number.isFinite(p.cpu) || p.cpu < .1 || p.cpu > 16 || !Number.isInteger(p.ram) || p.ram < 64 || p.ram > 16384 || !['automatic','manual'].includes(p.allocation)) throw new Error('Use an environment budget of 0.1–16 CPU and 64–16384 MiB RAM.');
    const enabled = Object.entries(config.resources).filter(([id,r])=>r.enabled && (config.mode !== 'custom' || !['api','worker'].includes(id)));
    if (enabled.reduce((n,[,r])=>n+r.cpu,0) > p.cpu + .00001 || enabled.reduce((n,[,r])=>n+r.ram,0) > p.ram) throw new Error('Service allocations exceed the overall environment plan. Auto-distribute shares or increase the plan.');
    const b=p.billing || {model:'estimate',price:0,credit:0};
    if (!['estimate','fixed','metered'].includes(b.model) || ![b.price,b.credit].every(n=>Number.isFinite(n)&&n>=0&&n<=1000000)) throw new Error('Invalid subscription price or included usage credit.');
  }
  return config;
}
export function estimate(config) {
  const entries = Object.entries(config.resources).filter(([id, r]) => r.enabled && (config.mode !== 'custom' || !['api', 'worker'].includes(id)));
  const cpu = entries.reduce((sum, [, r]) => sum + r.cpu, 0);
  const ram = entries.reduce((sum, [, r]) => sum + r.ram, 0);
  const capacityCPU=config.plan?.cpu ?? cpu, capacityRAM=config.plan?.ram ?? ram;
  const resourceEstimate = (capacityCPU * config.rates.cpuHour + capacityRAM / 1024 * config.rates.ramGBHour) * config.rates.hours + config.storageGB * config.rates.storageGBMonth;
  if (!config.plan) return {cpu,ram,monthly:resourceEstimate};
  const billing=config.plan.billing || {model:'estimate',price:0,credit:0};
  const overage=billing.model==='metered'?Math.max(0,resourceEstimate-billing.credit):0;
  const monthly=billing.model==='fixed'?billing.price:billing.model==='metered'?billing.price+overage:resourceEstimate;
  return {cpu,ram,capacityCPU,capacityRAM,resourceEstimate,monthly,overage,billingModel:billing.model};
}
export function stackName(config) {
  if (path.resolve(config.projectPath) === initialInfra.projectPath) return 'systems-lab-freshphones';
  const slug = path.basename(config.projectPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'project';
  const hash = createHash('sha256').update(path.resolve(config.projectPath)).digest('hex').slice(0, 10);
  return `systems-lab-${slug}-${hash}`;
}
export function makeCompose(config, directory, secret) {
  validateInfra(config);
  const services = {}, volumes = {};
  const cap = id => ({ cpus: config.resources[id].cpu, mem_limit: `${config.resources[id].ram}m`, memswap_limit: `${config.resources[id].ram}m`, pids_limit: 512, restart: 'no', logging: { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } } });
  const add = (id, data) => { if (config.resources[id].enabled) services[id] = { ...data, ...cap(id) }; };
  const env = {
    NODE_ENV: 'development', HOST: '0.0.0.0', PORT: '4100',
    DATABASE_URL: `postgresql://lab:${secret}@postgres:5432/freshphones_lab`,
    REDIS_URL: `redis://:${secret}@redis:6379/0`, REDIS_NAMESPACE: 'systems-lab',
    BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: `http://localhost:${config.entryPort}/api/auth`,
    WEB_ORIGIN: `http://localhost:${config.entryPort}`, PUBLIC_SITE_ORIGIN: `http://localhost:${config.entryPort}`,
    AUTH_REQUIRE_STAFF_MFA: 'false', PRIVATE_STORAGE_PROVIDER: 'local', PRIVATE_STORAGE_DIR: '/app/.local/private',
  };
  const apiBuild = { context: config.projectPath, dockerfile: 'apps/api-ts/Dockerfile' };
  if (config.mode === 'detected') {
    addApplications(config, services, volumes, cap, secret);
  } else if (config.mode === 'freshphones') {
    add('api', { build: apiBuild, environment: env, volumes: ['privatefiles:/app/.local'], depends_on: { migrate: { condition: 'service_completed_successfully' }, redis: { condition: 'service_healthy' } } });
    add('worker', { build: apiBuild, command: ['node', 'dist/worker.js'], environment: env, volumes: ['privatefiles:/app/.local'], depends_on: { migrate: { condition: 'service_completed_successfully' }, redis: { condition: 'service_healthy' } } });
    if(config.resources.api.enabled || config.resources.worker.enabled) services.migrate = { build: { ...apiBuild, target: 'migrations' }, environment: { DATABASE_URL: env.DATABASE_URL }, depends_on: { postgres: { condition: 'service_healthy' } }, ...cap('api') };
    volumes.privatefiles = {};
    add('web', { build: { context: config.projectPath, dockerfile: 'apps/web/Dockerfile', args: { NEXT_PUBLIC_API_URL: `http://localhost:${config.entryPort}`, NEXT_PUBLIC_LANDING_URL: `http://localhost:${config.entryPort}`, API_PROXY_URL: 'http://api:4100' } }, environment: { API_PROXY_URL: 'http://api:4100', NEXT_PUBLIC_API_URL: `http://localhost:${config.entryPort}`, PORT: '3000' }, depends_on: ['api'] });
  } else {
    add('web', { build: { context: config.projectPath, dockerfile: config.dockerfile }, environment: {
      PORT: String(config.appPort), HOST: '0.0.0.0', DATABASE_URL: env.DATABASE_URL,
      REDIS_URL: env.REDIS_URL, KAFKA_BROKERS: 'kafka:9092',
    } });
  }
  add('postgres', { image: 'postgres:16-alpine', environment: { POSTGRES_USER: 'lab', POSTGRES_PASSWORD: secret, POSTGRES_DB: 'freshphones_lab' }, command: ['postgres', '-c', `max_connections=${config.databaseConnections}`, '-c', `shared_buffers=${config.databaseBuffers}MB`], volumes: ['pgdata:/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U lab -d freshphones_lab'], interval: '3s', timeout: '3s', retries: 30 } });
  if (services.postgres) volumes.pgdata = {};
  add('redis', { image: 'redis:8.2-alpine', command: ['redis-server', '--requirepass', secret, '--appendonly', 'yes', '--maxmemory', `${config.redisMemory}mb`, '--maxmemory-policy', 'noeviction'], volumes: ['redisdata:/data'], healthcheck: { test: ['CMD', 'redis-cli', '-a', secret, '--no-auth-warning', 'ping'], interval: '3s', timeout: '3s', retries: 30 } });
  if (services.redis) volumes.redisdata = {};
  add('kafka', { image: 'apache/kafka:4.0.0', environment: {
    KAFKA_NODE_ID: '1', KAFKA_PROCESS_ROLES: 'broker,controller', KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
    KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092', KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
    KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:9093', KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1', KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0', KAFKA_LOG_DIRS: '/tmp/kraft-combined-logs',
    KAFKA_HEAP_OPTS: `-Xms128m -Xmx${Math.max(128, Math.floor(config.resources.kafka.ram * .4))}m`,
  }, volumes: ['kafkadata:/tmp/kraft-combined-logs'] });
  if (services.kafka) volumes.kafkadata = {};
  add('rabbitmq', { image: 'rabbitmq:4-management-alpine', environment: { RABBITMQ_DEFAULT_USER: 'lab', RABBITMQ_DEFAULT_PASS: secret }, ports: ['127.0.0.1:15673:15672'], volumes: ['rabbitdata:/var/lib/rabbitmq'] });
  if (services.rabbitmq) volumes.rabbitdata = {};
  add('mongodb', { image: 'mongo:8', environment: { MONGO_INITDB_ROOT_USERNAME: 'lab', MONGO_INITDB_ROOT_PASSWORD: secret }, command: ['mongod', '--wiredTigerCacheSizeGB', String(Math.max(.25, config.resources.mongodb.ram / 1024 * .25))], volumes: ['mongodata:/data/db'] });
  if (services.mongodb) volumes.mongodata = {};
  add('mysql', { image: 'mysql:8.4', environment: { MYSQL_DATABASE: 'lab', MYSQL_USER: 'lab', MYSQL_PASSWORD: secret, MYSQL_ROOT_PASSWORD: secret }, volumes: ['mysqldata:/var/lib/mysql'] });
  if (services.mysql) volumes.mysqldata = {};
  add('minio', { image: 'minio/minio:latest', command: ['server', '/data', '--console-address', ':9001'], environment: { MINIO_ROOT_USER: 'labadmin', MINIO_ROOT_PASSWORD: secret }, ports: ['127.0.0.1:19000:9000', '127.0.0.1:19001:9001'], volumes: ['objectdata:/data'] });
  if (services.minio) volumes.objectdata = {};
  add('prometheus', { image: 'prom/prometheus:v3.5.0', ports: ['127.0.0.1:19090:9090'], command: ['--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.retention.time=24h'], volumes: [`${path.join(directory, 'prometheus.json')}:/etc/prometheus/prometheus.yml:ro`, 'promdata:/prometheus'] });
  if (services.prometheus) volumes.promdata = {};
  add('grafana', { image: 'grafana/grafana:12.1.0', ports: ['127.0.0.1:13000:3000'], environment: { GF_SECURITY_ADMIN_USER: 'lab', GF_SECURITY_ADMIN_PASSWORD: secret, GF_ANALYTICS_REPORTING_ENABLED: 'false', GF_USERS_ALLOW_SIGN_UP: 'false' }, volumes: ['grafanadata:/var/lib/grafana', `${path.join(directory, 'grafana-datasources.json')}:/etc/grafana/provisioning/datasources/local.yaml:ro`] });
  if (services.grafana) volumes.grafanadata = {};
  add('nginx', { image: 'nginx:1.28-alpine', ports: [`127.0.0.1:${config.entryPort}:80`], volumes: [`${path.join(directory, 'nginx.conf')}:/etc/nginx/conf.d/default.conf:ro`], depends_on: config.mode === 'detected' ? [config.definition.entry].filter(id=>id && id!=='nginx') : config.mode === 'freshphones' ? ['web', 'api'] : ['web'] });
  for(const data of Object.values(services)){if(Array.isArray(data.depends_on))data.depends_on=data.depends_on.filter(id=>services[id]);else if(data.depends_on)data.depends_on=Object.fromEntries(Object.entries(data.depends_on).filter(([id])=>services[id]));}
  return { name: stackName(config), services, volumes };
}

export class Infra {
  constructor(root, log, dockerExecute = execute) {
    this.baseDirectory = path.join(root, 'workspace', 'infra'); this.log = log;
    this.config = structuredClone(initialInfra); this.status = 'idle'; this.error = null;
    this.containers = []; this.stats = []; this.db = null; this.operation = null;
    this.docker = { available: false, message: 'Checking Docker…' };
    this.dockerHost = null;
    this.dockerExecute = dockerExecute;
  }
  directoryFor(config) { return stackName(config) === 'systems-lab-freshphones' ? this.baseDirectory : path.join(this.baseDirectory, 'projects', stackName(config)); }
  get directory() { return this.directoryFor(this.config); }
  async init() {
    await mkdir(this.baseDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(path.join(this.baseDirectory, 'settings.json'), 'utf8'));
      this.config = validateInfra({ ...initialInfra, ...saved, resources: { ...structuredClone(initialInfra.resources), ...saved.resources } });
    }
    catch (e) { if (e.code !== 'ENOENT') this.error = e.message; }
    try { this.secret = await readFile(path.join(this.baseDirectory, 'secret'), 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.secret = randomBytes(32).toString('hex'); await writeFile(path.join(this.baseDirectory, 'secret'), this.secret, { mode: 0o600 }); }
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 6000); this.timer.unref();
  }
  dockerArgs(...args) { return [...(this.dockerHost ? ['--host', this.dockerHost] : []), ...args]; }
  composeArgs(...args) { return this.dockerArgs('compose', '-p', stackName(this.config), '-f', path.join(this.directory, 'compose.json'), ...args); }
  async connectDocker() {
    const probe = async host => {
      const args = [...(host ? ['--host', host] : []), 'info', '--format', '{{json .}}'];
      const { stdout } = await this.dockerExecute('docker', args, { timeout: 3000, maxBuffer: 100000 });
      const info = JSON.parse(stdout);
      if (!info.ServerVersion) throw new Error('Docker did not return a running server version.');
      return info;
    };
    let info;
    try { info = await probe(this.dockerHost); }
    catch (original) {
      if (this.dockerHost || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) throw original;
      const socket = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'docker.sock');
      try {
        const host = `unix://${socket}`;
        info = await probe(host);
        this.dockerHost = host;
      } catch { throw original; }
    }
    const rootless = (info.SecurityOptions || []).some(option => option.includes('rootless'));
    this.docker = { available: true, message: `Docker ${info.ServerVersion}${rootless ? ' · rootless' : ''}`,
      rootless, cpuLimit: Boolean(info.CpuCfsQuota), memoryLimit: Boolean(info.MemoryLimit), endpoint: this.dockerHost || 'Current Docker context' };
    return this.docker;
  }
  async prepare(config) {
    if (this.operation) throw new Error('Wait for the current infrastructure action to finish before changing its configuration.');
    validateInfra(config);
    await access(config.projectPath);
    if(config.mode==='detected'){for(const [id,s] of Object.entries(config.definition.services)){if(config.resources[id]?.enabled && s.kind==='app' && s.dockerfile)await access(path.join(config.projectPath,s.dockerfile));}}
    else await access(path.join(config.projectPath, config.mode === 'freshphones' ? 'apps/api-ts/Dockerfile' : config.dockerfile));
    if (config.mode === 'freshphones') await access(path.join(config.projectPath, 'apps/web/Dockerfile'));
    const total = estimate(config);
    if (total.ram > os.totalmem() / 1024 / 1024 * .8) throw new Error('RAM caps exceed 80% of host RAM. Leave space for the OS and k6.');
    const directory = this.directoryFor(config);
    await mkdir(directory, { recursive: true });
    const compose = makeCompose(config, directory, this.secret);
    if(!Object.keys(compose.services).length)throw new Error('Add at least one service before preparing the stack.');
    const nginx = nginxConfig(config);
    await writeFile(path.join(directory, 'nginx.conf'), nginx);
    await writeFile(path.join(directory, 'prometheus.json'), JSON.stringify({ global: { scrape_interval: '15s' }, scrape_configs: [{ job_name: 'prometheus', static_configs: [{ targets: ['localhost:9090'] }] }] }));
    await writeFile(path.join(directory, 'grafana-datasources.json'), JSON.stringify({ apiVersion: 1, datasources: config.resources.prometheus.enabled ? [{ name: 'Local Prometheus', type: 'prometheus', access: 'proxy', url: 'http://prometheus:9090', isDefault: true }] : [] }));
    await writeFile(path.join(directory, 'compose.json'), JSON.stringify(compose, null, 2), { mode: 0o600 });
    await writeFile(path.join(this.baseDirectory, 'settings.json'), JSON.stringify(config, null, 2));
    const changedProject = stackName(this.config) !== stackName(config);
    this.config = config;
    if (changedProject) { this.containers = []; this.stats = []; this.db = null; this.status = 'idle'; }
    this.error = null;
    this.log('infra', 'Prepared isolated Compose stack. CPU/RAM caps apply to runtime containers; image builds use host resources.');
    return { path: path.join(directory, 'compose.json'), estimate: total };
  }
  startOperation(args, label) {
    if (this.operation) throw new Error('Infrastructure action in progress.');
    if (!this.docker.available) throw new Error('Docker is not connected. Check the runtime status below; preparing a stack does not require Docker.');
    if (args[0] === 'up' && (!this.docker.cpuLimit || !this.docker.memoryLimit)) throw new Error('This Docker runtime cannot enforce CPU and RAM limits. Enable cgroup v2/systemd resource support before starting the stack.');
    this.status = label; this.error = null;
    const child = spawn('docker', this.composeArgs(...args), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.operation = child;
    const scrub = text => String(text).replaceAll(this.secret, '[local-secret]');
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => this.log('docker', scrub(line)));
    child.on('error', error => { this.error = error.message; });
    child.on('close', code => {
      this.operation = null;
      this.status = code === 0 ? `${label} complete` : 'error';
      if (code !== 0) this.error ||= 'Docker action failed. Check Event log; Docker must be running and accessible.';
      this.log('infra', `${this.status} (exit ${code})`);
      this.refresh();
    });
  }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const project = stackName(this.config);
    try {
      await this.connectDocker();
      try {
        const ps = await execute('docker', this.composeArgs('ps', '-a', '--format', 'json'), { timeout: 3000 });
        if (project !== stackName(this.config)) return;
        const raw = ps.stdout.trim();
        this.containers = raw ? (raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').map(s => JSON.parse(s))) : [];
        const ids = this.containers.filter(c => c.State === 'running').map(c => c.ID);
        if (ids.length) {
          const usage = await execute('docker', this.dockerArgs('stats', '--no-stream', '--format', '{{json .}}', ...ids), { timeout: 5000 });
          if (project !== stackName(this.config)) return;
          this.stats = usage.stdout.trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
        } else this.stats = [];
        if (this.containers.some(c => c.Service === 'postgres' && c.State === 'running')) {
          const database = await execute('docker', this.composeArgs('exec', '-T', 'postgres', 'psql', '-U', 'lab', '-d', 'freshphones_lab', '-Atc', `SELECT json_build_object('connections',numbackends,'transactions',xact_commit+xact_rollback,'cacheHitPercent',round(100.0*blks_hit/NULLIF(blks_hit+blks_read,0),2),'databaseBytes',pg_database_size(datname)) FROM pg_stat_database WHERE datname='freshphones_lab'`), { timeout: 3000 });
          if (project !== stackName(this.config)) return;
          this.db = JSON.parse(database.stdout.trim());
        } else this.db = null;
      } catch { /* Prepared/running state is shown separately from Docker availability. */ }
    } catch (error) {
      const detail = (error.stderr || error.message).trim().split('\n').slice(-1)[0].slice(0, 1000);
      const message = /permission denied|access denied/i.test(detail) ? 'Docker socket access denied' : /no such file|cannot connect|failed to connect|connection refused/i.test(detail) ? 'Docker is not running' : 'Docker connection failed';
      this.docker = { available: false, message, detail, endpoint: this.dockerHost || 'Current Docker context' };
      this.containers = []; this.stats = []; this.db = null;
    } finally { this.refreshing = false; }
  }
  snapshot() {
    return { config: this.config, stackName: stackName(this.config), composePath: path.join(this.directory, 'compose.json'), status: this.status, error: this.error, docker: this.docker, containers: this.containers, stats: this.stats, db: this.db,
      busy: Boolean(this.operation), estimate: estimate(this.config), host: { cpu: os.availableParallelism(), totalRAM: os.totalmem(), freeRAM: os.freemem() } };
  }
}
