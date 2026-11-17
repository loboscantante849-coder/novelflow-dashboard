# Tencent application deployment

The migration keeps the existing authoritative Upstash database, signing keys,
cookie scope and business handlers. Video generation is explicitly disabled by
the runtime. Historical video reads remain available. Database migration is a
separate operation.

The HTTP adapter listens only on 127.0.0.1. Caddy supplies the public HTTPS entry.
`static.json` is an explicit list of public files: never serve the repository as
a static root. Files under `api/_lib`, configuration, data snapshots and source
scripts are not HTTP resources. JSON request bodies are limited to 1 MiB;
multipart streams are passed through to the existing handlers.

`RUNTIME_ENV_FILE` identifies a JSON configuration file outside the release
directory, owned by root and readable only by the application group. The runtime
sets both NODE_ENV and VERCEL_ENV to production to retain existing historical
identity handling. This platform compatibility setting must not be dropped
until the corresponding business rules have been migrated and tested.

## Publishing

The `Release to Tencent` GitHub workflow template is in `runtime/tencent-release.workflow.yml`.
Activation in `.github/workflows` is pending a GitHub credential with workflow permission;
the current CLI credential can publish source but cannot modify workflows. Once activated, it is manually dispatched. It runs the
repository checks, packages tracked source, and sends it through a dedicated SSH
key. The server pins that key to one application and a root-owned
`receive-release.py`; it cannot open a shell, forward ports or deploy the other
application. GitHub stores `TENCENT_DEPLOY_KEY`, `TENCENT_HOST_KEYS` and the
`TENCENT_HOST` variable. Original human SSH credentials are not sent to GitHub.

The receiver validates the archive, installs dependencies as the unprivileged
application user, changes the active release symlink, restarts the service and
checks runtime health. On health failure it restores the previous application
release. This rollback does not replace database contents. Deployments restart
the application and are not a claim of zero-downtime rolling updates.

The initial systemd units use separate 640 MiB MemoryHigh and 800 MiB MemoryMax
limits for dashboard and admin. Node's heap limit is 512 MiB. These are initial
limits to monitor during workload validation, not demonstrated capacity limits.

## Cutover conditions

- Confirm the actual production source revisions and shared financial modules.
- Verify existing sessions, wallet reads, history and disabled generation using
  the original domains and the new origin.
- Configure a valid origin certificate and trusted proxy/IP handling before
  sending public requests to the new origin.
- Preserve one scheduler: existing Vercel crons remain the owner until a
  separately tested handoff. Do not enable a second VIP issuance worker.
- Keep the old deployment available while changing the Cloudflare origin.
- Preserve configuration and media backups; no existing database is replaced.

The public runtime probe `/_runtime/health` contains no credentials. The existing
dashboard `/api/health` additionally checks access to storage. Neither endpoint
certifies financial reconciliation or a completed production migration.
