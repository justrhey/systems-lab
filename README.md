# Systems Lab

A local distributed-systems workbench with k6 virtual users, a macOS-inspired GUI, a code sandbox, and project-defined Docker infrastructure.

## Run

Requires Rust 1.94+ (Cargo), Node.js 22+, the k6 binary in `bin/k6` (or `K6_BIN`), and Docker Compose for infrastructure containers.

```sh
cargo run --release
```

Open http://localhost:8787. The server listens on loopback only. The HTTP controller is written in Rust with Axum/Tokio. Cargo downloads its dependencies on the first build; `npm start` also launches this Rust backend. There are no npm dependencies or cloud deployments. `PORT` changes the local UI port. `SYSTEMS_LAB_ROOT` overrides the project/assets/workspace directory for an installed binary (the default is the build-time project folder). The installed k6 binary is the official Linux AMD64 v2.3.0 release; its SHA-256 was checked against the release checksum manifest. Other operating systems should install [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) and pass its absolute path through `K6_BIN`.

### Backend boundaries

Rust owns HTTP/static serving, local origin checks, project validation and atomic saves, network proxy/faults/traces, sandbox process lifecycle, k6 execution, and metric aggregation. The UI and existing `workspace/project.json` format are preserved.

Node remains required for editable JavaScript sandbox handlers (`runner.mjs`) and the existing Docker infrastructure tool (`infra.mjs`), accessed through private line-delimited stdin/stdout IPC (`infra-adapter.mjs`). The infrastructure adapter has no HTTP listener; Rust owns its lifecycle and exposes its results through the existing API. The Docker catalog, Compose generation, polling and controls have not yet been ported to Rust. FreshPhones itself keeps its existing implementation. `server.mjs` is a compatibility launcher for the Rust binary.

### Docker connections

The lab first tries your current Docker context. If no explicit `DOCKER_HOST` or `DOCKER_CONTEXT` is set and that connection fails, it tries the current user's rootless socket at `$XDG_RUNTIME_DIR/docker.sock` (normally `/run/user/1000/docker.sock`). Once selected, the same endpoint is used for Compose, live stats, database queries, and container controls. The lab does not change your global Docker context or request an administrator password.

Rootless Docker runs as a user service: `systemctl --user start docker`. Rootless CPU/RAM limits require cgroup v2 with delegated CPU/memory controllers; the lab checks Docker's capability flags before starting capped workloads. If those controls are unavailable, startup is blocked rather than silently running uncapped. The GUI shows a readable connection state, with the original error available under **Docker connection details**.

## Choose any local project

The **Project** dropdown searches local projects across the folders under `Desktop/projects`, including Apps and Tools. Search by name or folder; keyboard arrows, Enter and Escape work in the menu. `SYSTEMS_LAB_PROJECTS_ROOT` sets alternative project roots (colon-separated on Linux). **Use another folder…** keeps manual paths available for projects elsewhere.

Projects are listed even without a Dockerfile. **Setup needed** means the project needs a Dockerfile before its infrastructure can start; selection alone does not install or adapt its runtime. Detected Dockerfiles are suggested in the Dockerfile field, and `EXPOSE` supplies an initial HTTP port when present. Confirm the internal port and bind to `0.0.0.0`.

The **Run profile** dropdown offers **Detected services** and a generic single-Dockerfile profile. Detected services loads `systems-lab.json` from the selected project, or scans its code when that file is absent. Selecting a new project supplies a basic homepage k6 journey; customize routes/authentication for the actual app. Project names update throughout the workspace. Container controls and project journeys cannot act on a different, unprepared selection.

Custom projects receive path-derived Compose identities, separate named volumes, and configuration under `workspace/infra/projects/`. Existing FreshPhones uses its original stack name and directory. Switching selection does not delete or stop existing stacks. Use a different gateway port for simultaneously running stacks; optional management ports also need to be distinct. The dropdown does not convert multi-service application repos into a full deployment automatically.

