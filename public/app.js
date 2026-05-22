let state = [];

let submitted = false;
let aiConfigured = false;
const API_BASE_URL = (window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");

const list = document.querySelector("#question-list");
const nameInput = document.querySelector("#student-name");
const emailInput = document.querySelector("#student-email");
const submitAllButton = document.querySelector("#submit-all");
const evaluateAllButton = document.querySelector("#evaluate-all");
const summary = document.querySelector("#summary");
const warning = document.querySelector("#config-warning");

init();

async function init() {
  await loadQuestions();
  renderQuestions();
  bindEvents();
  updateSummary();
  updateButtonStates();

  try {
    const response = await apiFetch("/api/config");
    const config = await response.json();
    aiConfigured = Boolean(config.aiConfigured);
    warning.classList.toggle("hidden", Boolean(config.driveConfigured));
    updateButtonStates();
  } catch {
    warning.classList.remove("hidden");
  }
}

async function loadQuestions() {
  const response = await fetch("./questions.json", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取题目文件 questions.json");

  const prompts = await response.json();
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error("questions.json 必须是至少包含一道题目的数组。");
  }

  state = prompts
    .map((prompt, index) => ({
      prompt: String(prompt).trim(),
      questionNumber: index + 1,
      recorder: null,
      chunks: [],
      blob: null,
      audioUrl: "",
      uploaded: false,
      uploading: false,
      evaluating: false,
      evaluation: null,
    }))
    .filter((item) => item.prompt);
}

function renderQuestions() {
  list.innerHTML = state.map((item) => `
    <article class="question-card" data-question="${item.questionNumber}">
      <div class="question-number">Q${item.questionNumber}</div>
      <p class="prompt">${item.prompt}</p>
      <div class="controls">
        <button class="record-button" type="button">开始录音</button>
        <button class="play-button" type="button" disabled>回放</button>
        <button class="upload-button" type="button" disabled>上传</button>
        <button class="evaluate-button" type="button" disabled>AI打分</button>
        <span class="status">未录音</span>
      </div>
      <div class="evaluation" aria-live="polite"></div>
    </article>
  `).join("");
}

function bindEvents() {
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || submitted) return;

    const card = button.closest(".question-card");
    const item = state[Number(card.dataset.question) - 1];

    try {
      if (button.classList.contains("record-button")) {
        await toggleRecording(item, card);
      }

      if (button.classList.contains("play-button")) {
        playRecording(item);
      }

      if (button.classList.contains("upload-button")) {
        await uploadQuestion(item, card);
      }

      if (button.classList.contains("evaluate-button")) {
        await evaluateQuestion(item);
      }
    } catch (error) {
      alert(error.message);
    }
  });

  submitAllButton.addEventListener("click", submitAll);
  evaluateAllButton.addEventListener("click", evaluateAll);
  nameInput.addEventListener("input", updateButtonStates);
  emailInput.addEventListener("input", updateButtonStates);
}

async function toggleRecording(item, card) {
  const recordButton = card.querySelector(".record-button");
  const playButton = card.querySelector(".play-button");
  const uploadButton = card.querySelector(".upload-button");
  const evaluateButton = card.querySelector(".evaluate-button");
  const status = card.querySelector(".status");

  if (item.recorder && item.recorder.state === "recording") {
    item.recorder.stop();
    recordButton.textContent = "开始录音";
    recordButton.classList.remove("recording");
    status.textContent = "处理中";
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  item.chunks = [];
  item.blob = null;
  if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
  item.audioUrl = "";
  item.uploaded = false;
  item.evaluation = null;
  renderEvaluation(item);
  const mimeType = pickMimeType();
  item.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  item.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) item.chunks.push(event.data);
  });

  item.recorder.addEventListener("stop", () => {
    item.blob = new Blob(item.chunks, { type: item.recorder.mimeType || "audio/webm" });
    item.audioUrl = URL.createObjectURL(item.blob);
    stream.getTracks().forEach((track) => track.stop());
    playButton.disabled = false;
    status.textContent = "已录音";
    updateSummary();
    updateButtonStates();
  });

  item.recorder.start();
  playButton.disabled = true;
  uploadButton.disabled = true;
  evaluateButton.disabled = true;
  recordButton.textContent = "停止录音";
  recordButton.classList.add("recording");
  status.textContent = "录音中";
}

function playRecording(item) {
  if (!item.audioUrl) {
    alert(`Q${item.questionNumber} 还没有录音。`);
    return;
  }
  new Audio(item.audioUrl).play();
}

async function uploadQuestion(item, card) {
  validateStudentInfo();
  if (!item.blob) throw new Error(`Q${item.questionNumber} 还没有录音。`);

  const recordButton = card.querySelector(".record-button");
  const playButton = card.querySelector(".play-button");
  const uploadButton = card.querySelector(".upload-button");
  const evaluateButton = card.querySelector(".evaluate-button");
  const status = card.querySelector(".status");
  item.uploading = true;
  recordButton.disabled = true;
  playButton.disabled = true;
  uploadButton.disabled = true;
  evaluateButton.disabled = true;
  status.textContent = "上传中";
  updateSummary();

  try {
    const form = new FormData();
    form.append("studentName", nameInput.value.trim());
    form.append("email", emailInput.value.trim());
    form.append("questionNumber", String(item.questionNumber));
    form.append("audio", item.blob, `Q${item.questionNumber}.webm`);

    const response = await apiFetch("/api/upload", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "上传失败");

    item.uploaded = true;
    status.textContent = "已上传";
  } catch (error) {
    status.textContent = "上传失败";
    recordButton.disabled = false;
    playButton.disabled = !item.blob;
    alert(`Q${item.questionNumber}: ${error.message}`);
  } finally {
    item.uploading = false;
    updateButtonStates();
    updateSummary();
  }
}

