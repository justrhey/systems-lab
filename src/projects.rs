use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

fn ignored(name: &str) -> bool {
    name.starts_with('.')
        || [
            "node_modules",
            "target",
            "dist",
            "build",
            "venv",
            "vendor",
            "coverage",
        ]
        .contains(&name)
}
fn folders(root: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| !ignored(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    paths.sort();
    paths
}
fn dockerfiles(
    root: &Path,
    folder: &Path,
    depth: usize,
    result: &mut Vec<String>,
    budget: &mut usize,
) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file() && (name == "Dockerfile" || name.starts_with("Dockerfile.")) {
            if let Ok(relative) = path.strip_prefix(root) {
                result.push(relative.to_string_lossy().to_string());
            }
        } else if kind.is_dir() && depth > 0 && !ignored(&name) {
            dockerfiles(root, &path, depth - 1, result, budget);
        }
    }
}
fn known_project(path: &Path) -> bool {
    [
        ".git",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "requirements.txt",
        "go.mod",
        "Dockerfile",
        "index.html",
        "pom.xml",
        "build.gradle",
    ]
    .iter()
    .any(|file| path.join(file).exists())
}
fn describe(path: &Path, group: &str) -> Value {
    let mut files = Vec::new();
    dockerfiles(path, path, 3, &mut files, &mut 512);
    files.sort_by_key(|p| (p != "Dockerfile", p.clone()));
    let port = files
        .first()
        .and_then(|file| std::fs::read_to_string(path.join(file)).ok())
        .and_then(|text| {
            text.lines().find_map(|line| {
                let mut words = line.split_whitespace();
                if !words.next()?.eq_ignore_ascii_case("EXPOSE") {
                    return None;
                }
                words
                    .next()?
                    .split('/')
                    .next()?
                    .parse::<u16>()
                    .ok()
                    .filter(|p| *p >= 1024)
            })
        });
    json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"path":path.to_string_lossy(),"group":group,
        "mode":"detected","dockerfiles":files,"appPort":port,
        "ready":path.join("systems-lab.json").is_file() || !files.is_empty()})
}

pub fn discover(roots: &[PathBuf]) -> Value {
    let mut seen = HashSet::new();
    let mut projects = Vec::new();
    let mut unavailable = Vec::new();
    for root in roots {
        if !root.is_dir() {
            unavailable.push(root.to_string_lossy().to_string());
            continue;
        }
        for path in folders(root) {
            let group = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let candidates = if known_project(&path) {
                vec![path]
            } else {
                folders(&path)
            };
            for candidate in candidates {
                let Ok(canonical) = candidate.canonicalize() else {
                    continue;
                };
                if seen.insert(canonical.clone()) {
                    projects.push(describe(&canonical, &group));
                }
            }
        }
    }
    projects.sort_by_key(|p| p["name"].as_str().unwrap_or("").to_lowercase());
    json!({"projects":projects,"roots":roots.iter().map(|p|p.to_string_lossy().to_string()).collect::<Vec<_>>(),"unavailable":unavailable})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_projects_across_groups_without_requiring_a_dockerfile() {
        let root = std::env::temp_dir().join(format!("systems-lab-catalog-{}", std::process::id()));
        let a = root.join("Apps/alpha");
        let b = root.join("Tools/beta");
        std::fs::create_dir_all(a.join("deploy")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("package.json"), "{}").unwrap();
        std::fs::write(a.join("deploy/Dockerfile"), "FROM scratch\nEXPOSE 8080\n").unwrap();
        std::fs::write(b.join("Cargo.toml"), "").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&a, root.join("alias")).unwrap();
        let catalog = discover(std::slice::from_ref(&root));
        let entries = catalog["projects"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["name"], "alpha");
        assert_eq!(entries[0]["appPort"], 8080);
        assert_eq!(entries[0]["dockerfiles"][0], "deploy/Dockerfile");
        assert_eq!(entries[1]["ready"], false);
        std::fs::remove_dir_all(root).unwrap();
    }
}
