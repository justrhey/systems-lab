mod inspection;
mod metrics;
mod projects;
mod workloads;

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::Request,
    response::Response,
};
use metrics::Metrics;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex as AsyncMutex, oneshot, watch},
};

type Result<T> = std::result::Result<T, String>;
// Match the exact integer range of the browser/JSON input, not a load policy.
const MAX_EXACT_INTEGER: u64 = 9_007_199_254_740_991;
fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn clock() -> String {
    let secs = now() / 1000 % 86400;
    format!(
        "{:02}:{:02}:{:02} UTC",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

#[derive(Clone)]
struct Process {
    stop: watch::Sender<bool>,
    running: Arc<AtomicBool>,
    done: watch::Receiver<bool>,
}
impl Process {
    fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    async fn stop(&self) {
        let _ = self.stop.send(true);
        let mut done = self.done.clone();
        let _ = done.wait_for(|v| *v).await;
    }
}

async fn wait_child(
    mut child: tokio::process::Child,
    mut stop: watch::Receiver<bool>,
) -> std::io::Result<std::process::ExitStatus> {
    tokio::select! {
        status = child.wait() => status,
        _ = stop.changed() => {
            // The owner of Child sends its signals, avoiding stale PID races.
            if let Some(pid) = child.id() { unsafe { libc::kill(pid as i32, libc::SIGTERM); } }
            match tokio::time::timeout(Duration::from_millis(2500), child.wait()).await {
                Ok(status) => status,
                Err(_) => { child.start_kill()?; child.wait().await }
            }
        }
    }
}
struct Service {
    process: Process,
    port: u16,
}
struct Data {
    project: Value,
    services: HashMap<String, Service>,
    engine: Option<Process>,
    run: Value,
    metrics: Metrics,
    observations: Value,
    logs: VecDeque<Value>,
    traces: VecDeque<Value>,
    infra: Value,
}
struct App {
    root: PathBuf,
    port: u16,
    data: Mutex<Data>,
    action: AsyncMutex<()>,
    client: reqwest::Client,
    bridge_input: AsyncMutex<Option<tokio::process::ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<()>>>>,
    sequence: AtomicU64,
}
impl App {
    fn log(&self, service: &str, message: &str) {
        let mut d = self.data.lock().unwrap();
        d.logs.push_back(json!({"time":clock(),"service":service,"message":message.chars().take(1500).collect::<String>()}));
        if d.logs.len() > 160 {
            d.logs.pop_front();
        }
    }
    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    fn launch(
        self: &Arc<Self>,
        executable: &str,
        args: &[String],
        name: &str,
        env: &[(&str, String)],
    ) -> Result<Process> {
        let mut cmd = Command::new(executable);
        cmd.args(args)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in env {
            cmd.env(key, value);
        }
        let mut child = cmd.spawn().map_err(|e| format!("{name}: {e}"))?;
        let (stop, stop_rx) = watch::channel(false);
        let running = Arc::new(AtomicBool::new(true));
        let (done_tx, done) = watch::channel(false);
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let app = self.clone();
        let label = name.to_owned();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                app.log(&label, &line);
            }
        });
        let app = self.clone();
        let label = name.to_owned();
        let output = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if label == "k6" {
                    if let Ok(point) = serde_json::from_str::<Value>(&line) {
                        app.data.lock().unwrap().metrics.point(&point);
                    }
                } else {
                    app.log(&label, &line);
                }
            }
        });
        let app = self.clone();
        let label = name.to_owned();
        let alive = running.clone();
        tokio::spawn(async move {
            let status = wait_child(child, stop_rx).await;
            // Drain metric output before publishing the terminal run status.
            let _ = output.await;
            alive.store(false, Ordering::SeqCst);
            if label == "k6" {
                let code = status.ok().and_then(|s| s.code());
                let (message, saved) = {
                    let mut d = app.data.lock().unwrap();
                    let stopped = d.run["status"] == "stopping";
                    d.run["exitCode"] = json!(code);
                    d.run["finished"] = json!(now());
                    d.run["status"] = json!(if stopped {
                        "stopped"
                    } else if code == Some(0) {
                        "passed"
                    } else if code == Some(99) {
                        "thresholds failed"
                    } else {
                        "error"
                    });
                    let message = format!("Run {} (exit {code:?}).", d.run["status"]);
                    let measured = d.metrics.snapshot(false);
                    if let Some(observation) = workloads::observation(&measured, &d.run, &d.infra) {
                        let key = if d.run["target"] == "project" {
                            d.run["projectPath"]
                                .as_str()
                                .unwrap_or("__demo__")
                                .to_owned()
                        } else {
                            "__demo__".to_owned()
                        };
                        d.observations[key] = observation;
                    }
                    (message, serde_json::to_vec_pretty(&d.observations))
                };
                app.log("k6", &message);
                if let Ok(bytes) = saved {
                    let tmp = app.root.join("workspace/observations.tmp");
                    let result = async {
                        tokio::fs::write(&tmp, bytes).await?;
                        tokio::fs::rename(&tmp, app.root.join("workspace/observations.json")).await
                    }
                    .await;
                    if let Err(e) = result {
                        app.log(
                            "lab",
                            &format!("Could not save automatic measurements: {e}"),
                        );
                    }
                }
            }
            let _ = done_tx.send(true);
        });
        Ok(Process {
            stop,
            running,
            done,
        })
    }
    async fn stop_load(&self) {
        let child = {
            let mut d = self.data.lock().unwrap();
            let child = d.engine.clone();
            if child.as_ref().is_some_and(Process::running) {
                d.run["status"] = json!("stopping");
            }
            child
        };
        if let Some(child) = child {
            child.stop().await;
        }
    }
    async fn stop_services(&self) {
        self.stop_load().await;
        let services = { std::mem::take(&mut self.data.lock().unwrap().services) };
        for service in services.into_values() {
            service.process.stop().await;
        }
    }
    async fn start_services(self: &Arc<Self>) -> Result<()> {
        self.stop_services().await;
        let project = self.data.lock().unwrap().project.clone();
        for service in project["services"].as_array().unwrap() {
            let id = service["id"].as_str().unwrap();
            let file = self.root.join("workspace").join(format!("{id}.mjs"));
            let result = async {
                tokio::fs::write(&file, service["code"].as_str().unwrap())
                    .await
                    .map_err(|e| e.to_string())?;
                let listener =
                    std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
                let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                drop(listener);
                let process = self.launch(
                    "node",
                    &[
                        "runner.mjs".into(),
                        id.into(),
                        file.display().to_string(),
                        port.to_string(),
                        self.base(),
                    ],
                    id,
                    &[],
                )?;
                self.data.lock().unwrap().services.insert(
                    id.into(),
                    Service {
                        process: process.clone(),
                        port,
                    },
                );
                for _ in 0..60 {
                    if !process.running() {
                        return Err(format!("{id} failed to start. See its event log."));
                    }
                    if tokio::net::TcpStream::connect(("127.0.0.1", port))
                        .await
                        .is_ok()
                    {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(format!("{id} startup timed out."))
            }
            .await;
            if let Err(error) = result {
                self.stop_services().await;
                return Err(error);
            }
        }
        self.log("lab", "Services started. Service state resets on restart.");
        Ok(())
    }
    async fn start_load(self: &Arc<Self>, input: &Value) -> Result<()> {
        let users = bounded(input, "users", 1, MAX_EXACT_INTEGER)?;
        let duration = bounded(input, "duration", 1, 3600)?;
        let ramp = bounded(input, "ramp", 1, 300)?;
        let project_target = input["target"] == "project";
        let (scenario, target) = {
            let d = self.data.lock().unwrap();
            if project_target {
                if !d.infra["containers"].as_array().is_some_and(|cs| {
                    cs.iter().any(|c| {
                        (c["Service"] == "nginx"
                            || (d.infra["config"]["mode"] == "detected"
                                && c["Service"] == d.infra["config"]["definition"]["entry"]))
                            && c["State"] == "running"
                    })
                }) {
                    return Err("Start the project infrastructure stack first.".into());
                }
                (
                    d.project["freshScenario"].as_str().unwrap().to_owned(),
                    format!("http://127.0.0.1:{}", d.infra["config"]["entryPort"]),
                )
            } else {
                if d.services.is_empty() || d.services.values().any(|s| !s.process.running()) {
                    return Err("Start all demo services first.".into());
                }
                let entry = d.project["links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|l| l["source"] == "users")
                    .ok_or("Connect virtual users to an entry service first.")?;
                (
                    d.project["scenario"].as_str().unwrap().to_owned(),
                    format!(
                        "{}/network/users/{}",
                        self.base(),
                        entry["target"].as_str().unwrap()
                    ),
                )
            }
        };
        let k6 = std::env::var("K6_BIN")
            .unwrap_or_else(|_| self.root.join("bin/k6").display().to_string());
        self.stop_load().await;
        let file = self.root.join("workspace/journey.js");
        tokio::fs::write(&file, scenario)
            .await
            .map_err(|e| e.to_string())?;
        {
            let mut d = self.data.lock().unwrap();
            d.metrics = Metrics::default();
            let project_path = if project_target {
                d.infra["config"]["projectPath"].clone()
            } else {
                Value::Null
            };
            d.run = json!({"projectPath":project_path,"status":"running","target":if project_target {"project"} else {"demo"},"started":now(),"users":users,"duration":duration,"ramp":ramp,"exitCode":null});
        }
        let result = self.launch(
            &k6,
            &[
                "run".into(),
                "--quiet".into(),
                "--address".into(),
                "127.0.0.1:0".into(),
                "--out".into(),
                "json=-".into(),
                "--log-output".into(),
                "stderr".into(),
                file.display().to_string(),
            ],
            "k6",
            &[
                ("TARGET", target),
                ("USERS", users.to_string()),
                ("DURATION", duration.to_string()),
                ("RAMP", ramp.to_string()),
                ("K6_NO_USAGE_REPORT", "true".into()),
            ],
        );
        match result {
            Ok(child) => self.data.lock().unwrap().engine = Some(child),
            Err(e) => {
                self.data.lock().unwrap().run["status"] = json!("error");
                return Err(e);
            }
        }
        self.log(
            "lab",
            &format!("k6: ramp to {users} users over {ramp}s, hold for {duration}s."),
        );
        Ok(())
    }
    async fn bridge(self: &Arc<Self>) -> Result<Process> {
        let mut child = Command::new("node")
            .arg("infra-adapter.mjs")
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let (stop, stop_rx) = watch::channel(false);
        *self.bridge_input.lock().await = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (ready_tx, ready_rx) = oneshot::channel();
        let app = self.clone();
        tokio::spawn(async move {
            let mut ready = Some(ready_tx);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if msg.get("snapshot").is_some() {
                    app.data.lock().unwrap().infra = msg["snapshot"].clone();
                }
                if let Some(log) = msg.get("log") {
                    app.log(
                        log["service"].as_str().unwrap_or("infra"),
                        log["message"].as_str().unwrap_or(""),
                    );
                }
                if msg["ready"] == true
                    && let Some(tx) = ready.take()
                {
                    let _ = tx.send(());
                }
                if let Some(id) = msg["id"].as_u64()
                    && let Some(tx) = app.pending.lock().unwrap().remove(&id)
                {
                    let _ = tx.send(if let Some(e) = msg["error"].as_str() {
                        Err(e.into())
                    } else {
                        Ok(())
                    });
                }
            }
            let mut d = app.data.lock().unwrap();
            d.infra["docker"] =
                json!({"available":false,"message":"Infrastructure adapter stopped"});
            d.infra["busy"] = json!(false);
            drop(d);
            for (_, tx) in app.pending.lock().unwrap().drain() {
                let _ = tx.send(Err("Infrastructure adapter stopped".into()));
            }
        });
        let app = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                app.log("infra", &line);
            }
        });
        let running = Arc::new(AtomicBool::new(true));
        let alive = running.clone();
        let (tx, done) = watch::channel(false);
        tokio::spawn(async move {
            let _ = wait_child(child, stop_rx).await;
            alive.store(false, Ordering::SeqCst);
            let _ = tx.send(true);
        });
        if !matches!(
            tokio::time::timeout(Duration::from_secs(10), ready_rx).await,
            Ok(Ok(()))
        ) {
            let _ = stop.send(true);
            return Err("Infrastructure adapter failed to initialize within 10 seconds".into());
        }
        // A closed ready channel also means startup failed.
        if !running.load(Ordering::SeqCst) {
            return Err("Infrastructure adapter failed to start".into());
        }
        Ok(Process {
            stop,
            running,
            done,
        })
    }
    async fn infra_action(&self, action: &str, data: Value) -> Result<()> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let request = format!("{}\n", json!({"id":id,"action":action,"data":data}));
        let written = {
            let mut input = self.bridge_input.lock().await;
            if let Some(input) = input.as_mut() {
                input
                    .write_all(request.as_bytes())
                    .await
                    .map_err(|e| e.to_string())
            } else {
                Err("Infrastructure adapter unavailable".into())
            }
        };
        if let Err(e) = written {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let result = tokio::time::timeout(Duration::from_secs(30), rx).await;
        self.pending.lock().unwrap().remove(&id);
        result
            .map_err(|_| "Infrastructure adapter timed out".to_string())?
            .map_err(|_| "Infrastructure adapter stopped".to_string())?
    }
}
fn bounded(v: &Value, key: &str, min: u64, max: u64) -> Result<u64> {
    v[key]
        .as_u64()
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| format!("{key} must be an integer between {min} and {max}."))
}
fn validate(v: &Value) -> Result<()> {
    let services = v["services"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 12)
        .ok_or("Use 1–12 services.")?;
    let mut ids = std::collections::HashSet::new();
    for service in services {
        let id = service["id"].as_str().ok_or("Invalid service name")?;
        if id.is_empty()
            || id.len() > 31
            || !id.as_bytes()[0].is_ascii_lowercase()
            || !id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || id == "users"
            || !ids.insert(id)
        {
            return Err("Use unique lowercase service names.".into());
        }
        if service["code"].as_str().is_none_or(|s| s.len() > 100_000) {
            return Err("Invalid service code.".into());
        }
    }
    for key in ["scenario", "freshScenario"] {
        if v[key].as_str().is_none_or(|s| s.len() > 100_000) {
            return Err(format!("Invalid {key} code."));
        }
    }
    let links = v["links"]
        .as_array()
        .filter(|s| s.len() <= 144)
        .ok_or("Invalid links.")?;
    let mut pairs = std::collections::HashSet::new();
    for link in links {
        let source = link["source"].as_str().ok_or("Invalid link source")?;
        let target = link["target"].as_str().ok_or("Invalid link target")?;
        if !(ids.contains(source) || source == "users")
            || !ids.contains(target)
            || !pairs.insert((source, target))
        {
            return Err("Links must connect known nodes and be unique.".into());
        }
        if !link["enabled"].is_boolean() {
            return Err("Invalid link state.".into());
        }
        for (key, max) in [("latency", 2000.0), ("failure", 100.0)] {
            if !link[key]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= max)
            {
                return Err(format!("{key} must be between 0 and {max}."));
            }
        }
    }
    Ok(())
}
fn reply(status: u16, value: Value) -> Response {
    content(status, value.to_string(), "application/json")
}
fn content(status: u16, body: impl Into<Body>, mime: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(body.into())
        .unwrap()
}
fn error(status: u16, message: impl Into<String>) -> Response {
    reply(status, json!({"error":message.into()}))
}
async fn proxy(app: Arc<App>, req: Request<Body>) -> Response {
    let began = Instant::now();
    let uri = req.uri().clone();
    let path = uri.path();
    let parts: Vec<&str> = path.splitn(5, '/').collect();
    let source = parts.get(2).copied().unwrap_or("");
    let target = parts.get(3).copied().unwrap_or("");
    let request_path = format!(
        "/{}{}",
        parts.get(4).copied().unwrap_or(""),
        uri.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    let (link, port) = {
        let d = app.data.lock().unwrap();
        (
            d.project["links"]
                .as_array()
                .unwrap()
                .iter()
                .find(|l| l["source"] == source && l["target"] == target)
                .cloned(),
            d.services
                .get(target)
                .filter(|s| s.process.running())
                .map(|s| s.port),
        )
    };
    let response = async {
        let Some(link) = link.filter(|l| l["enabled"] == true) else {
            return error(503, "Network link disconnected");
        };
        tokio::time::sleep(Duration::from_secs_f64(
            link["latency"].as_f64().unwrap() / 1000.0,
        ))
        .await;
        if rand::random::<f64>() * 100.0 < link["failure"].as_f64().unwrap() {
            return error(503, "Injected network failure");
        }
        let Some(port) = port else {
            return error(503, format!("{target} is offline"));
        };
        let (parts, body) = req.into_parts();
        let payload = match to_bytes(body, 1_500_000).await {
            Ok(b) => b,
            Err(_) => return error(413, "Request too large"),
        };
        let mut request = app.client.request(
            parts.method.clone(),
            format!("http://127.0.0.1:{port}{request_path}"),
        );
        for (key, value) in &parts.headers {
            if !["host", "connection", "content-length", "transfer-encoding"]
                .contains(&key.as_str())
            {
                request = request.header(key, value);
            }
        }
        if parts.method != "GET" && parts.method != "HEAD" {
            request = request.body(payload);
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                match response.bytes().await {
                    Ok(body) => content(status, body, "application/json; charset=utf-8"),
                    Err(e) => error(502, e.to_string()),
                }
            }
            Err(e) => error(502, e.to_string()),
        }
    }
    .await;
    let mut d = app.data.lock().unwrap();
    d.traces.push_front(json!({"time":clock(),"source":source,"target":target,"path":request_path,"status":response.status().as_u16(),"ms":(began.elapsed().as_secs_f64()*10_000.0).round()/10.0}));
    if d.traces.len() > 100 {
        d.traces.pop_back();
    }
    response
}
async fn handle(State(app): State<Arc<App>>, req: Request<Body>) -> Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let allowed = [app.base(), format!("http://localhost:{}", app.port)];
    if ![
        format!("127.0.0.1:{}", app.port),
        format!("localhost:{}", app.port),
    ]
    .contains(&host.to_owned())
        || req
            .headers()
            .get("origin")
            .is_some_and(|v| !allowed.iter().any(|o| v.as_bytes() == o.as_bytes()))
    {
        return error(403, "Local access only.");
    }
    let path = req.uri().path().to_owned();
    if path.starts_with("/network/") {
        return proxy(app, req).await;
    }
    if req.method() == "GET" && path == "/api/workloads" {
        return match workloads::load(&app.root.join("workspace/workloads.json")).await {
            Ok(value) => reply(200, value),
            Err(e) => error(500, e),
        };
    }
    if req.method() == "GET" && path == "/api/project/inspect" {
        let url = match reqwest::Url::parse(&format!("http://localhost{}", req.uri())) {
            Ok(u) => u,
            Err(e) => return error(400, e.to_string()),
        };
        let scan = url.query_pairs().any(|(k, v)| k == "scan" && v == "true");
        let folder = url
            .query_pairs()
            .find(|(k, _)| k == "path")
            .map(|(_, v)| PathBuf::from(v.as_ref()));
        let Some(folder) = folder else {
            return error(400, "Choose a project folder");
        };
        return match tokio::task::spawn_blocking(move || {
            inspection::inspect_with_scan(&folder, scan)
        })
        .await
        {
            Ok(Ok(value)) => reply(200, value),
            Ok(Err(e)) => error(400, e),
            Err(e) => error(500, e.to_string()),
        };
    }
    if req.method() == "GET" && path == "/api/projects" {
        let roots: Vec<PathBuf> = std::env::var_os("SYSTEMS_LAB_PROJECTS_ROOT")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_else(|| {
                vec![
                    app.root
                        .parent()
                        .and_then(|p| p.parent())
                        .unwrap_or(&app.root)
                        .to_path_buf(),
                ]
            });
        return match tokio::task::spawn_blocking(move || projects::discover(&roots)).await {
            Ok(catalog) => reply(200, catalog),
            Err(e) => error(500, e.to_string()),
        };
    }
    if req.method() == "GET" && path == "/api/state" {
        let busy = app.action.try_lock().is_err();
        let mut d = app.data.lock().unwrap();
        let services: serde_json::Map<String, Value> = d
            .services
            .iter()
            .map(|(id, s)| {
                (
                    id.clone(),
                    json!({"running":s.process.running(),"port":s.port}),
                )
            })
            .collect();
        let running = d.engine.as_ref().is_some_and(Process::running);
        let metrics = d.metrics.snapshot(running);
        return reply(
            200,
            json!({"backend":"rust","project":d.project,"services":services,"logs":d.logs,"traces":d.traces,"run":d.run,"metrics":metrics,"observations":d.observations,"busy":busy,"infra":d.infra}),
        );
    }
    if req.method() == "POST" {
        let Ok(_guard) = app.action.try_lock() else {
            return error(409, "Another action is in progress.");
        };
        let bytes = match to_bytes(req.into_body(), 1_500_000).await {
            Ok(b) => b,
            Err(_) => return error(413, "Request too large"),
        };
        let data: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => return error(400, e.to_string()),
        };
        let result: Result<Response> = async {
            match path.as_str() {
                "/api/project/manifest" => {
                    inspection::validate(&data["definition"])?;
                    let root = std::fs::canonicalize(
                        data["projectPath"]
                            .as_str()
                            .ok_or("Choose a project folder")?,
                    )
                    .map_err(|e| e.to_string())?;
                    if !root.is_dir() {
                        return Err("Choose a project folder".into());
                    }
                    let file = root.join(inspection::FILE);
                    if std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
                        return Err("Project file must not be a symbolic link".into());
                    }
                    let tmp = root.join(format!(".systems-lab-{}.tmp", std::process::id()));
                    let mut output = tokio::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&tmp)
                        .await
                        .map_err(|e| e.to_string())?;
                    use tokio::io::AsyncWriteExt;
                    let bytes = serde_json::to_vec_pretty(&data["definition"])
                        .map_err(|e| e.to_string())?;
                    output.write_all(&bytes).await.map_err(|e| e.to_string())?;
                    output.flush().await.map_err(|e| e.to_string())?;
                    tokio::fs::rename(&tmp, file)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                "/api/workload" => {
                    let (project_path, requirements) = workloads::validate(&data)?;
                    let file = app.root.join("workspace/workloads.json");
                    let mut saved = workloads::load(&file).await?;
                    saved[project_path] = requirements.clone();
                    let tmp = app.root.join("workspace/workloads.tmp");
                    tokio::fs::write(
                        &tmp,
                        serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                    tokio::fs::rename(tmp, file)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                "/api/save" => {
                    validate(&data)?;
                    let tmp = app.root.join("workspace/project.tmp");
                    tokio::fs::write(
                        &tmp,
                        serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                    tokio::fs::rename(tmp, app.root.join("workspace/project.json"))
                        .await
                        .map_err(|e| e.to_string())?;
                    app.data.lock().unwrap().project = data;
                    app.log(
                        "lab",
                        "Saved. Links apply now; restart services or rerun k6 to apply code.",
                    );
                }
                "/api/start" => app.start_services().await?,
                "/api/stop" => app.stop_services().await,
                "/api/load" => app.start_load(&data).await?,
                "/api/load/stop" => app.stop_load().await,
                "/api/infra/prepare" => app.infra_action("prepare", data).await?,
                "/api/infra/start" => app.infra_action("start", data).await?,
                "/api/infra/stop" => {
                    app.stop_load().await;
                    app.infra_action("stop", data).await?;
                }
                "/api/infra/service" => app.infra_action("service", data).await?,
                _ => return Ok(error(404, "Unknown action")),
            }
            Ok(reply(200, json!({"ok":true})))
        }
        .await;
        return match result {
            Ok(response) => response,
            Err(e) => {
                app.log("lab", &e);
                error(400, e)
            }
        };
    }
    if req.method() == "GET" {
        let file = match path.as_str() {
            "/" => Some(("index.html", "text/html; charset=utf-8")),
            "/app.js" => Some(("app.js", "text/javascript")),
            "/style.css" => Some(("style.css", "text/css")),
            "/favicon.ico" => return content(200, "", "image/x-icon"),
            _ => None,
        };
        if let Some((file, mime)) = file {
            return match tokio::fs::read(app.root.join("public").join(file)).await {
                Ok(bytes) => content(200, bytes, mime),
                Err(e) => error(500, e.to_string()),
            };
        }
    }
    error(404, "Not found")
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var_os("SYSTEMS_LAB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "8787".into())
        .parse()?;
    tokio::fs::create_dir_all(root.join("workspace")).await?;
    let mut project: Value = match tokio::fs::read(root.join("workspace/project.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            serde_json::from_str(include_str!("default-project.json"))?
        }
        Err(e) => return Err(e.into()),
    };
    if project.get("freshScenario").is_none() {
        project["freshScenario"] =
            serde_json::from_str::<Value>(include_str!("default-project.json"))?["freshScenario"]
                .clone();
    }
    validate(&project)?;
    // Bind before starting helpers so a conflicting port never leaves child processes behind.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let actual_port = listener.local_addr()?.port();
    let observations = workloads::load(&root.join("workspace/observations.json")).await?;
    let app = Arc::new(App {
        root,
        port: actual_port,
        data: Mutex::new(Data {
            project,
            services: HashMap::new(),
            engine: None,
            run: json!({"status":"idle"}),
            metrics: Metrics::default(),
            observations,
            logs: VecDeque::new(),
            traces: VecDeque::new(),
            infra: Value::Null,
        }),
        action: AsyncMutex::new(()),
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?,
        bridge_input: AsyncMutex::new(None),
        pending: Mutex::new(HashMap::new()),
        sequence: AtomicU64::new(1),
    });
    let bridge = app.bridge().await?;
    println!("Systems Lab (Rust) → {}", app.base());
    let router = Router::new().fallback(handle).with_state(app.clone());
    let shutdown_app = app.clone();
    let shutdown = async move {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = terminate.recv() => () }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        // Serialize shutdown with ongoing saves/process launches.
        let _guard = shutdown_app.action.lock().await;
        shutdown_app.stop_services().await;
        // Close private IPC gracefully so the adapter can stop its owned CLI process.
        shutdown_app.bridge_input.lock().await.take();
        let mut done = bridge.done.clone();
        if tokio::time::timeout(Duration::from_secs(2), done.wait_for(|v| *v))
            .await
            .is_err()
        {
            bridge.stop().await;
        }
    };
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_count_has_no_small_load_cap_and_rejects_invalid_numbers() {
        for users in [1, 1000, 10_000, 100_000, 1_000_000, MAX_EXACT_INTEGER] {
            assert_eq!(
                bounded(&json!({"users":users}), "users", 1, MAX_EXACT_INTEGER),
                Ok(users)
            );
        }
        for users in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("1000"),
            json!(MAX_EXACT_INTEGER + 1),
        ] {
            assert!(bounded(&json!({"users":users}), "users", 1, MAX_EXACT_INTEGER).is_err());
        }
    }
    #[test]
    fn project_validation_rejects_unsafe_names_and_broken_links() {
        let defaults: Value = serde_json::from_str(include_str!("default-project.json")).unwrap();
        assert!(validate(&defaults).is_ok());
        for bad in ["../escape", "users", "Gateway", ""] {
            let mut v = defaults.clone();
            v["services"][0]["id"] = json!(bad);
            assert!(validate(&v).is_err());
        }
        let mut v = defaults.clone();
        v["links"][0]["target"] = json!("unknown");
        assert!(validate(&v).is_err());
        let mut v = defaults.clone();
        v["links"][0]["failure"] = json!(101);
        assert!(validate(&v).is_err());
        let mut v = defaults.clone();
        let duplicate = v["links"][0].clone();
        v["links"].as_array_mut().unwrap().push(duplicate);
        assert!(validate(&v).is_err());
    }
}
