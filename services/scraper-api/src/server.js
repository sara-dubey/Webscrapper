import "dotenv/config";

import { createApp } from "./app.js";
import { logJson } from "./observability/logger.js";

const PORT = Number(process.env.PORT || 3001);
const PY_BASE = process.env.PY_BASE || "http://127.0.0.1:8000";

const app = createApp({ overrides: { port: PORT, pyBase: PY_BASE } });

process.on("unhandledRejection", (reason) => {
  logJson("error", "unhandled_rejection", { reason });
});

process.on("uncaughtException", (err) => {
  logJson("error", "uncaught_exception", { error: err });
});

app.listen(PORT, () => {
  logJson("info", "api_started", {
    port: PORT,
    py_base: PY_BASE,
  });
});
