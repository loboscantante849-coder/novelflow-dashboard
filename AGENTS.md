# NovelFlow Engineering Rules

- Do not use Coze, Coze CLI, Coze workflows, or Coze-hosted storage in this repository.
- Develop in this GitHub repository and deploy through Vercel.
- The social console uses Vercel Functions, isolated Upstash Redis keys under `nf_social:*`, DeepSeek for copy and prompts, the authorized AC API for video, and the authorized Laoye API for images.
- Facebook publishing remains manual. The pipeline may only prepare a review package.
- Persist paid-provider task IDs before polling and never automatically retry an ambiguous paid submission.
- Read credentials only from environment variables. Never write them into source, logs, commits, or chat output.
