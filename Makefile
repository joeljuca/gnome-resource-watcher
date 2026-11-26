UUID = gnome-resource-watcher@joel
SCHEMA = schemas/org.gnome.shell.extensions.resource-watcher.gschema.xml
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all
all: schemas/gschemas.compiled

.PHONY: test
test: schemas/gschemas.compiled
	gjs -m tests/run.js

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas --strict schemas/

.PHONY: install
install: all
	mkdir -p $(EXT_DIR)/schemas
	cp extension.js lib.js prefs.js stylesheet.css metadata.json $(EXT_DIR)/
	cp $(SCHEMA) $(EXT_DIR)/schemas/
	glib-compile-schemas --strict $(EXT_DIR)/schemas

.PHONY: uninstall
uninstall:
	rm -rf $(EXT_DIR)

.PHONY: enable
enable: install
	gnome-extensions enable $(UUID)
	@echo "Reload GNOME Shell (log out and in on Wayland) to load the extension."

.PHONY: pack
pack: all
	gnome-extensions pack --force --extra-source=prefs.js \
		--extra-source=lib.js --extra-source=schemas .
	@echo "Created $(UUID).shell-extension.zip"

.PHONY: clean
clean:
	rm -f schemas/gschemas.compiled
	rm -f $(UUID).shell-extension.zip
