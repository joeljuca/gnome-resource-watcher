UUID = gnome-resource-watcher@joel
SCHEMA = schemas/org.gnome.shell.extensions.resource-watcher.gschema.xml
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

all: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas --strict schemas/

install: all
	mkdir -p $(EXT_DIR)/schemas
	cp extension.js prefs.js stylesheet.css metadata.json $(EXT_DIR)/
	cp $(SCHEMA) $(EXT_DIR)/schemas/
	glib-compile-schemas --strict $(EXT_DIR)/schemas

uninstall:
	rm -rf $(EXT_DIR)

enable: install
	gnome-extensions enable $(UUID)
	@echo "Reload GNOME Shell (log out and in on Wayland) to load the extension."

pack: all
	gnome-extensions pack --force --extra-source=prefs.js \
		--extra-source=schemas .
	@echo "Created $(UUID).shell-extension.zip"

clean:
	rm -f schemas/gschemas.compiled
	rm -f $(UUID).shell-extension.zip

.PHONY: all install uninstall enable pack clean
