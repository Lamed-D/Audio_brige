"use strict";

const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const statusDot = document.getElementById("statusDot");
const videoTitleEl = document.getElementById("videoTitle");
const toggleButton = document.getElementById("toggle");
const duckInput = document.getElementById("duckFactor");
const duckValue = document.getElementById("duckValue");
const backendDot = document.getElementById("backendDot");
const backendStatus = document.getElementById("backendStatus");
const retryHealth = document.getElementById("retryHealth");

let panelState = null;
let busy = false;

const STATUS_LABELS = {
  off: "화면해설 꺼짐",
  loading: "매니페스트 확인 중",
  processing: "화면해설 생성 중",
  ready: "화면해설 준비됨",
  scheduled: "다음 해설 대기 중",
  playing: "화면해설 재생 중",
  paused: "영상 일시정지",
  muted: "영상 음소거됨",
  ended: "영상 재생 종료",
  "waiting-video": "영상 정보 대기 중",
  error: "오류가 발생했습니다",
};

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function render(state) {
  if (!state) return;
  panelState = state;
  const supported = !!state.supported;
  const enabled = !!state.enabled;
  const status = enabled ? state.status || "loading" : "off";

  statusEl.textContent = supported ? STATUS_LABELS[status] || status : "지원되는 YouTube 영상을 여세요";
  detailEl.textContent = state.error || (enabled && state.revision !== null ? `매니페스트 revision ${state.revision}` : "");
  videoTitleEl.textContent = state.title || (state.video_id ? `YouTube · ${state.video_id}` : "");
  statusDot.className = `dot ${status === "error" ? "error" : enabled ? "ok" : ""}`;

  toggleButton.disabled = busy || !supported;
  toggleButton.setAttribute("aria-pressed", String(enabled));
  toggleButton.textContent = enabled ? "화면해설 끄기" : "화면해설 켜기";

  if (Number.isFinite(state.duck_factor) && document.activeElement !== duckInput) {
    duckInput.value = String(state.duck_factor);
    duckValue.textContent = percent(state.duck_factor);
  }

  backendDot.className = `dot ${state.backend_ok ? "ok" : "error"}`;
  backendStatus.textContent = state.backend_ok ? "로컬 API 연결됨" : "로컬 API 연결 안 됨";
}

function showError(message) {
  statusEl.textContent = "오류가 발생했습니다";
  detailEl.textContent = message;
  statusDot.className = "dot error";
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "PANEL_STATE_GET" });
    if (!response || response.type === "ERROR") throw new Error(response && response.error ? response.error.message : "상태를 가져오지 못했습니다.");
    render(response);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    toggleButton.disabled = true;
  }
}

toggleButton.addEventListener("click", async () => {
  if (!panelState || busy) return;
  busy = true;
  toggleButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "PANEL_TOGGLE", enabled: !panelState.enabled });
    if (!response || response.type === "ERROR") throw new Error(response && response.error ? response.error.message : "상태 변경에 실패했습니다.");
    render(response);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    if (panelState) toggleButton.disabled = !panelState.supported;
  }
});

duckInput.addEventListener("input", () => {
  duckValue.textContent = percent(Number(duckInput.value));
});

duckInput.addEventListener("change", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "PANEL_DUCK_SET", duck_factor: Number(duckInput.value) });
    if (!response || response.type === "ERROR") throw new Error(response && response.error ? response.error.message : "원본 소리 크기를 저장하지 못했습니다.");
    render(response);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
});

retryHealth.addEventListener("click", async () => {
  retryHealth.disabled = true;
  backendStatus.textContent = "로컬 API 확인 중";
  try {
    const response = await chrome.runtime.sendMessage({ type: "HEALTH_CHECK" });
    if (response && response.type !== "ERROR") render(response);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    retryHealth.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "PANEL_STATE") render(message);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshState();
});

void refreshState();
