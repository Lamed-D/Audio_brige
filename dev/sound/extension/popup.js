const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle");

function render(active) {
  statusEl.textContent = active ? "실행 중" : "꺼짐";
  toggleBtn.textContent = active ? "화면해설 중지" : "화면해설 시작";
}

chrome.runtime.sendMessage({ type: "popup-status" }, (res) => {
  render(res && res.active);
});

toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "popup-status" }, (res) => {
    const isActive = res && res.active;
    const action = isActive ? "popup-stop" : "popup-start";
    chrome.runtime.sendMessage({ type: action }, (result) => {
      toggleBtn.disabled = false;
      if (result && result.ok === false) {
        statusEl.textContent = `오류: ${result.error}`;
        return;
      }
      render(!isActive);
    });
  });
});
