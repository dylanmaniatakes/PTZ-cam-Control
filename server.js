const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");
const BRIDGE_STATE_FILE = path.join(__dirname, "bridge-state.json");
const LOG_LIMIT = 120;
const WEBHOOK_TOKEN = String(process.env.WEBHOOK_TOKEN || "");
const AUTO_RECONNECT_MS = Number.parseInt(process.env.AUTO_RECONNECT_MS || "5000", 10);
const MOMENTARY_ACTIONS = new Set([
  "up",
  "down",
  "left",
  "right",
  "upLeft",
  "upRight",
  "downLeft",
  "downRight",
  "zoomTele",
  "zoomWide"
]);

const state = {
  socket: null,
  connected: false,
  connecting: false,
  host: "",
  port: null,
  lastError: null,
  logs: []
};

const stopTimers = {
  ptz: null,
  zoom: null
};

const reconnectState = {
  timer: null,
  manualDisconnect: false
};

function readSavedBridge() {
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const host = String(parsed.host || "").trim();
    const port = clamp(parsed.port, 1, 65535, 4001);

    if (!host) {
      return null;
    }

    return { host, port };
  } catch {
    return null;
  }
}

function writeSavedBridge(host, port) {
  const payload = JSON.stringify({ host, port }, null, 2);
  fs.writeFileSync(BRIDGE_STATE_FILE, payload);
}

function persistSavedBridge(host, port) {
  try {
    writeSavedBridge(host, port);
  } catch (error) {
    logEntry("error", `Failed to persist bridge state: ${error.message}`);
  }
}

function logEntry(kind, message, hex) {
  state.logs.unshift({
    id: Date.now() + Math.random(),
    at: new Date().toISOString(),
    kind,
    message,
    hex: hex || null
  });

  if (state.logs.length > LOG_LIMIT) {
    state.logs.length = LOG_LIMIT;
  }
}

function toHex(buffer) {
  return buffer.toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "";
}

function clamp(value, min, max, fallback = min) {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, num));
}

function viscaHeader(address) {
  return 0x80 | clamp(address, 1, 7, 1);
}

function buildViscaCommand(payload) {
  const action = payload.action;
  const header = viscaHeader(payload.cameraAddress);
  const panSpeed = clamp(payload.panSpeed, 1, 0x18, 0x06);
  const tiltSpeed = clamp(payload.tiltSpeed, 1, 0x17, 0x06);
  const zoomSpeed = clamp(payload.zoomSpeed, 0, 0x07, 0x02);
  const preset = clamp(payload.preset, 1, 64, 1);

  switch (action) {
    case "up":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x03, 0x01, 0xff]);
    case "down":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x03, 0x02, 0xff]);
    case "left":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x01, 0x03, 0xff]);
    case "right":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x02, 0x03, 0xff]);
    case "upLeft":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x01, 0x01, 0xff]);
    case "upRight":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x02, 0x01, 0xff]);
    case "downLeft":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x01, 0x02, 0xff]);
    case "downRight":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x02, 0x02, 0xff]);
    case "stop":
      return Buffer.from([header, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, 0x03, 0x03, 0xff]);
    case "zoomTele":
      return Buffer.from([header, 0x01, 0x04, 0x07, 0x20 | zoomSpeed, 0xff]);
    case "zoomWide":
      return Buffer.from([header, 0x01, 0x04, 0x07, 0x30 | zoomSpeed, 0xff]);
    case "zoomStop":
      return Buffer.from([header, 0x01, 0x04, 0x07, 0x00, 0xff]);
    case "home":
      return Buffer.from([header, 0x01, 0x06, 0x04, 0xff]);
    case "presetRecall":
      return Buffer.from([header, 0x01, 0x04, 0x3f, 0x02, preset, 0xff]);
    case "presetSet":
      return Buffer.from([header, 0x01, 0x04, 0x3f, 0x01, preset, 0xff]);
    case "presetReset":
      return Buffer.from([header, 0x01, 0x04, 0x3f, 0x00, preset, 0xff]);
    case "ifClear":
      return Buffer.from([header, 0x01, 0x00, 0x01, 0xff]);
    default:
      throw new Error(`Unsupported VISCA action: ${action}`);
  }
}