## Workload requirements before infrastructure choices

Every selected project has a **Learn from a test** section before capacity and resource controls. Start the app and run a small baseline first; the detailed worksheet is optional under **Review automatic values or customize**. Record average/peak RPS; read-to-write ratio; request/response sizes; dataset, working-set and growth; acceptable p50/p95/p99 latency; availability and durability targets; burst shape; and geographic distribution. Include units and a time window where relevant. Empty fields remain explicitly unknown; placeholders are examples, never measurements.

**Save custom values** persists your overrides independently of Docker or stack preparation, including projects without Dockerfiles. Switching dropdown projects saves the previous project's requirements and loads the selected project's values. Overrides live in ignored `workspace/workloads.json`, keyed by absolute project folder. Measured observations live separately in `workspace/observations.json` and are saved by Rust after each test even if the browser is closed. Project test measurements automatically populate rates, approximate HTTP-method mix, transferred bytes/request, response percentiles, test burst setup, and the lab PostgreSQL size when available. Demo observations use their own key and never populate a real project worksheet. Automatic values update with the next project run; custom overrides stay in place until **Use automatic** is selected. Failed/stopped runs are labeled, not presented as capacity guarantees. Measured response times are a baseline, not an inferred business latency goal. Growth, real-world geography, availability, durability and the frequently accessed data set remain unknown unless supplied or separately profiled. Requirements are planning inputs; observed k6 results remain separate, and filling fields does not automatically select Redis, Kafka, or sharding.

## Overall VPS / environment plan

In **Infrastructure → Resources**, choose one total CPU/RAM size for the project, or enter the actual specifications of your VPS offer. The optional price is a reference supplied by you; $12 alone does not determine CPU or RAM. Small/Standard/Large/Heavy are local capacity presets, not provider subscription claims.

The lab automatically splits the total across enabled services. Adding or removing a service rebalances those shares in automatic mode. Use the × action in a service row or **Remove** in its inspector header; **Undo** restores the last removal. Removal edits the plan, and Prepare/Start applies the change while retaining data volumes. Every service can be removed, including API, worker, database and gateway. Dependency warnings explain what may fail; they do not prevent intentional removal. Save the workspace or project file to retain exclusions across reloads and rescans. Per-service tuning is under **Advanced**; custom shares cannot exceed the overall CPU/RAM budget. **Auto-distribute** restores balanced shares. These are fixed per-container ceilings whose sum stays within the plan, rather than elastic borrowing from a shared cgroup. Existing FreshPhones migration dependencies let the one-shot migration reuse the API share before API/worker startup. Storage remains a planning budget without an enforced disk quota.

**Pricing & overage** offers three models:

- Capacity estimate only: resource rates × chosen capacity × configured hours, plus planned storage.
- Fixed VPS price: the monthly amount entered by you.
- Subscription + usage overage: base fee + max(0, projected resource cost − included usage credit).

The usage projection assumes the selected capacity for the configured hours. It is not metering from a load run or a provider invoice; bandwidth, requests, managed-service premiums, tax and other charges may need additional modeling. The lab has no cloud billing connection and cannot create provider charges.

Plans are remembered by project. **Prepare stack** saves the plan and generates caps; **Start stack** applies them. Test the **Project stack**, not the uncapped Code sandbox. Compare response times, failed requests, achieved throughput and container usage at the load you need. A passing local test is evidence for this workload and configuration; it does not reproduce a VPS provider's CPU generation, contention, disk or network.

## Consistent dropdowns

All select controls use the same custom menu, including terminal filters, run target, connection selectors, environment size, billing model, and editable Dockerfile suggestions. Arrow keys/Home/End navigate, Enter selects, Escape cancels and returns focus, Tab commits, and select-only controls support typeahead. Menus work inside dialogs and stay within the viewport. The original hidden form controls retain values/events and dynamic-option updates.