async function submitAll() {
  try {
    validateStudentInfo();
  } catch (error) {
    alert(error.message);
    return;
  }

  const missing = state.filter((item) => !item.blob).map((item) => `Q${item.questionNumber}`);
  if (missing.length) {
    alert(`请先完成这些题目的录音：${missing.join("，")}`);
    return;
  }

  submitAllButton.disabled = true;
  submitAllButton.textContent = "提交中";

  for (const item of state) {
    if (!item.uploaded) {
      const card = document.querySelector(`[data-question="${item.questionNumber}"]`);
      await uploadQuestion(item, card);
    }
  }

  if (state.every((item) => item.uploaded)) {
    submitted = true;
    document.querySelectorAll("button, input").forEach((element) => {
      element.disabled = true;
    });
    submitAllButton.textContent = "已提交";
  } else {
    submitAllButton.disabled = false;
    submitAllButton.textContent = "提交全部录音";
  }
  updateSummary();
}

async function evaluateAll() {
  const missing = state.filter((item) => !item.blob).map((item) => `Q${item.questionNumber}`);
  if (missing.length) {
    alert(`请先完成这些题目的录音：${missing.join("，")}`);
    return;
  }

  evaluateAllButton.disabled = true;
  evaluateAllButton.textContent = "评估中";

  for (const item of state) {
    await evaluateQuestion(item);
  }

  evaluateAllButton.textContent = "AI评估";
  updateButtonStates();
}

async function evaluateQuestion(item) {
  const card = document.querySelector(`[data-question="${item.questionNumber}"]`);
  const evaluationBox = card.querySelector(".evaluation");
  item.evaluating = true;
  evaluationBox.classList.add("visible");
  evaluationBox.textContent = "AI正在评估...";
  updateButtonStates();

  try {
    const form = new FormData();
    form.append("questionNumber", String(item.questionNumber));
    form.append("prompt", item.prompt);
    form.append("audio", item.blob, `Q${item.questionNumber}.webm`);

    const response = await apiFetch("/api/evaluate", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI评估失败");

    item.evaluation = {
      score: data.score,
      completenessScore: data.completenessScore,
      pronunciationScore: data.pronunciationScore,
      feedback: data.feedback,
      transcript: data.transcript,
    };
  } catch (error) {
    item.evaluation = {
      score: null,
      feedback: error.message,
      transcript: "",
      failed: true,
    };
  } finally {
    item.evaluating = false;
    renderEvaluation(item);
    updateButtonStates();
  }
}

function renderEvaluation(item) {
  const card = document.querySelector(`[data-question="${item.questionNumber}"]`);
  if (!card) return;

  const evaluationBox = card.querySelector(".evaluation");
  if (!item.evaluation) {
    evaluationBox.classList.remove("visible");
    evaluationBox.textContent = "";
    return;
  }

  evaluationBox.classList.add("visible");
  if (item.evaluation.failed) {
    evaluationBox.textContent = item.evaluation.feedback;
    return;
  }

  evaluationBox.innerHTML = `
    <div><strong>AI评分：${item.evaluation.score}/100</strong></div>
    <div>阅读完整性：${item.evaluation.completenessScore}/50　发音清晰度：${item.evaluation.pronunciationScore}/50</div>
    <div>${escapeHtml(item.evaluation.feedback)}</div>
    <div class="transcript">识别文本：${escapeHtml(item.evaluation.transcript || "未识别到清楚文字")}</div>
  `;
}

function validateStudentInfo() {
  if (!nameInput.reportValidity() || !emailInput.reportValidity()) {
    throw new Error("请先填写学生姓名和邮箱。");
  }
}

function updateSummary() {
  const recorded = state.filter((item) => item.blob).length;
  const uploaded = state.filter((item) => item.uploaded).length;
  summary.textContent = `已录音 ${recorded} / ${state.length}，已上传 ${uploaded} / ${state.length}`;
}

function updateButtonStates() {
  if (submitted) return;

  const hasStudentInfo = Boolean(nameInput.value.trim()) && emailInput.validity.valid && Boolean(emailInput.value.trim());

  state.forEach((item) => {
    const card = document.querySelector(`[data-question="${item.questionNumber}"]`);
    if (!card) return;

    const recordButton = card.querySelector(".record-button");
    const playButton = card.querySelector(".play-button");
    const uploadButton = card.querySelector(".upload-button");
    const evaluateButton = card.querySelector(".evaluate-button");
    const isRecording = item.recorder && item.recorder.state === "recording";

    recordButton.disabled = item.uploading || item.evaluating;
    playButton.disabled = !item.blob || item.uploading || item.evaluating || isRecording;
    uploadButton.disabled = !hasStudentInfo || !item.blob || item.uploaded || item.uploading || item.evaluating || isRecording;
    evaluateButton.disabled = !aiConfigured || !item.blob || item.uploading || item.evaluating || isRecording;
  });

  submitAllButton.disabled = !hasStudentInfo;
  evaluateAllButton.disabled = !aiConfigured || state.some((item) => !item.blob || item.evaluating);
}

function pickMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function apiFetch(path, options) {
  return fetch(`${API_BASE_URL}${path}`, options);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
