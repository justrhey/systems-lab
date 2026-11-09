use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path, PathBuf},
};
pub const FILE: &str = "systems-lab.json";
pub const INFRA: &[&str] = &[
    "nginx",
    "postgres",
    "redis",
    "kafka",
    "rabbitmq",
    "mongodb",
    "mysql",
    "minio",
    "prometheus",
    "grafana",
];
fn relative(path: &str) -> bool {
    !path.is_empty()
        && !Path::new(path).components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}
pub fn validate(def: &Value) -> Result<(), String> {
    if def["version"] != 1 {
        return Err("systems-lab.json must use version 1".into());
    }
    let services = def["services"]
        .as_object()
        .filter(|s| s.len() <= 32)
        .ok_or("Use up to 32 service definitions")?;
    for (id, s) in services {
        if id.is_empty()
            || id.len() > 31
            || !id.as_bytes()[0].is_ascii_lowercase()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(format!("Invalid service ID: {id}"));
        }
        let kind = s["kind"].as_str().ok_or("Each service needs a kind")?;
        if kind != "app" && (!INFRA.contains(&kind) || id != kind) {
            return Err(format!("Unsupported service kind or ID: {id}"));
        }
        if s.get("enabled").is_some_and(|v| !v.is_boolean()) {
            return Err(format!("{id}.enabled must be a boolean"));
        }
        if let Some(file) = s.get("dockerfile").filter(|v| !v.is_null())
            && !file.as_str().is_some_and(relative)
        {
            return Err(format!("{id}.dockerfile must be relative to the project"));
        }
        if let Some(port) = s.get("port").filter(|v| !v.is_null())
            && !port.as_u64().is_some_and(|p| (1..=65535).contains(&p))
        {
            return Err(format!("Invalid port for {id}"));
        }
        if let Some(command) = s.get("command")
            && !command.as_array().is_some_and(|a| {
                !a.is_empty()
                    && a.len() <= 64
                    && a.iter()
                        .all(|v| v.as_str().is_some_and(|s| s.len() <= 4096))
            })
        {
            return Err(format!("{id}.command must be an argument array"));
        }
    }
    if let Some(entry) = def["entry"].as_str()
        && !services.contains_key(entry)
    {
        return Err("Entry service is not defined".into());
    }
    Ok(())
}
fn walk(root: &Path, dir: &Path, depth: usize, files: &mut Vec<PathBuf>, budget: &mut usize) {
    if depth == 0 || *budget == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || [
                "node_modules",
                "target",
                "dist",
                "build",
                "vendor",
                "venv",
                "coverage",
                "docs",
                "test",
                "tests",
                "fixtures",
            ]
            .contains(&name.as_str())
        {
            continue;
        }
        let Ok(kind) = e.file_type() else {
            continue;
        };
        if kind.is_dir() {
            walk(root, &e.path(), depth - 1, files, budget);
        } else if kind.is_file() {
            files.push(e.path().strip_prefix(root).unwrap().to_path_buf());
        }
    }
}
fn read(root: &Path, file: &Path) -> Option<String> {
    let path = root.join(file);
    if std::fs::metadata(&path).ok()?.len() > 1_000_000 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}
