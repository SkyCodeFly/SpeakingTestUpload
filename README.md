# Chinese Speaking Test Upload

本项目是一个本地 Node Web 应用，学生填写姓名和邮箱后录制 10 道中文朗读题，音频会上传到 Google Drive 指定文件夹下的学生子文件夹。

## 运行

1. 复制 `.env.example` 为 `.env.local`。
2. 填写 Google Drive 配置：
   - `GOOGLE_DRIVE_PARENT_FOLDER_ID`
   - Shared Drive 方案：`GOOGLE_SERVICE_ACCOUNT_EMAIL` 和 `GOOGLE_PRIVATE_KEY`
   - 普通个人 My Drive 方案：`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`GOOGLE_OAUTH_REFRESH_TOKEN`
3. 如果使用 service account，把 Google Drive 的目标父文件夹分享给 service account 邮箱，并给编辑权限。
   - 注意：service account 不能使用普通个人 My Drive 的存储配额。目标父文件夹应放在 Google Shared Drive 里，或改用教师账号 OAuth 授权。
4. 如果需要 AI 评估，填写 `OPENAI_API_KEY`。
4. 启动：

```bash
npm run dev
```

默认打开 `http://localhost:3000`。

## GitHub Pages

GitHub Pages 只能发布前端静态页面，Google Drive 和 OpenAI API 必须继续放在后端服务里。发布步骤见 `GITHUB_PAGES.md`。

## 上传结构

```text
Google Drive parent folder
└── 学生姓名
    ├── Q1.webm
    ├── Q2.webm
    └── ...
```

每段录音会按题号命名为 `Q1.webm` 到 `Q10.webm`。
如果学生文件夹里已经有同名录音，服务端会先删除旧文件，再上传新文件。
