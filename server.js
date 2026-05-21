const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Readable } = require("stream");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

loadDotEnv(path.join(ROOT, ".env.local"));

const PORT = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let cachedToken = null;

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(PUBLIC_DIR, "index.html"));
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const requested = path.normalize(url.pathname.replace(/^\/public\//, ""));
      const filePath = path.join(PUBLIC_DIR, requested);
      if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
      return serveFile(res, filePath);
    }

    if (req.method === "GET" && ["/app.js", "/styles.css", "/config.js", "/questions.json"].includes(url.pathname)) {
      return serveFile(res, path.join(PUBLIC_DIR, url.pathname.slice(1)));
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        driveConfigured: isDriveConfigured(),
        aiConfigured: Boolean(process.env.OPENAI_API_KEY),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/upload") {
      return await handleUpload(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/evaluate") {
      return await handleEvaluation(req, res);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: toUserFacingError(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Speaking test app running at http://localhost:${PORT}`);
});

async function handleUpload(req, res) {
  const form = await parseMultipart(req);
  const studentName = cleanStudentName(String(form.get("studentName") || ""));
  const email = String(form.get("email") || "").trim();
  const questionNumber = Number(form.get("questionNumber"));
  const audio = form.get("audio");

  if (!studentName) return sendJson(res, 400, { error: "Student name is required." });
  if (!email || !email.includes("@")) return sendJson(res, 400, { error: "Valid email is required." });
  if (!Number.isInteger(questionNumber) || questionNumber < 1) {
    return sendJson(res, 400, { error: "Question number must be a positive integer." });
  }
  if (!audio || typeof audio.arrayBuffer !== "function") {
    return sendJson(res, 400, { error: "Audio file is required." });
  }

  const cfg = getDriveConfig();
  if (!isDriveConfigured()) {
    return sendJson(res, 500, {
    error: "Google Drive is not configured. Please fill .env.local with service account or OAuth credentials.",
    });
  }

  const studentFolderId = await findOrCreateStudentFolder(studentName);
  const filename = `Q${questionNumber}.webm`;
  const buffer = Buffer.from(await audio.arrayBuffer());
  await deleteExistingDriveFiles(studentFolderId, filename);
  const uploaded = await uploadDriveFile({
    folderId: studentFolderId,
    filename,
    buffer,
    mimeType: audio.type || "audio/webm",
    description: `Student: ${studentName}; Email: ${email}; Question: Q${questionNumber}`,
  });

  sendJson(res, 200, {
    ok: true,
    questionNumber,
    fileId: uploaded.id,
    fileName: uploaded.name,
    studentFolderId,
  });
}

async function handleEvaluation(req, res) {
  const form = await parseMultipart(req);
  const questionNumber = Number(form.get("questionNumber"));
  const prompt = String(form.get("prompt") || "").trim();
  const audio = form.get("audio");

  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 500, { error: "OpenAI API key is not configured. Please add OPENAI_API_KEY to .env.local." });
  }
  if (!Number.isInteger(questionNumber) || questionNumber < 1) {
    return sendJson(res, 400, { error: "Question number must be a positive integer." });
  }
  if (!prompt) return sendJson(res, 400, { error: "Prompt text is required." });
  if (!audio || typeof audio.arrayBuffer !== "function") {
    return sendJson(res, 400, { error: "Audio file is required." });
  }

  const buffer = Buffer.from(await audio.arrayBuffer());
  const transcript = await transcribeAudio(buffer, audio.type || "audio/webm", `Q${questionNumber}.webm`);
  const evaluation = await evaluateReading({ questionNumber, prompt, transcript });
  sendJson(res, 200, {
    ok: true,
    questionNumber,
    transcript,
    ...evaluation,
  });
}

