MINT ?= mint
NPM ?= npm
SWIFTLINT ?= $(MINT) run SwiftLint
SWIFTFORMAT ?= $(MINT) run SwiftFormat
PERIPHERY ?= $(MINT) run periphery
DANGER_ARGS ?= local --base main
DANGER_JS_VERSION ?= 14.1.0
PERIPHERY_BUILD_PATH ?= .build/periphery

.PHONY: bootstrap lint format format-check unused danger quality

bootstrap:
	$(MINT) bootstrap
	swift build --package-path Tools/Danger --product DangerDeps

lint:
	$(SWIFTLINT) lint

format:
	$(SWIFTFORMAT) Package.swift Dangerfile.swift Sources Tests Tools/Danger/Package.swift Tools/Danger/Sources

format-check:
	$(SWIFTFORMAT) --lint Package.swift Dangerfile.swift Sources Tests Tools/Danger/Package.swift Tools/Danger/Sources

unused:
	@test "$$(uname -s)" = "Darwin" || { \
		echo "Periphery cannot build this Apple-framework package on Linux; run make unused on macOS."; \
		exit 2; \
	}
	@swift build --scratch-path "$(PERIPHERY_BUILD_PATH)" --build-tests
	@index_store="$$(find "$(PERIPHERY_BUILD_PATH)" -type d -path '*/index/store' -print -quit)"; \
	if test -z "$$index_store" && test -d "$(PERIPHERY_BUILD_PATH)/out"; then \
		index_store="$(PERIPHERY_BUILD_PATH)/out"; \
	fi; \
	test -n "$$index_store" || { echo "Unable to locate the Swift index store."; exit 2; }; \
	$(PERIPHERY) scan --skip-build --index-store-path "$$index_store"

danger:
	cd Tools/Danger && $(NPM) exec --yes --package=danger@$(DANGER_JS_VERSION) -- \
		swift run danger-swift $(DANGER_ARGS) --dangerfile "$(CURDIR)/Dangerfile.swift"

quality: format-check lint