function parseRawHex(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Raw hex payload is empty.");
  }

  const normalized = input.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
  if (!normalized || normalized.length % 2 !== 0) {
    throw new Error("Raw hex must contain full bytes.");
  }

  return Buffer.from(normalized, "hex");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function snapshot() {
  const savedBridge = readSavedBridge();

  return {
    connected: state.connected,
    connecting: state.connecting,
    host: state.host,
    port: state.port,
    lastError: state.lastError,
    logs: state.logs,
    savedBridge,
    webhooks: {
      enabled: true,
      tokenRequired: Boolean(WEBHOOK_TOKEN)
    },
    autoReconnect: {
      enabled: true,
      intervalMs: AUTO_RECONNECT_MS,
      pausedByManualDisconnect: reconnectState.manualDisconnect
    }
  };
}

function actionGroup(action) {
  if (action === "zoomTele" || action === "zoomWide") {
    return "zoom";
  }

  if (MOMENTARY_ACTIONS.has(action)) {
    return "ptz";
  }

  return null;
}

function clearScheduledStop(group) {
  const timer = stopTimers[group];
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  stopTimers[group] = null;
}

function clearAllScheduledStops() {
  clearScheduledStop("ptz");
  clearScheduledStop("zoom");
}

function clearReconnectTimer() {
  if (!reconnectState.timer) {
    return;
  }

  clearTimeout(reconnectState.timer);
  reconnectState.timer = null;
}

function scheduleReconnect(reason) {
  if (reconnectState.manualDisconnect || state.connected || state.connecting) {
    return;
  }

  if (reconnectState.timer) {
    return;
  }

  const savedBridge = readSavedBridge();
  if (!savedBridge) {
    return;
  }

  reconnectState.timer = setTimeout(() => {
    reconnectState.timer = null;
    autoConnectSavedBridgeFromReason(reason).catch((error) => {
      logEntry("error", `Reconnect loop failed: ${error.message}`);
    });
  }, AUTO_RECONNECT_MS);
}

function stopActionFor(action) {
  if (action === "zoomTele" || action === "zoomWide") {
    return "zoomStop";
  }

  return "stop";
}

function clearSocketReference(socket) {
  if (state.socket === socket) {
    state.socket = null;
    state.connected = false;
    state.connecting = false;
  }
}

function disconnectCurrent(reason) {
  clearAllScheduledStops();
  clearReconnectTimer();

  if (!state.socket) {
    return;
  }

  const socket = state.socket;
  state.socket = null;
  state.connected = false;
  state.connecting = false;
  logEntry("status", reason || "Disconnected from bridge.");
  socket.destroy();
}

function disconnectManually(reason) {
  reconnectState.manualDisconnect = true;
  clearReconnectTimer();
  disconnectCurrent(reason);
}

