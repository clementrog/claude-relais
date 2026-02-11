# Contributing

Thanks for improving `claude-relais`.

## Local checks

```bash
bash -n scripts/*.sh
./scripts/install.sh --dry-run --no-preflight
./scripts/bootstrap-project.sh --project-root /tmp/claude-relais-dev --dry-run
```

## Contribution rules

- Keep orchestration contracts deterministic.
- Keep public docs copy-paste runnable.
- Do not reintroduce legacy Envoi branding.
- Prefer small focused PRs.