## Resource catalog

**Add resource** opens built-in presets rather than a blank service-name prompt:

| Resource | Purpose | Default |
| --- | --- | --- |
| Application | Dockerfile plus explicit runtime settings | Detected / project file |
| Worker | Explicit worker runtime script, not just an installed queue package | Detected / project file |
| PostgreSQL, Redis, MySQL, MongoDB | Runtime clients or root Compose image declarations | Detected candidates; review evidence |
| Kafka, RabbitMQ, MinIO | Runtime clients or root Compose image declarations | Detected candidates; review evidence |
| Nginx | Root Compose declaration or explicitly added lab gateway | Optional |
| Prometheus, Grafana | Explicit configuration / Add resource | Optional |

Every container, including the one-shot migration container, receives `cpus`, `mem_limit`, equal `memswap_limit` (no extra swap), a PID limit, and log rotation. CPU caps are fractions of a core, not a promise of dedicated compute. Image builds use host resources; they are not governed by these runtime caps. A Docker runtime with working CPU/memory cgroups is necessary to enforce caps. Config generation has been checked; container enforcement has not been measured on this host because Docker is unavailable.

Optional services do not automatically change the application's architecture. FreshPhones uses PostgreSQL and Redis, not Kafka/RabbitMQ/MySQL/MongoDB. Its private-file volume remains the storage default when MinIO is enabled. Prometheus needs app exporters/instrumentation to collect application metrics; only its self-scrape is supplied. Redis does not automatically cache API responses. Kafka is a single-node learning environment, not a highly available cluster.

## FreshPhones

1. Select **FreshPhones** and confirm its absolute folder path.
2. Set CPU and RAM caps in each service inspector. Set PostgreSQL max connections and shared buffers, and Redis's data memory separately from their container RAM.
3. **Prepare stack** writes the isolated configuration under `workspace/infra/`.
4. **Start stack** builds the repo's existing Dockerfiles, starts PostgreSQL/Redis, runs Prisma migrations in the dedicated `freshphones_lab` database, and starts the API, worker, web, and Nginx.
5. Wait for the image downloads and application builds to finish. **Start stack** launches this work in the background; the site does not become available immediately. Follow progress in the startup message or **Event log**. Open http://localhost:18080 after the gateway starts, then select **Project stack** in the k6 controls. **Start demo** starts only the code sandbox and does not start this project site.

The Compose project is `systems-lab-freshphones`. Its named volumes are separate from the repo's `freshphonesph` development stack. No source files, existing environment files, production credentials, or existing databases are imported or modified. A generated local-only secret is kept in ignored workspace files with mode 0600. Do not commit or share those files. Production auth checks are not bypassed; the isolated API explicitly runs in development mode over local HTTP.

The provided FreshPhones journey visits `/`, `/api/catalog`, `/about`, and `/api/agents/verify?q=Lab%20Test`, with pauses and branching. It is read-only and exercises the public app/API. Empty catalogs are valid on a fresh database. Rate limits remain enabled; HTTP 429 counts as a failure. Staff/customer journeys require synthetic accounts and appropriate permissions in the lab database; no real credentials or financial records are supplied. The API's current Prisma pool is 10 connections per process, independent of PostgreSQL's max-connection cap.

For a different single-service project, choose **Dockerfile project**, supply its folder, relative Dockerfile path, and internal HTTP port. The app must bind to `0.0.0.0` inside its container. The lab supplies `PORT`, `HOST`, `DATABASE_URL`, `REDIS_URL`, and `KAFKA_BROKERS`; adapt the project if it expects other environment variables. Its schema migrations, seed data, and k6 journey must match that project. Rebuild the stack after editing project code in its repository.

### Optional interfaces

Published ports bind to 127.0.0.1 only. Database/broker application ports remain private to the Compose network.