function parseBoolean(value) {
  if (typeof value !== "string") {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseDuration(value, fallback = 350) {
  return clamp(value, 0, 60_000, fallback);
}

function readTokenFromRequest(req, url) {
  const authHeader = req.headers.authorization || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return (
    url.searchParams.get("token") ||
    req.headers["x-ptz-token"] ||
    (bearerMatch ? bearerMatch[1] : "")
  );
}

function assertWebhookAuthorized(req, url) {
  if (!WEBHOOK_TOKEN) {
    return;
  }

  if (readTokenFromRequest(req, url) !== WEBHOOK_TOKEN) {
    const error = new Error("Invalid or missing webhook token.");
    error.statusCode = 401;
    throw error;
  }
}

function webhookExamples(origin = `http://127.0.0.1:${PORT}`) {
  const tokenSuffix = WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : "";
  return {
    info: `${origin}/hook${tokenSuffix}`,
    home: `${origin}/hook/action/home${tokenSuffix}`,
    preset1: `${origin}/hook/preset/1${tokenSuffix}`,
    leftNudge: `${origin}/hook/action/left${tokenSuffix ? `${tokenSuffix}&duration=250` : "?duration=250"}`,
    zoomIn: `${origin}/hook/action/zoomTele${tokenSuffix ? `${tokenSuffix}&duration=200` : "?duration=200"}`,
    raw: `${origin}/hook/raw${tokenSuffix ? `${tokenSuffix}&hex=81%2001%2006%2004%20FF` : "?hex=81%2001%2006%2004%20FF"}`
  };
}

function connectToBridge(host, port) {
  return new Promise((resolve, reject) => {
    reconnectState.manualDisconnect = false;
    clearReconnectTimer();
    disconnectCurrent("Disconnected previous bridge session.");

    state.connecting = true;
    state.host = host;
    state.port = port;
    state.lastError = null;

    const socket = net.createConnection({ host, port });
    let settled = false;
    const connectTimeout = setTimeout(() => {
      finalizeError(new Error("Timed out while connecting to the bridge."));
      socket.destroy();
    }, 5000);

    state.socket = socket;
    socket.setNoDelay(true);

    const finalizeError = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      clearSocketReference(socket);
      logEntry("error", `Bridge error: ${message}`);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    };

    socket.once("connect", () => {
      if (state.socket !== socket) {
        socket.destroy();
        return;
      }

      clearTimeout(connectTimeout);
      state.connected = true;
      state.connecting = false;
      persistSavedBridge(host, port);
      logEntry("status", `Connected to ${host}:${port}.`);
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    socket.on("data", (data) => {
      logEntry("rx", "Camera reply", toHex(data));
    });

    socket.on("error", (error) => {
      clearTimeout(connectTimeout);
      finalizeError(error);
      scheduleReconnect("socket error");
    });

    socket.on("close", () => {
      clearTimeout(connectTimeout);
      const wasActive = state.socket === socket;
      clearSocketReference(socket);
      if (wasActive) {
        logEntry("status", "Bridge connection closed.");
        scheduleReconnect("socket closed");
      }
    });
  });
}

function writeToCamera(buffer, label) {
  return new Promise((resolve, reject) => {
    if (!state.socket || !state.connected) {
      reject(new Error("Not connected to a TCP bridge."));
      return;
    }

    state.socket.write(buffer, (error) => {
      if (error) {
        state.lastError = error.message;
        reject(error);
        return;
      }

      logEntry("tx", label, toHex(buffer));
      resolve();
    });
  });
}

async function sendViscaAction(payload, labelPrefix = "VISCA") {
  const command = buildViscaCommand(payload);
  await writeToCamera(command, `${labelPrefix} ${payload.action}`);
}

async function runTimedViscaAction(payload, durationMs, labelPrefix = "Webhook") {
  const group = actionGroup(payload.action);
  if (group) {
    clearScheduledStop(group);
  }

  await sendViscaAction(payload, labelPrefix);

  if (!group || durationMs <= 0) {
    return;
  }

  const stopPayload = {
    ...payload,
    action: stopActionFor(payload.action)
  };

  stopTimers[group] = setTimeout(async () => {
    stopTimers[group] = null;

    try {
      await sendViscaAction(stopPayload, `${labelPrefix} auto-stop`);
    } catch (error) {
      logEntry("error", `Auto-stop failed: ${error.message}`);
    }
  }, durationMs);
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  filePath = path.normalize(filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(filePath) });
    res.end(content);
  });
}

async function readHookPayload(req, url) {
  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const fromQuery = Object.fromEntries(url.searchParams.entries());
  return { ...fromQuery, ...body };
}

