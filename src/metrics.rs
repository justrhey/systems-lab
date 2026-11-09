use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    time::Instant,
};

#[derive(Default)]
pub struct Metrics {
    requests: f64,
    failed: f64,
    checks: u64,
    passed: f64,
    vus: f64,
    sum: f64,
    durations: VecDeque<f64>,
    recent: VecDeque<(Instant, f64)>,
    seconds: BTreeMap<String, f64>,
    peak_rps: f64,
    read_requests: f64,
    other_requests: f64,
    sent: f64,
    received: f64,
    sent_samples: u64,
    received_samples: u64,
}

impl Metrics {
    pub fn point(&mut self, point: &Value) {
        if point["type"] != "Point" {
            return;
        }
        let Some(value) = point["data"]["value"].as_f64().filter(|n| n.is_finite()) else {
            return;
        };
        match point["metric"].as_str().unwrap_or("") {
            "http_reqs" => {
                self.requests += value;
                let now = Instant::now();
                self.recent.push_back((now, value));
                if let Some(second) = point["data"]["time"]
                    .as_str()
                    .and_then(|t| t.get(..19))
                    .filter(|t| t.as_bytes().get(10) == Some(&b'T'))
                {
                    let count = self.seconds.entry(second.to_owned()).or_default();
                    *count += value;
                    self.peak_rps = self.peak_rps.max(*count);
                    if self.seconds.len() > 10_000 {
                        self.seconds.pop_first();
                    }
                }
                match point["data"]["tags"]["method"].as_str() {
                    Some("GET" | "HEAD") => self.read_requests += value,
                    Some(_) => self.other_requests += value,
                    None => (),
                }
            }
            "data_sent" => {
                self.sent += value;
                self.sent_samples += 1;
            }
            "data_received" => {
                self.received += value;
                self.received_samples += 1;
            }
            "http_req_failed" => self.failed += value,
            "checks" => {
                self.checks += 1;
                self.passed += value;
            }
            "vus" => self.vus = value,
            "http_req_duration" => {
                self.sum += value;
                self.durations.push_back(value);
                if self.durations.len() > 20_000 {
                    self.durations.pop_front();
                }
            }
            _ => (),
        }
        self.prune();
    }

    fn prune(&mut self) {
        while self
            .recent
            .front()
            .is_some_and(|(t, _)| t.elapsed().as_secs() >= 10)
        {
            self.recent.pop_front();
        }
    }

    pub fn snapshot(&mut self, running: bool) -> Value {
        self.prune();
        let mut sorted: Vec<f64> = self.durations.iter().copied().collect();
        sorted.sort_by(f64::total_cmp);
        let p95 = if sorted.is_empty() {
            0.0
        } else {
            sorted[(sorted.len() as f64 * 0.95).ceil() as usize - 1]
        };
        let percentile = |p: f64| {
            if sorted.is_empty() {
                0.0
            } else {
                sorted[(sorted.len() as f64 * p).ceil() as usize - 1]
            }
        };
        json!({"rpsSamples":self.seconds.len(),"peakRps":self.peak_rps,"p50":percentile(0.5),"p99":percentile(0.99),
            "readRequests":self.read_requests,"otherRequests":self.other_requests,
            "bytesSent":self.sent,"bytesReceived":self.received,
            "sentSamples":self.sent_samples,"receivedSamples":self.received_samples,
            "requests":self.requests,"failed":self.failed,
            "failureRate":if self.requests > 0.0 {self.failed / self.requests * 100.0} else {0.0},
            "checks":self.checks,"passed":self.passed,"vus":if running {self.vus} else {0.0},
            "rps":if running {self.recent.iter().map(|(_, n)| n).sum::<f64>() / 10.0} else {0.0},
            "avg":if self.requests > 0.0 {self.sum / self.requests} else {0.0},"p95":p95,"samples":sorted.len()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn k6_counts_failures_checks_and_samples_independently() {
        let mut metrics = Metrics::default();
        for n in 1..=20 {
            for (metric, value) in [
                ("http_reqs", 1),
                ("http_req_duration", n),
                ("http_req_failed", i32::from(n == 20)),
            ] {
                metrics.point(&json!({"type":"Point","metric":metric,"data":{"value":value}}));
            }
        }
        metrics.point(&json!({"type":"Metric","metric":"http_reqs","data":{"value":999}}));
        metrics.point(&json!({"type":"Point","metric":"checks","data":{"value":1}}));
        metrics.point(&json!({"type":"Point","metric":"checks","data":{"value":0}}));
        metrics.point(&json!({"type":"Point","metric":"vus","data":{"value":3}}));
        let s = metrics.snapshot(true);
        assert_eq!(s["requests"], 20.0);
        assert_eq!(s["failureRate"], 5.0);
        assert_eq!(s["p95"], 19.0);
        assert_eq!(s["p50"], 10.0);
        assert_eq!(s["p99"], 20.0);
        assert_eq!(s["avg"], 10.5);
        assert_eq!(s["checks"], 2);
        assert_eq!(s["passed"], 1.0);
        assert_eq!(s["vus"], 3.0);
        assert_eq!(metrics.snapshot(false)["vus"], 0.0);
    }
}
