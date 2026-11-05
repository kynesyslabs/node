Alertmanager reads each receiver URL from a file here (gitignored, `chmod 644` so the Alertmanager container can read them; keep this directory readable by the monitoring host's operators only). Each file holds one URL, alone on one line:

| File | Receiver | Placeholder to replace |
|------|----------|------------------------|
| `slack_webhook` | `slack` (warnings, info, and a copy of every critical and page) | `<SLACK_WEBHOOK_URL_PLACEHOLDER>` |
| `pager_webhook` | `paging` (critical, page; these also go to `slack`) | `<PAGER_WEBHOOK_URL_PLACEHOLDER>` |
| `deadman_webhook` | `deadman` (always-firing heartbeat) | `<DEADMAN_WEBHOOK_URL_PLACEHOLDER>` |