fn evidence(file: &str, text: &str, needle: &str, reason: &str) -> Value {
    let line = text
        .lines()
        .position(|l| l.contains(needle))
        .map(|n| n + 1)
        .unwrap_or(1);
    json!({"file":file,"line":line,"reason":reason})
}
fn exposed(text: &str) -> Option<u16> {
    text.lines().find_map(|l| {
        let mut w = l.split_whitespace();
        if !w.next()?.eq_ignore_ascii_case("EXPOSE") {
            return None;
        }
        w.next()?.split('/').next()?.parse().ok()
    })
}
fn add_infra(services: &mut BTreeMap<String, Value>, id: &str, proof: Value) {
    let s = services
        .entry(id.into())
        .or_insert_with(|| json!({"kind":id,"enabled":true,"evidence":[]}));
    s["evidence"].as_array_mut().unwrap().push(proof);
}
#[cfg(test)]
pub fn inspect(path: &Path) -> Result<Value, String> {
    inspect_with_scan(path, false)
}
pub fn inspect_with_scan(path: &Path, scan: bool) -> Result<Value, String> {
    let root = path.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Choose a project folder".into());
    }
    let manifest = root.join(FILE);
    if manifest.exists() && !scan {
        if std::fs::symlink_metadata(&manifest).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Project file must not be a symbolic link".into());
        }
        let text =
            read(&root, Path::new(FILE)).ok_or("Project file is unreadable or larger than 1 MB")?;
        let definition: Value =
            serde_json::from_str(&text).map_err(|e| format!("Invalid {FILE}: {e}"))?;
        validate(&definition)?;
        return Ok(
            json!({"projectPath":root.to_string_lossy(),"source":"project-file","manifestPath":manifest.to_string_lossy(),"definition":definition,"warnings":[]}),
        );
    }
    let mut files = Vec::new();
    walk(&root, &root, 6, &mut files, &mut 5000);
    files.sort();
    let mut services = BTreeMap::new();
    let mut warnings = Vec::<String>::new();
    let mut app_ids = HashSet::new();
    for file in files
        .iter()
        .filter(|p| p.file_name().is_some_and(|n| n == "package.json"))
    {
        let Some(text) = read(&root, file) else {
            continue;
        };
        let Ok(package) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let folder = file.parent().unwrap();
        let docker = folder.join("Dockerfile");
        let has_docker = root.join(&docker).is_file();
        let dependencies = package["dependencies"].as_object();
        let has = |name: &str| dependencies.is_some_and(|d| d.contains_key(name));
        let start = package["scripts"]["start"]
            .as_str()
            .or_else(|| package["scripts"]["start:prod"].as_str());
        let monorepo = folder.as_os_str().is_empty()
            && (package.get("workspaces").is_some() || root.join("pnpm-workspace.yaml").exists());
        if (monorepo || start.is_none()) && !has_docker {
            continue;
        }
        let base = if has("next") || has("vite") {
            "web"
        } else if has("@nestjs/core") || has("express") || has("fastify") {
            "api"
        } else {
            "web"
        };
        let mut id = base.to_string();
        let mut count = 2;
        while app_ids.contains(&id) {
            id = format!("{base}-{count}");
            count += 1;
        }
        app_ids.insert(id.clone());
        let docker_text = read(&root, &docker).unwrap_or_default();
        let port = exposed(&docker_text);
        let framework = if has("next") {
            "Next.js"
        } else if has("@nestjs/core") {
            "NestJS"
        } else {
            "Node.js"
        };
        let proof = evidence(
            &file.to_string_lossy(),
            &text,
            "scripts",
            "Application package and runtime script",
        );
        let mut app = json!({"kind":"app","role":base,"label":format!("{framework} application"),"enabled":true,"dockerfile":if has_docker{Some(docker.to_string_lossy().to_string())}else{None},"port":port,"evidence":[proof],"dependsOn":[]});
        if has_docker {
            app["evidence"].as_array_mut().unwrap().push(evidence(
                &docker.to_string_lossy(),
                &docker_text,
                "FROM",
                "Runtime Dockerfile",
            ));
        } else {
            warnings.push(format!(
                "{id}: add a Dockerfile or image in {FILE} before starting"
            ));
        }
        for (kind, names) in [
            ("redis", vec!["redis", "ioredis", "bullmq"]),
            ("postgres", vec!["pg", "postgres"]),
            ("mysql", vec!["mysql", "mysql2"]),
            ("mongodb", vec!["mongodb", "mongoose"]),
            ("kafka", vec!["kafkajs", "node-rdkafka"]),
            ("rabbitmq", vec!["amqplib"]),
            ("minio", vec!["minio"]),
        ] {
            if let Some(dep) = names.iter().find(|n| has(n)) {
                add_infra(
                    &mut services,
                    kind,
                    evidence(
                        &file.to_string_lossy(),
                        &text,
                        dep,
                        &format!("Declared runtime dependency: {dep}"),
                    ),
                );
                app["dependsOn"].as_array_mut().unwrap().push(json!(kind));
            }
        }
        if let Some(scripts) = package["scripts"].as_object()
            && let Some((name, command)) = ["worker:start", "start:worker", "worker"]
                .iter()
                .find_map(|n| scripts.get(*n).and_then(Value::as_str).map(|c| (*n, c)))
        {
            let command: Option<Vec<&str>> = if command.chars().any(|c| "|;&><$()\\\"'".contains(c))
            {
                None
            } else {
                Some(command.split_whitespace().collect())
            };
            if let Some(command) = command.filter(|c| !c.is_empty()) {
                let mut worker = app.clone();
                worker["role"] = json!("worker");
                worker["port"] = Value::Null;
                worker["command"] = json!(command);
                worker["label"] = json!(if has("bullmq") {
                    "BullMQ worker"
                } else {
                    "Background worker"
                });
                worker["evidence"] = json!([evidence(
                    &file.to_string_lossy(),
                    &text,
                    name,
                    "Explicit worker runtime command"
                )]);
                let worker_id = if services.contains_key("worker") {
                    format!("{id}-worker")
                } else {
                    "worker".into()
                };
                services.insert(worker_id, worker);
            } else {
                warnings.push(format!(
                    "{file:?}: worker script needs an explicit argument array in {FILE}"
                ));
            }
        }
        services.insert(id, app);
    }
    // A standalone Dockerfile is evidence of an application even without Node metadata.
    if !services.values().any(|s| s["kind"] == "app")
        && let Some(file) = files
            .iter()
            .find(|p| p.file_name().is_some_and(|n| n == "Dockerfile"))
    {
        let text = read(&root, file).unwrap_or_default();
        services.insert("web".into(),json!({"kind":"app","role":"web","label":"Dockerfile application","enabled":true,"dockerfile":file.to_string_lossy(),"port":exposed(&text),"evidence":[evidence(&file.to_string_lossy(),&text,"FROM","Runtime Dockerfile")]}));
    }
    // Compose declarations supply evidence only; arbitrary YAML commands/env are not imported.
    for file in files.iter().filter(|p| {
        p.parent().is_some_and(|p| p.as_os_str().is_empty())
            && p.file_name()
                .is_some_and(|n| n.to_string_lossy().contains("compose"))
    }) {
        let Some(text) = read(&root, file) else {
            continue;
        };
        for line in text
            .lines()
            .filter(|l| l.trim_start().starts_with("image:"))
        {
            let image = line
                .trim()
                .trim_start_matches("image:")
                .trim()
                .trim_matches(['\'', '"']);
            let kind = if image.starts_with("postgres:") {
                Some("postgres")
            } else if image.starts_with("redis:") {
                Some("redis")
            } else if image.starts_with("nginx:") {
                Some("nginx")
            } else if image.starts_with("mongo:") {
                Some("mongodb")
            } else if image.starts_with("mysql:") {
                Some("mysql")
            } else if image.starts_with("rabbitmq:") {
                Some("rabbitmq")
            } else if image.starts_with("apache/kafka:") {
                Some("kafka")
            } else if image.starts_with("minio/minio:") {
                Some("minio")
            } else {
                None
            };
            if let Some(kind) = kind {
                add_infra(
                    &mut services,
                    kind,
                    evidence(
                        &file.to_string_lossy(),
                        &text,
                        image,
                        "Image declared in root Compose file",
                    ),
                );
            }
        }
    }
    let entry = services
        .iter()
        .find(|(_, s)| s["kind"] == "app" && s["role"] == "web")
        .or_else(|| {
            services
                .iter()
                .find(|(_, s)| s["kind"] == "app" && s["port"].is_number())
        })
        .map(|(id, _)| id.clone());
    let definition = json!({"version":1,"name":root.file_name().unwrap_or_default().to_string_lossy(),"entry":entry,"services":services});
    validate(&definition)?;
    Ok(
        json!({"projectPath":root.to_string_lossy(),"source":"code-scan","manifestPath":manifest.to_string_lossy(),"definition":definition,"warnings":warnings}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_worker_is_invented_from_a_bullmq_dependency() {
        let root = std::env::temp_dir().join(format!("lab-inspect-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"start":"node app.js"},"dependencies":{"bullmq":"1","pg":"1"}}"#,
        )
        .unwrap();
        std::fs::write(root.join("Dockerfile"), "FROM node\nEXPOSE 8080").unwrap();
        let value = inspect(&root).unwrap();
        assert!(value["definition"]["services"].get("worker").is_none());
        assert!(value["definition"]["services"].get("redis").is_some());
        std::fs::write(root.join("package.json"), r#"{"scripts":{"start":"node app.js","worker:start":"node worker.js"},"dependencies":{"bullmq":"1","pg":"1"}}"#).unwrap();
        let with_worker = inspect(&root).unwrap();
        assert_eq!(
            with_worker["definition"]["services"]["worker"]["command"],
            json!(["node", "worker.js"])
        );
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"start":"node app.js"},"dependencies":{}}"#,
        )
        .unwrap();
        let plain = inspect(&root).unwrap();
        assert_eq!(
            plain["definition"]["services"].as_object().unwrap().len(),
            1
        );
        assert!(plain["definition"]["services"].get("redis").is_none());
        let mut def = value["definition"].clone();
        def["services"]["redis"]["enabled"] = json!(false);
        std::fs::write(root.join(FILE), serde_json::to_vec(&def).unwrap()).unwrap();
        let saved = inspect(&root).unwrap();
        assert_eq!(saved["source"], "project-file");
        assert_eq!(saved["definition"]["services"]["redis"]["enabled"], false);
        std::fs::remove_dir_all(root).unwrap();
    }
}
