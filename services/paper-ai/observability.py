from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Dict, Iterable, List, Optional

_METRIC_NAME_RE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_:0123456789"


def _is_valid_name(name: str) -> bool:
    if not name:
        return False
    if name[0] not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_:":
        return False
    return all(ch in _METRIC_NAME_RE for ch in name)


def _escape_label_value(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _format_labels(labels: Dict[str, str]) -> str:
    if not labels:
        return ""
    pairs = ",".join(f'{k}="{_escape_label_value(v)}"' for k, v in labels.items())
    return "{" + pairs + "}"


class _MetricBase:
    def __init__(self, name: str, help_text: str, metric_type: str, label_names: Optional[List[str]] = None):
        if not _is_valid_name(name):
            raise ValueError(f"Invalid metric name: {name}")
        self.name = name
        self.help = help_text
        self.type = metric_type
        self.label_names = label_names or []
        self._lock = threading.Lock()

    def _normalize_labels(self, labels: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        labels = labels or {}
        return {name: str(labels.get(name, "")) for name in self.label_names}

    def _labels_key(self, labels: Dict[str, str]) -> str:
        return "|".join(f"{name}={labels.get(name, '')}" for name in self.label_names)


class Counter(_MetricBase):
    def __init__(self, name: str, help_text: str, label_names: Optional[List[str]] = None):
        super().__init__(name, help_text, "counter", label_names)
        self._values: Dict[str, Dict[str, object]] = {}

    def inc(self, labels: Optional[Dict[str, str]] = None, value: float = 1.0) -> None:
        try:
            amount = float(value)
        except Exception:
            return
        if amount < 0:
            return
        norm = self._normalize_labels(labels)
        key = self._labels_key(norm)
        with self._lock:
            if key not in self._values:
                self._values[key] = {"labels": norm, "value": 0.0}
            self._values[key]["value"] = float(self._values[key]["value"]) + amount

    def collect(self) -> List[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} {self.type}"]
        with self._lock:
            if not self._values:
                lines.append(f"{self.name}{_format_labels(self._normalize_labels({}))} 0")
                return lines
            for row in self._values.values():
                lines.append(f"{self.name}{_format_labels(row['labels'])} {row['value']}")
        return lines


class Gauge(_MetricBase):
    def __init__(self, name: str, help_text: str, label_names: Optional[List[str]] = None):
        super().__init__(name, help_text, "gauge", label_names)
        self._values: Dict[str, Dict[str, object]] = {}

    def set(self, labels: Optional[Dict[str, str]] = None, value: float = 0.0) -> None:
        try:
            amount = float(value)
        except Exception:
            return
        norm = self._normalize_labels(labels)
        key = self._labels_key(norm)
        with self._lock:
            self._values[key] = {"labels": norm, "value": amount}

    def collect(self) -> List[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} {self.type}"]
        with self._lock:
            if not self._values:
                lines.append(f"{self.name}{_format_labels(self._normalize_labels({}))} 0")
                return lines
            for row in self._values.values():
                lines.append(f"{self.name}{_format_labels(row['labels'])} {row['value']}")
        return lines


class Histogram(_MetricBase):
    def __init__(
        self,
        name: str,
        help_text: str,
        label_names: Optional[List[str]] = None,
        buckets: Optional[List[float]] = None,
    ):
        super().__init__(name, help_text, "histogram", label_names)
        b = sorted(set(float(x) for x in (buckets or [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]) if float(x) > 0))
        self.buckets = b
        self._values: Dict[str, Dict[str, object]] = {}

    def observe(self, labels: Optional[Dict[str, str]] = None, value: float = 0.0) -> None:
        try:
            amount = float(value)
        except Exception:
            return
        if amount < 0:
            return

        norm = self._normalize_labels(labels)
        key = self._labels_key(norm)

        with self._lock:
            if key not in self._values:
                self._values[key] = {
                    "labels": norm,
                    "counts": [0 for _ in self.buckets],
                    "sum": 0.0,
                    "count": 0,
                }

            row = self._values[key]
            for idx, bucket in enumerate(self.buckets):
                if amount <= bucket:
                    row["counts"][idx] += 1
            row["sum"] = float(row["sum"]) + amount
            row["count"] = int(row["count"]) + 1

    def collect(self) -> List[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} {self.type}"]

        with self._lock:
            if not self._values:
                labels = self._normalize_labels({})
                for bucket in self.buckets:
                    lines.append(f"{self.name}_bucket{_format_labels({**labels, 'le': str(bucket)})} 0")
                lines.append(f"{self.name}_bucket{_format_labels({**labels, 'le': '+Inf'})} 0")
                lines.append(f"{self.name}_sum{_format_labels(labels)} 0")
                lines.append(f"{self.name}_count{_format_labels(labels)} 0")
                return lines

            for row in self._values.values():
                labels = row["labels"]
                for idx, bucket in enumerate(self.buckets):
                    lines.append(
                        f"{self.name}_bucket{_format_labels({**labels, 'le': str(bucket)})} {row['counts'][idx]}"
                    )
                lines.append(f"{self.name}_bucket{_format_labels({**labels, 'le': '+Inf'})} {row['count']}")
                lines.append(f"{self.name}_sum{_format_labels(labels)} {row['sum']}")
                lines.append(f"{self.name}_count{_format_labels(labels)} {row['count']}")
        return lines


class Registry:
    def __init__(self):
        self._metrics: List[_MetricBase] = []

    def register(self, metric: _MetricBase):
        self._metrics.append(metric)
        return metric

    def render(self) -> str:
        lines: List[str] = []
        for metric in self._metrics:
            lines.extend(metric.collect())
        lines.append("")
        return "\n".join(lines)


registry = Registry()

request_duration_seconds = registry.register(
    Histogram(
        "request_duration_seconds",
        "paper-ai request latency seconds",
        label_names=["route", "method"],
        buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    )
)

errors_total = registry.register(
    Counter("errors_total", "paper-ai errors by class", label_names=["class"])
)

ollama_call_duration_seconds = registry.register(
    Histogram(
        "ollama_call_duration_seconds",
        "Ollama API call latency seconds",
        label_names=["model"],
        buckets=[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 80, 160],
    )
)

ollama_timeouts_total = registry.register(
    Counter("ollama_timeouts_total", "Ollama timeout count", label_names=["model"])
)

stage_duration_seconds = registry.register(
    Histogram(
        "stage_duration_seconds",
        "Pipeline stage latency seconds",
        label_names=["stage"],
        buckets=[0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    )
)

summary_output_tokens = registry.register(
    Histogram(
        "summary_output_tokens",
        "Approximate output token count",
        label_names=["kind"],
        buckets=[16, 32, 64, 128, 256, 512, 1024, 2048, 4096],
    )
)


def render_metrics() -> str:
    return registry.render()


def observe_stage(stage: str, seconds: float) -> None:
    stage_duration_seconds.observe({"stage": str(stage or "unknown")}, max(0.0, float(seconds or 0.0)))


def observe_ollama_latency(model: str, seconds: float) -> None:
    ollama_call_duration_seconds.observe({"model": str(model or "unknown")}, max(0.0, float(seconds or 0.0)))


def inc_ollama_timeout(model: str) -> None:
    ollama_timeouts_total.inc({"model": str(model or "unknown")}, 1)


def inc_error(class_name: str) -> None:
    errors_total.inc({"class": str(class_name or "unknown")}, 1)


def observe_output_tokens(kind: str, token_count: int) -> None:
    try:
        n = int(token_count)
    except Exception:
        return
    if n < 0:
        return
    summary_output_tokens.observe({"kind": str(kind or "summary")}, float(n))


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    # fast approximate token estimator for local metrics
    return max(1, int(len(text.split()) * 1.3))


def json_log(message: str, **fields) -> None:
    payload = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "message": str(message),
        **fields,
    }
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def make_request_id(raw: Optional[str]) -> str:
    value = (raw or "").strip()
    return value if value else str(uuid.uuid4())
