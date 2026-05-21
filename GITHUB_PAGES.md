# Publish the Frontend to GitHub Pages

GitHub Pages can publish the student-facing page, but it cannot run the backend or safely store API keys. Keep Google Drive and OpenAI keys only on the backend server.

## 1. Deploy the Backend First

Deploy this project's `server.js` to a Node host such as Render, Railway, Fly.io, or your own server.

Set these environment variables on the backend host:

```env
PORT=3000
CORS_ORIGIN=https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY_NAME
GOOGLE_DRIVE_PARENT_FOLDER_ID=...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REFRESH_TOKEN=...
OPENAI_API_KEY=...
```

After deployment, test:

```text
https://YOUR_BACKEND_DOMAIN/api/config
```

It should return:

```json
{"driveConfigured":true,"aiConfigured":true}
```

## 2. Point the Static Page at the Backend

Edit `public/config.js`:

```js
window.APP_CONFIG = {
  API_BASE_URL: "https://YOUR_BACKEND_DOMAIN"
};
```

Do not put API keys in `public/config.js`.

## 3. Publish with GitHub Pages

Create a GitHub repository and upload the project.

In GitHub:

1. Go to `Settings`.
2. Go to `Pages`.
3. Under `Build and deployment`, choose `GitHub Actions`.
4. Push to the `main` branch.
5. GitHub will run `.github/workflows/pages.yml` and publish the `public` folder.

GitHub will publish the page at:

```text
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY_NAME/
```

## 4. Local Testing

Local development still works:

```bash
npm run dev
```

Open:

```text
http://localhost:3100
```