| Interface | Local address |
| --- | --- |
| Nginx / project | http://localhost:18080 (configurable) |
| RabbitMQ management | http://localhost:15673 |
| MinIO API / console | http://localhost:19000 / http://localhost:19001 |
| Prometheus | http://localhost:19090 |
| Grafana | http://localhost:13000 |

Local management users are `lab` (RabbitMQ/Grafana) and `labadmin` (MinIO). Their generated password is in `workspace/infra/secret`; it is not a production credential. Change fixed management ports in the generated file for conflicts, or keep optional services disabled. PostgreSQL's volume has no enforced disk quota; the storage setting is a planning figure.

## Code sandbox

The code sandbox runs editable JavaScript handlers in real Node.js child processes. It starts with gateway → API → store and a k6 shopper journey with distinct logins, per-user state, realistic pauses, catalog browsing, and occasional purchases. The store is in memory and resets on restart.

Code templates include an HTTP API, forwarding gateway, and slow service. Use the connection selectors to add directed links. Latency, HTTP failure probability, and disconnection apply to `ctx.call()` traffic through the lab proxy. These are application-layer controls; this is not a kernel TCP/router/LAN emulator. The displayed linear topology follows service order; explicit directed link controls are authoritative for extra connections.

```js
export default async function (req, ctx) {
  await ctx.sleep(20);
  return ctx.call('api', req.path, {
    method: req.method,
    body: req.body,
  });
}
```

`req` includes method, path, body text, and headers. `ctx.reply(status, data)` returns a custom status. Save and restart demo services to apply server code. Network changes apply to the next call. Demo processes are not Docker containers and do not have CPU/RAM caps. Use Infrastructure for capped project tests. Only trusted code belongs in this local workbench: edited server and k6 scripts execute with the local user's permissions.

## Measurements and estimates

The user count has no small application ceiling: enter 1,000, 10,000, 100,000, or another positive whole number. Input must be exactly representable by the browser/JSON (a safe integer). Accepted input is not a claim that the host or target can sustain that concurrency; the load generator shares this machine with the local stack. Ramp gradually and inspect measured failures and latency.

The GUI shows real k6 request count, failure rate, check results, active VUs, rolling 10-second throughput, and p95 over the latest 20,000 request samples. It streams k6's JSON output from `json=-`; `/dev/stdout` cannot be reopened when a runtime provides a socket-backed child-process pipe. A completed run preserves its last statistics in memory until another run or server restart. k6 exit 99 is shown as **thresholds failed**.

Docker usage shows measured CPU, memory/limit, network I/O and block I/O. PostgreSQL reports live connections and database bytes. No sample usage is substituted when Docker is offline. **Pause/Resume** stalls a container; **Stop/Start** creates and recovers an outage. Container state is polled periodically; underlying app readiness is separate from a running process.

The monthly estimate uses editable illustrative USD rates for vCPU-hours, GiB-RAM-hours, and planned storage. It uses selected capacity, not usage. It is not a live AWS/GCP/Azure quote and excludes request fees, egress, managed-service premiums, tax, and host electricity. Local hardware contention and network conditions differ from cloud hardware; these tests do not establish cloud equivalence.

## Compact workspace and results

The desktop workspace keeps navigation and run controls visible. Infrastructure uses **Project**, **Resources**, **Measurements**, and **Usage** tabs rather than stacking every section vertically. Code, settings, tables and long output use bounded panes; narrow/short layouts reflow into document flow.

**Results & terminal** has Summary, Terminal, and Split view. The summary shows whole-run successful/failed requests, check results and response percentiles, plus suggested inspection steps. Grouped issues count only retained log entries, never the total number of failed requests. Terminal output is read-only and limited to the latest 160 entries, with search, service/issue filters, pause/resume, follow, copy, and download. **Compare a smaller run** only prepares the next user count; it does not launch a test.

