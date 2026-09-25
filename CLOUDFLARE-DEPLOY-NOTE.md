# Cloudflare deployment note

This archive preserves the original Telegram bot architecture and data model.

Important: the bot uses Telegraf polling, Firebase Admin SDK, in-memory admin workflow state, and node-cron. Cloudflare Workers can run Express with Node compatibility, but this exact runtime architecture cannot be safely deployed to Workers Free unchanged. A full Workers migration would require webhook handling, a Workers-compatible Firestore access layer, persistent workflow state, and Cron/Queue/Workflow scheduling.

Do NOT delete/reset Firebase collections. Keep the existing Firebase project and Telegram file_ids.

The current bot logic for auto-delete, scheduled/recurring posts, posting-channel buttons, repost history, admin panel, and other features is intentionally preserved in `bot.js`.

Emoji safety: Telegram-facing free-text truncation now uses the existing Unicode-safe `safeTruncate()` helper at the remaining unsafe text truncation points, preventing lone UTF-16 surrogates from being produced when titles/captions/button names contain emoji.
