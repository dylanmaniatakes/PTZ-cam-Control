const storageKey = "ptz-cam-control.settings";

const elements = {
  connectForm: document.getElementById("connectForm"),
  disconnectButton: document.getElementById("disconnectButton"),
  clearButton: document.getElementById("clearButton"),
  refreshButton: document.getElementById("refreshButton"),
  homeButton: document.getElementById("homeButton"),
  sendRawButton: document.getElementById("sendRawButton"),
  host: document.getElementById("host"),
  port: document.getElementById("port"),
  cameraAddress: document.getElementById("cameraAddress"),
  panSpeed: document.getElementById("panSpeed"),
  tiltSpeed: document.getElementById("tiltSpeed"),
  zoomSpeed: document.getElementById("zoomSpeed"),
  panSpeedValue: document.getElementById("panSpeedValue"),
  tiltSpeedValue: document.getElementById("tiltSpeedValue"),
  zoomSpeedValue: document.getElementById("zoomSpeedValue"),
  preset: document.getElementById("preset"),
  rawHex: document.getElementById("rawHex"),
  connectionBadge: document.getElementById("connectionBadge"),
  bridgeTarget: document.getElementById("bridgeTarget"),
  lastError: document.getElementById("lastError"),
  logList: document.getElementById("logList"),
  webhookHomeExample: document.getElementById("webhookHomeExample"),
  webhookPresetExample: document.getElementById("webhookPresetExample"),
  webhookLeftExample: document.getElementById("webhookLeftExample"),
  webhookZoomExample: document.getElementById("webhookZoomExample")
};

let activeHold = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  localStorage.setItem(storageKey, JSON.stringify({
    host: elements.host.value,
    port: elements.port.value,
    cameraAddress: elements.cameraAddress.value,
    panSpeed: elements.panSpeed.value,
    tiltSpeed: elements.tiltSpeed.value,
    zoomSpeed: elements.zoomSpeed.value,
    preset: elements.preset.value,
    rawHex: elements.rawHex.value
  }));
}

function hydrateSettings() {
  const settings = {
    host: "",
    port: "4001",
    cameraAddress: "1",
    panSpeed: "6",
    tiltSpeed: "6",
    zoomSpeed: "2",
    preset: "1",
    rawHex: "",
    ...loadSettings()
  };

  for (const [key, value] of Object.entries(settings)) {
    if (elements[key]) {
      elements[key].value = value;
    }
  }

  syncSpeedLabels();
}

function syncSpeedLabels() {
  elements.panSpeedValue.textContent = elements.panSpeed.value;
  elements.tiltSpeedValue.textContent = elements.tiltSpeed.value;
  elements.zoomSpeedValue.textContent = elements.zoomSpeed.value;
}

function renderWebhookExamples() {
  const base = window.location.origin;
  elements.webhookHomeExample.textContent = `${base}/hook/action/home`;
  elements.webhookPresetExample.textContent = `${base}/hook/preset/1`;
  elements.webhookLeftExample.textContent = `${base}/hook/action/left?duration=250`;
  elements.webhookZoomExample.textContent = `${base}/hook/action/zoomTele?duration=200`;
}

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

function commandPayload(action) {
  return {
    action,
    cameraAddress: elements.cameraAddress.value,
    panSpeed: elements.panSpeed.value,
    tiltSpeed: elements.tiltSpeed.value,
    zoomSpeed: elements.zoomSpeed.value,
    preset: elements.preset.value
  };
}

function stopActionFor(action) {
  if (action === "zoomTele" || action === "zoomWide") {
    return "zoomStop";
  }
  return "stop";
}

async function sendVisca(action) {
  saveSettings();
  await api("/api/visca", "POST", commandPayload(action));
  await refreshState();
}

async function startHold(action) {
  if (activeHold && activeHold !== action) {
    await stopHold();
  }
  activeHold = action;
  await sendVisca(action);
}