UX rationale, evidence boundaries and validation criteria are in [docs/ux-results-workspace.md](docs/ux-results-workspace.md). Browser checks cover each default page at 1280×800, keyboard tabs, narrow widths, healthy/empty/error states and terminal actions. No human usability study or complete accessibility-conformance audit has been performed.

## Verification

```sh
cargo test
cargo build
node --test test/*.test.mjs
docker compose -f workspace/infra/compose.json config --quiet
```

The integration test starts the compiled Rust binary in its own temporary checkout and localhost service stack; it verifies distinct sessions, unauthorized requests, healthy k6 traffic, a disconnected link, 100% injected failure with threshold failure, and service cleanup. It needs the installed k6 binary and permission to bind localhost ports. It does not run Docker containers or change FreshPhones.

Browser checks cover the resource picker, Kafka preset/inspector, light/dark themes, and phone/tablet/desktop layouts. Design evidence and its limitations are available in **Design notes**. No human usability test of this app has been conducted.

On this workstation, the server runs as user service `systems-lab.service`; use `systemctl --user stop systems-lab` or `systemctl --user restart systems-lab`. It is not enabled at login. For manual `cargo run` sessions, stop it with Ctrl+C; owned demo and k6 processes are cleaned up. Infrastructure containers intentionally have a separate lifecycle: use **Stop stack** or `docker compose -p systems-lab-freshphones -f workspace/infra/compose.json stop`. Persistent volumes are retained.


## Project detection file

Select a folder under **Infrastructure → Project**. The Rust scanner reads package manifests, Dockerfiles, and recognized image declarations in root Compose files. It skips dependency/build folders, dotfiles, symlinks, and files larger than 1 MB, with a depth/entry limit. It does not execute project code or read `.env`. Installed client packages indicate candidate infrastructure, not proof of active use. A worker requires an explicit `worker:start`, `start:worker`, or `worker` script; a BullMQ dependency alone never creates one. Non-Node projects can use a Dockerfile and this same manifest.

**Save project file** creates or updates `systems-lab.json` inside that project. Workspace Save and Prepare/Start also save the current definition. **Rescan code** refreshes evidence and adds new candidates while keeping your runtime settings and removals (`enabled: false`). Remove an obsolete definition from the file if you no longer want to retain it. The inspector shows supporting filenames and line numbers. Source edits do not silently rebuild running containers.

```json
{
  "version": 1,
  "entry": "web",
  "services": {
    "web": {
      "kind": "app",
      "enabled": true,
      "dockerfile": "Dockerfile",
      "port": 3000,
      "environment": {"HOST": "0.0.0.0", "PORT": "3000"},
      "evidence": [{"file": "Dockerfile", "line": 1, "reason": "Application image"}]
    }
  }
}
```

App IDs are project-specific. Optional fields are `label`, `role`, `command` (argument array), Dockerfile `target`, `buildArgs`, `environment`, named `volumes`, `dependsOn`, and `oneShot` for migrations. Infrastructure kinds use their catalog IDs. The HTTP `entry` publishes directly on the gateway port when Nginx is absent. With Nginx, optional `routes` entries contain `path`, `service`, and optionally `port`; removed upstreams are omitted and an absent homepage returns 503. Removed dependencies are pruned from Compose, but application code may still need them.

Use `${LAB_DATABASE_URL}`, `${LAB_REDIS_URL}`, `${LAB_SECRET}`, and `${LAB_ENTRY_ORIGIN}` in string environment/build arguments for isolated generated lab values. Do not store production credentials in this file. Scanning cannot infer authentication secrets, schema migrations, all build contexts or application integration; review and customize the file before starting an unfamiliar project. Compose detection supplies evidence for supported infrastructure images rather than importing arbitrary YAML deployment settings.

FreshPhones now has its own file with verified API/web/worker/migration definitions. Its Nginx entry is explicitly labeled `lab-adapter`, not inferred from source. Existing Compose identity and named data volumes are preserved.