async function parseMultipart(req) {
  const request = new Request("http://localhost/api/upload", {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
  return request.formData();
}

async function findOrCreateStudentFolder(studentName) {
  const cfg = getDriveConfig();
  const token = await getAccessToken();
  const escapedName = studentName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = [
    `'${cfg.parentFolderId}' in parents`,
    `name = '${escapedName}'`,
    `mimeType = '${DRIVE_FOLDER_MIME}'`,
    "trashed = false",
  ].join(" and ");

  const searchUrl = new URL("https://www.googleapis.com/drive/v3/files");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("fields", "files(id,name)");
  searchUrl.searchParams.set("supportsAllDrives", "true");
  searchUrl.searchParams.set("includeItemsFromAllDrives", "true");

  const found = await driveFetch(searchUrl, { method: "GET", token });
  if (found.files && found.files[0]) return found.files[0].id;

  const created = await driveFetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      name: studentName,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [cfg.parentFolderId],
    }),
  });
  return created.id;
}

async function uploadDriveFile({ folderId, filename, buffer, mimeType, description }) {
  const token = await getAccessToken();
  const boundary = `upload_${crypto.randomBytes(12).toString("hex")}`;
  const metadata = {
    name: filename,
    parents: [folderId],
    description,
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
    method: "POST",
    token,
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function deleteExistingDriveFiles(folderId, filename) {
  const token = await getAccessToken();
  const escapedName = filename.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = [
    `'${folderId}' in parents`,
    `name = '${escapedName}'`,
    "trashed = false",
  ].join(" and ");

  const searchUrl = new URL("https://www.googleapis.com/drive/v3/files");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("fields", "files(id,name)");
  searchUrl.searchParams.set("supportsAllDrives", "true");
  searchUrl.searchParams.set("includeItemsFromAllDrives", "true");

  const found = await driveFetch(searchUrl, { method: "GET", token });
  for (const file of found.files || []) {
    const deleteUrl = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}`);
    deleteUrl.searchParams.set("supportsAllDrives", "true");
    await driveFetch(deleteUrl, { method: "DELETE", token });
  }
}

async function transcribeAudio(buffer, mimeType, filename) {
  const form = new FormData();
  form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
  form.append("language", "zh");
  form.append("response_format", "json");
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `OpenAI transcription failed with ${response.status}`);
  return data.text || "";
}

async function evaluateReading({ questionNumber, prompt, transcript }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_EVALUATION_MODEL || "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: [
            "你是一名美国小学中文老师，正在评价四年级学生的中文朗读。",
            "评分必须保守，不能因为语音识别文本看起来接近就自动给高分。",
            "如果转写为空、明显不完整、或缺少目标句子的关键内容，阅读完整性必须低分。",
            "总分由两部分组成：阅读完整性 0-50 分，发音和读音清晰度 0-50 分，共 100 分。",
            "反馈要温和、具体、简短，指出漏读/错读/发音清晰度方面的一到两个重点。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `题号：Q${questionNumber}`,
            `目标句子：${prompt}`,
            `语音转写：${transcript || "未识别到清楚文字"}`,
            "请按以下标准评分：",
            "1. 阅读完整性 0-50 分：学生是否读出了目标句子的主要字词、顺序和完整意思。漏读、跳读、读成别的句子、转写为空都要明显扣分。",
            "2. 发音和读音清晰度 0-50 分：中文声母、韵母、声调、停顿和整体清晰度。若无法从转写判断发音，请不要给满分，应保守评分。",
            "如果转写文本与目标句子高度相似但你无法确认真实发音，只能在发音项给中等偏上分，不能自动满分。",
            "只返回 JSON：{\"completenessScore\":0到50整数,\"pronunciationScore\":0到50整数,\"score\":0到100整数,\"feedback\":\"一到两句中文教师点评\"}",
          ].join("\n"),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "reading_evaluation",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              completenessScore: { type: "integer", minimum: 0, maximum: 50 },
              pronunciationScore: { type: "integer", minimum: 0, maximum: 50 },
              score: { type: "integer", minimum: 0, maximum: 100 },
              feedback: { type: "string" },
            },
            required: ["completenessScore", "pronunciationScore", "score", "feedback"],
          },
          strict: true,
        },
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `OpenAI evaluation failed with ${response.status}`);

  const text = extractResponseText(data);
  const parsed = JSON.parse(text);
  const completenessScore = Math.max(0, Math.min(50, Number(parsed.completenessScore) || 0));
  const pronunciationScore = Math.max(0, Math.min(50, Number(parsed.pronunciationScore) || 0));
  return {
    completenessScore,
    pronunciationScore,
    score: Math.max(0, Math.min(100, Number(parsed.score) || completenessScore + pronunciationScore)),
    feedback: String(parsed.feedback || "").trim(),
  };
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error("OpenAI did not return evaluation text.");
}

async function driveFetch(url, options) {
  const headers = {
    Authorization: `Bearer ${options.token}`,
    ...(options.headers || {}),
  };
  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Drive request failed with ${response.status}`);
  }
  return data;
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const cfg = getDriveConfig();
  if (cachedToken && cachedToken.key === cfg.authKey && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  if (cfg.oauthClientId && cfg.oauthClientSecret && cfg.oauthRefreshToken) {
    return getOAuthAccessToken(cfg, now);
  }

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: cfg.clientEmail,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(cfg.privateKey);
  const assertion = `${header}.${payload}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Could not get Google access token.");

  cachedToken = {
    key: cfg.authKey,
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600),
  };
  return cachedToken.accessToken;
}

async function getOAuthAccessToken(cfg, now) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.oauthClientId,
      client_secret: cfg.oauthClientSecret,
      refresh_token: cfg.oauthRefreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Could not refresh Google OAuth token.");

  cachedToken = {
    key: cfg.authKey,
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600),
  };
  return cachedToken.accessToken;
}

function getDriveConfig() {
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || "";
  let clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";

  if ((!privateKey || !clientEmail) && process.env.GOOGLE_PRIVATE_KEY_FILE) {
    const json = JSON.parse(fs.readFileSync(process.env.GOOGLE_PRIVATE_KEY_FILE, "utf8"));
    privateKey = privateKey || json.private_key || "";
    clientEmail = clientEmail || json.client_email || "";
  }

  return {
    parentFolderId: process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || "",
    clientEmail,
    privateKey: privateKey.replace(/\\n/g, "\n"),
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "",
    authKey: process.env.GOOGLE_OAUTH_REFRESH_TOKEN
      ? `oauth:${process.env.GOOGLE_OAUTH_CLIENT_ID || ""}`
      : `service:${clientEmail}`,
  };
}

function isDriveConfigured() {
  const cfg = getDriveConfig();
  return Boolean(
    cfg.parentFolderId &&
      ((cfg.clientEmail && cfg.privateKey) ||
        (cfg.oauthClientId && cfg.oauthClientSecret && cfg.oauthRefreshToken))
  );
}

function cleanStudentName(name) {
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").replace(/\s+/g, " ").slice(0, 80);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function toUserFacingError(error) {
  const message = error.message || "Server error";
  if (message.includes("Service Accounts do not have storage quota")) {
    return [
      "当前使用的是 Google service account，但目标文件夹在普通个人 Drive 中。",
      "service account 没有自己的存储配额，所以 Google 拒绝上传。",
      "请把目标父文件夹放到 Shared Drive 并给 service account 编辑权限，",
      "或在 .env.local 中改用教师 Google 账号 OAuth 配置上传。",
    ].join("");
  }
  if (message.includes("OpenAI") || message.includes("Incorrect API key")) {
    return `AI 评估失败：${message}`;
  }
  return message;
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) return sendJson(res, 404, { error: "File not found" });
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function applyCors(req, res) {
  const allowedOrigin = normalizeCorsOrigin(process.env.CORS_ORIGIN || "*");
  const requestOrigin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin === "*" ? "*" : allowedOrigin);
  if (allowedOrigin !== "*" && requestOrigin === allowedOrigin) {
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function normalizeCorsOrigin(value) {
  if (!value || value === "*") return "*";
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/$/, "");
  }
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}
