import { render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { installPerformanceHarness } from "./perf/harness";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("Whatfast root element is missing");

const performanceHarness = installPerformanceHarness();
render(() => <App />, root);

if (performanceHarness) {
  const capture = window.__WHATFAST_PERF_CONFIG__?.captureKind === "idle"
    ? performanceHarness.prepare().then(() => invoke("mark_performance_idle_ready"))
    : performanceHarness.run().then((result) => invoke("complete_performance_capture", { payload: { result } }));
  void capture
    .catch((error: unknown) => invoke("complete_performance_capture", {
      payload: { error: error instanceof Error ? error.message : String(error) },
    }));
}
