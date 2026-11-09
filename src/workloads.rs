use serde_json::{Value, json};
use std::path::Path;

pub const FIELDS: &[&str] = &[
    "averageRps",
    "peakRps",
    "readWriteRatio",
    "requestSize",
    "responseSize",
    "datasetSize",
    "workingSetSize",
    "growthRate",
    "p50",
    "p95",
    "p99",
    "availability",
    "durability",
    "burstShape",
    "geography",
];

pub fn validate(input: &Value) -> Result<(&str, &Value), String> {
    let path = input["projectPath"]
        .as_str()
        .filter(|p| !p.is_empty() && p.len() <= 4096 && Path::new(p).is_absolute())
        .ok_or("Use an absolute project folder.")?;
    let requirements = input
        .get("requirements")
        .filter(|v| v.is_object())
        .ok_or("Invalid workload requirements.")?;
    for (key, value) in requirements.as_object().unwrap() {
        if !FIELDS.contains(&key.as_str()) || value.as_str().is_none_or(|s| s.len() > 4000) {
            return Err(format!("Invalid workload field: {key}"));
        }
    }
    Ok((path, requirements))
}

pub async fn load(path: &Path) -> Result<Value, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|e| e.to_string())
            .and_then(|v| {
                if v.is_object() {
                    Ok(v)
                } else {
                    Err("Invalid saved workload data".into())
                }
            }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn keeps_unknown_values_and_rejects_malformed_requirements() {
        assert!(validate(&json!({"projectPath":"/tmp/app","requirements":{"peakRps":"","durability":"Unknown; define RPO"}})).is_ok());
        for input in [
            json!({"projectPath":"relative","requirements":{}}),
            json!({"projectPath":"/tmp/app","requirements":{"peakRps":100}}),
            json!({"projectPath":"/tmp/app","requirements":{"unexpected":"value"}}),
        ] {
            assert!(validate(&input).is_err());
        }
    }
}

// Measured observations remain separate from user-entered requirements/overrides.
pub fn observation(metrics: &Value, run: &Value, infra: &Value) -> Option<Value> {
    let requests = metrics["requests"].as_f64()?;
    if requests <= 0.0 {
        return None;
    }
    let elapsed = (run["finished"].as_f64()? - run["started"].as_f64()?) / 1000.0;
    let mut fields = json!({});
    if elapsed > 0.0 {
        fields["averageRps"] = json!(format!("{:.1} requests/second", requests / elapsed));
    }
    fields["peakRps"] = json!(format!(
        "{:.1} requests/second (busiest measured second)",
        metrics["peakRps"].as_f64().unwrap_or(0.0)
    ));
    if metrics["samples"].as_u64().unwrap_or(0) > 0 {
        for field in ["p50", "p95", "p99"] {
            fields[field] = json!(format!("{:.1} ms", metrics[field].as_f64().unwrap_or(0.0)));
        }
    }
    let reads = metrics["readRequests"].as_f64().unwrap_or(0.0);
    let others = metrics["otherRequests"].as_f64().unwrap_or(0.0);
    if reads + others > 0.0 {
        fields["readWriteRatio"] = json!(format!(
            "{:.1}:{:.1} GET/HEAD vs other methods",
            reads / (reads + others) * 100.0,
            others / (reads + others) * 100.0
        ));
    }
    for (field, bytes, samples) in [
        ("requestSize", "bytesSent", "sentSamples"),
        ("responseSize", "bytesReceived", "receivedSamples"),
    ] {
        if metrics[samples].as_u64().unwrap_or(0) > 0 {
            fields[field] = json!(format!(
                "~{:.0} bytes/request including protocol overhead",
                metrics[bytes].as_f64().unwrap_or(0.0) / requests
            ));
        }
    }
    fields["burstShape"] = json!(format!(
        "Test setup: ramp to {} users in {}s, hold {}s",
        run["users"], run["ramp"], run["duration"]
    ));
    if run["target"] == "project"
        && run["projectPath"] == infra["config"]["projectPath"]
        && let Some(bytes) = infra["db"]["databaseBytes"].as_f64()
    {
        fields["datasetSize"] = json!(format!("{:.2} MiB in lab PostgreSQL", bytes / 1_048_576.0));
    }
    Some(
        json!({"id":run["finished"],"projectPath":run["projectPath"],"target":run["target"],"status":run["status"],"users":run["users"],"requests":requests,"failureRate":metrics["failureRate"],"fields":fields}),
    )
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[test]
    fn automatic_values_keep_scope_and_do_not_invent_business_goals() {
        let metrics = json!({"requests":1000,"peakRps":300,"samples":20,"p50":50,"p95":90,"p99":100,"readRequests":900,"otherRequests":100,"bytesSent":100000,"bytesReceived":500000,"sentSamples":1,"receivedSamples":1,"failureRate":2});
        let mut run = json!({"started":1000,"finished":6000,"target":"project","projectPath":"/tmp/a","status":"thresholds failed","users":100,"ramp":5,"duration":30});
        let infra = json!({"config":{"projectPath":"/tmp/a"},"db":{"databaseBytes":1048576}});
        let result = observation(&metrics, &run, &infra).unwrap();
        assert_eq!(result["fields"]["averageRps"], "200.0 requests/second");
        assert_eq!(result["fields"]["p95"], "90.0 ms");
        assert_eq!(
            result["fields"]["datasetSize"],
            "1.00 MiB in lab PostgreSQL"
        );
        for key in [
            "growthRate",
            "workingSetSize",
            "availability",
            "durability",
            "geography",
        ] {
            assert!(result["fields"].get(key).is_none());
        }
        assert_eq!(result["status"], "thresholds failed");
        run["target"] = json!("demo");
        run["projectPath"] = Value::Null;
        assert!(
            observation(&metrics, &run, &infra).unwrap()["fields"]
                .get("datasetSize")
                .is_none()
        );
        assert!(observation(&json!({"requests":0}), &run, &infra).is_none());
    }
}
