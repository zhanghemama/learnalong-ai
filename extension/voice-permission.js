const statusEl = document.querySelector("#status");
const requestButton = document.querySelector("#requestMic");

requestButton.addEventListener("click", requestMicrophonePermission);

async function requestMicrophonePermission() {
  requestButton.disabled = true;
  statusEl.textContent = "正在请求麦克风权限...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    statusEl.textContent = "麦克风已授权。现在可以回到 LearnAlong AI 侧边栏，按住“按住问”开始提问。";
  } catch (error) {
    requestButton.disabled = false;
    statusEl.textContent = friendlyPermissionError(error);
  }
}

function friendlyPermissionError(error) {
  const name = error?.name || "";
  const message = error?.message || String(error || "");
  if (/Permission dismissed|Permission denied|NotAllowedError/i.test(`${name} ${message}`)) {
    return "还没有授权成功。请重新点击按钮，并在浏览器弹窗里选择允许麦克风。";
  }
  if (/NotFoundError|DevicesNotFoundError/i.test(`${name} ${message}`)) {
    return "没有检测到可用麦克风。请确认耳机或麦克风已连接。";
  }
  if (/NotReadableError|TrackStartError/i.test(`${name} ${message}`)) {
    return "麦克风正在被其他应用占用。请关闭会议或录音软件后重试。";
  }
  return `授权失败：${message}`;
}
