.PHONY: install validate pack upload list download help

help:
	@echo "Targets:"
	@echo "  install               — install npm dependencies"
	@echo "  validate [DIR=...]    — validate skill(s) locally (default: all skills/)"
	@echo "  pack    [DIR=...]     — validate + create dist/*.skill archives"
	@echo "  upload  [DIR=...]     — validate + pack + upload to claude.ai"
	@echo "                         DRY_RUN=1 to preview without uploading"
	@echo "  list                  — list skills currently on claude.ai"
	@echo "  download [DIR=...]    — download user skills from claude.ai to skills/"
	@echo "                         OVERWRITE=1 to replace existing local dirs"

install:
	npm install

validate:
	node src/cli.js validate $(DIR)

pack:
	node src/cli.js pack $(DIR)

upload:
	node src/cli.js upload $(DIR) $(if $(DRY_RUN),--dry-run,)

list:
	node src/cli.js list

download:
	node src/cli.js download $(DIR) $(if $(OVERWRITE),--overwrite,)