async function stopHold() {
  if (!activeHold) {
    return;
  }

  const stopAction = stopActionFor(activeHold);
  activeHold = null;
  await sendVisca(stopAction);
}

function renderState(state) {
  const connected = Boolean(state.connected);
  elements.connectionBadge.textContent = connected ? "Connected" : state.connecting ? "Connecting" : "Disconnected";
  elements.connectionBadge.className = connected ? "badge badge-online" : "badge badge-offline";
  elements.bridgeTarget.textContent = state.host && state.port ? `${state.host}:${state.port}` : "No bridge selected";

  if ((!elements.host.value || !elements.port.value) && state.savedBridge) {
    elements.host.value = state.savedBridge.host || elements.host.value;
    elements.port.value = state.savedBridge.port || elements.port.value;
    saveSettings();
  }

  if (state.lastError) {
    elements.lastError.textContent = state.lastError;
    elements.lastError.classList.remove("hidden");
  } else {
    elements.lastError.classList.add("hidden");
    elements.lastError.textContent = "";
  }

  const logHtml = state.logs.map((entry) => {
    const hex = entry.hex ? `<code>${escapeHtml(entry.hex)}</code>` : "";
    return `
      <article class="log-entry">
        <header>
          <span class="log-kind">${escapeHtml(entry.kind.toUpperCase())}</span>
          <time>${new Date(entry.at).toLocaleTimeString()}</time>
        </header>
        <p>${escapeHtml(entry.message)}</p>
        ${hex}
      </article>
    `;
  }).join("");

  elements.logList.innerHTML = logHtml || `<p class="hint">No activity yet.</p>`;
}

async function refreshState() {
  const state = await api("/api/state");
  renderState(state);
}

elements.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveSettings();
  await api("/api/connect", "POST", {
    host: elements.host.value.trim(),
    port: elements.port.value
  });
  await refreshState();
});

elements.disconnectButton.addEventListener("click", async () => {
  activeHold = null;
  await api("/api/disconnect", "POST");
  await refreshState();
});

elements.clearButton.addEventListener("click", async () => {
  await sendVisca("ifClear");
});

elements.homeButton.addEventListener("click", async () => {
  await sendVisca("home");
});

elements.sendRawButton.addEventListener("click", async () => {
  saveSettings();
  await api("/api/raw", "POST", { hex: elements.rawHex.value });
  await refreshState();
});

elements.refreshButton.addEventListener("click", refreshState);

for (const input of [elements.host, elements.port, elements.cameraAddress, elements.preset, elements.rawHex]) {
  input.addEventListener("input", saveSettings);
}

for (const input of [elements.panSpeed, elements.tiltSpeed, elements.zoomSpeed]) {
  input.addEventListener("input", () => {
    syncSpeedLabels();
    saveSettings();
  });
}

for (const button of document.querySelectorAll("[data-click-action]")) {
  button.addEventListener("click", async () => {
    await sendVisca(button.dataset.clickAction);
  });
}

for (const button of document.querySelectorAll("[data-preset-action]")) {
  button.addEventListener("click", async () => {
    await sendVisca(button.dataset.presetAction);
  });
}

for (const button of document.querySelectorAll("[data-quick-preset]")) {
  button.addEventListener("click", async () => {
    elements.preset.value = button.dataset.quickPreset;
    saveSettings();
    await sendVisca("presetRecall");
  });
}

for (const button of document.querySelectorAll("[data-hold-action]")) {
  const action = button.dataset.holdAction;

  button.addEventListener("pointerdown", async (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    await startHold(action);
  });

  const release = async () => {
    if (activeHold === action) {
      await stopHold();
    }
  };

  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
}

window.addEventListener("blur", () => {
  stopHold().catch(console.error);
});

hydrateSettings();
renderWebhookExamples();
refreshState().catch(console.error);
setInterval(() => {
  refreshState().catch(console.error);
}, 1500);
