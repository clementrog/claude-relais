.PHONY: check smoke bootstrap-dry

check:
	bash -n scripts/*.sh
	./scripts/install.sh --dry-run --no-preflight
	mkdir -p /tmp/claude-relais-make
	./scripts/bootstrap-project.sh --project-root /tmp/claude-relais-make --dry-run

smoke:
	./scripts/smoke.sh --no-preflight

bootstrap-dry:
	mkdir -p /tmp/claude-relais-make
	./scripts/bootstrap-project.sh --project-root /tmp/claude-relais-make --dry-run