async function handleHookRequest(req, res, url, pathname) {
  assertWebhookAuthorized(req, url);

  const segments = pathname.split("/").filter(Boolean);
  const origin = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;

  if (segments.length === 1) {
    sendJson(res, 200, {
      ok: true,
      tokenRequired: Boolean(WEBHOOK_TOKEN),
      routes: {
        action: "/hook/action/:action",
        preset: "/hook/preset/:number",
        raw: "/hook/raw?hex=81%2001%2006%2004%20FF",
        connect: "/hook/connect?host=192.168.1.50&port=4001",
        disconnect: "/hook/disconnect"
      },
      examples: webhookExamples(origin)
    });
    return;
  }

  const payload = await readHookPayload(req, url);
  const cameraAddress = payload.cameraAddress;
  const panSpeed = payload.panSpeed;
  const tiltSpeed = payload.tiltSpeed;
  const zoomSpeed = payload.zoomSpeed;

  if (segments[1] === "connect") {
    const host = String(payload.host || "").trim();
    const port = clamp(payload.port, 1, 65535, 4001);

    if (!host) {
      sendJson(res, 400, { error: "Host is required." });
      return;
    }

    await connectToBridge(host, port);
    sendJson(res, 200, { ok: true, state: snapshot() });
    return;
  }

  if (segments[1] === "disconnect") {
    disconnectManually("Disconnected by webhook.");
    sendJson(res, 200, { ok: true, state: snapshot() });
    return;
  }

  if (segments[1] === "raw") {
    const command = parseRawHex(String(payload.hex || ""));
    await writeToCamera(command, "Webhook raw hex command");
    sendJson(res, 200, { ok: true, command: toHex(command) });
    return;
  }

  if (segments[1] === "preset") {
    const preset = clamp(segments[2] || payload.preset, 1, 64, 1);
    const mode = String(payload.mode || payload.action || "recall");
    const actionMap = {
      recall: "presetRecall",
      set: "presetSet",
      reset: "presetReset"
    };
    const action = actionMap[mode];

    if (!action) {
      sendJson(res, 400, { error: "Preset mode must be recall, set, or reset." });
      return;
    }

    await sendViscaAction({ action, preset, cameraAddress }, "Webhook");
    sendJson(res, 200, { ok: true, action, preset });
    return;
  }

  if (segments[1] === "action") {
    const action = segments[2];
    if (!action) {
      sendJson(res, 400, { error: "Action is required." });
      return;
    }

    const duration = parseBoolean(String(payload.hold || "")) ? 0 : parseDuration(payload.duration, 350);
    await runTimedViscaAction(
      {
        action,
        cameraAddress,
        panSpeed,
        tiltSpeed,
        zoomSpeed,
        preset: payload.preset
      },
      duration,
      "Webhook"
    );

    sendJson(res, 200, { ok: true, action, duration });
    return;
  }

  sendJson(res, 404, { error: "Unknown webhook route." });
}

async function autoConnectSavedBridge() {
  return autoConnectSavedBridgeFromReason("startup");
}

async function autoConnectSavedBridgeFromReason(reason) {
  const savedBridge = readSavedBridge();
  if (!savedBridge) {
    logEntry("status", "No saved bridge configuration found.");
    return;
  }

  if (reconnectState.manualDisconnect || state.connected || state.connecting) {
    return;
  }

  state.host = savedBridge.host;
  state.port = savedBridge.port;
  logEntry("status", `Attempting auto-connect to ${savedBridge.host}:${savedBridge.port}${reason ? ` (${reason})` : ""}.`);

  try {
    await connectToBridge(savedBridge.host, savedBridge.port);
  } catch (error) {
    logEntry("error", `Auto-connect failed: ${error.message}`);
    scheduleReconnect("retry");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if ((req.method === "GET" || req.method === "POST") && pathname.startsWith("/hook")) {
      await handleHookRequest(req, res, url, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && pathname === "/api/connect") {
      const body = await readJsonBody(req);
      const host = String(body.host || "").trim();
      const port = clamp(body.port, 1, 65535, 4001);

      if (!host) {
        sendJson(res, 400, { error: "Host is required." });
        return;
      }

      await connectToBridge(host, port);
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && pathname === "/api/disconnect") {
      disconnectManually("Disconnected by user.");
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && pathname === "/api/visca") {
      const body = await readJsonBody(req);
      const command = buildViscaCommand(body);
      await writeToCamera(command, `VISCA ${body.action}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/raw") {
      const body = await readJsonBody(req);
      const command = parseRawHex(body.hex);
      await writeToCamera(command, "Raw hex command");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res, pathname);
      return;
    }

    sendText(res, 405, "Method not allowed");
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  logEntry("status", `HTTP UI listening on http://127.0.0.1:${PORT}.`);
  console.log(`PTZ control app running on http://127.0.0.1:${PORT}`);
  autoConnectSavedBridge().catch((error) => {
    logEntry("error", `Startup auto-connect failed: ${error.message}`);
  });
});
