/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;

const FileUtils = imports.misc.fileUtils;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const Tweener = imports.ui.tweener;
const Util = imports.misc.util;

const MAX_FILE_DELETED_BEFORE_INVALID = 10;

const HISTORY_KEY = 'command-history';
const HISTORY_LIMIT = 512;

const DIALOG_GROW_TIME = 0.1;

function CommandCompleter() {
    this._init();
}

CommandCompleter.prototype = {
    _init : function() {
        this._changedCount = 0;
        this._paths = GLib.getenv('PATH').split(':');
        this._paths.push(GLib.get_home_dir());
        this._valid = false;
        this._updateInProgress = false;
        this._childs = new Array(this._paths.length);
        this._monitors = new Array(this._paths.length);
        for (let i = 0; i < this._paths.length; i++) {
            this._childs[i] = [];
            let file = Gio.file_new_for_path(this._paths[i]);
            let info;
            try {
                info = file.query_info(Gio.FILE_ATTRIBUTE_STANDARD_TYPE, Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                // FIXME catchall
                this._paths[i] = null;
                continue;
            }

            if (info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_STANDARD_TYPE) != Gio.FileType.DIRECTORY)
                continue;

            this._paths[i] = file.get_path();
            this._monitors[i] = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            if (this._monitors[i] != null) {
                this._monitors[i].connect('changed', Lang.bind(this, this._onChanged));
            }
        }
        this._paths = this._paths.filter(function(a) {
            return a != null;
        });
        this._update(0);
    },

    update : function() {
        if (this._valid)
            return;
        this._update(0);
    },

    _update : function(i) {
        if (i == 0 && this._updateInProgress)
            return;
        this._updateInProgress = true;
        this._changedCount = 0;
        this._i = i;
        if (i >= this._paths.length) {
            this._valid = true;
            this._updateInProgress = false;
            return;
        }
        let file = Gio.file_new_for_path(this._paths[i]);
        this._childs[this._i] = [];
        FileUtils.listDirAsync(file, Lang.bind(this, function (files) {
            for (let i = 0; i < files.length; i++) {
                this._childs[this._i].push(files[i].get_name());
            }
            this._update(this._i + 1);
        }));
    },

    _onChanged : function(m, f, of, type) {
        if (!this._valid)
            return;
        let path = f.get_parent().get_path();
        let k = undefined;
        for (let i = 0; i < this._paths.length; i++) {
            if (this._paths[i] == path)
                k = i;
        }
        if (k === undefined) {
            return;
        }
        if (type == Gio.FileMonitorEvent.CREATED) {
            this._childs[k].push(f.get_basename());
        }
        if (type == Gio.FileMonitorEvent.DELETED) {
            this._changedCount++;
            if (this._changedCount > MAX_FILE_DELETED_BEFORE_INVALID) {
                this._valid = false;
            }
            let name = f.get_basename();
            this._childs[k] = this._childs[k].filter(function(e) {
                return e != name;
            });
        }
        if (type == Gio.FileMonitorEvent.UNMOUNTED) {
            this._childs[k] = [];
        }
    },

    getCompletion: function(text) {
        let common = '';
        let notInit = true;
        if (!this._valid) {
            this._update(0);
            return common;
        }
        function _getCommon(s1, s2) {
            let k = 0;
            for (; k < s1.length && k < s2.length; k++) {
                if (s1[k] != s2[k])
                    break;
            }
            if (k == 0)
                return '';
            return s1.substr(0, k);
        }
        function _hasPrefix(s1, prefix) {
            return s1.indexOf(prefix) == 0;
        }
        for (let i = 0; i < this._childs.length; i++) {
            for (let k = 0; k < this._childs[i].length; k++) {
                if (!_hasPrefix(this._childs[i][k], text))
                    continue;
                if (notInit) {
                    common = this._childs[i][k];
                    notInit = false;
                }
                common = _getCommon(common, this._childs[i][k]);
            }
        }
        if (common.length)
            return common.substr(text.length);
        return common;
    }
};

function RunDialog() {
    this._init();
}

RunDialog.prototype = {
__proto__: ModalDialog.ModalDialog.prototype,
    _init : function() {
        ModalDialog.ModalDialog.prototype._init.call(this, { styleClass: 'run-dialog' });

        global.settings.connect('changed::development-tools', Lang.bind(this, function () {
            this._enableInternalCommands = global.settings.get_boolean('development-tools');
        }));
        this._enableInternalCommands = global.settings.get_boolean('development-tools');

        this._history = global.settings.get_strv(HISTORY_KEY);
        this._historyIndex = -1;

        global.settings.connect('changed::' + HISTORY_KEY, Lang.bind(this, function() {
            this._history = global.settings.get_strv(HISTORY_KEY);
            this._historyIndex = this._history.length;
        }));

        this._internalCommands = { 'lg':
                                   Lang.bind(this, function() {
                                       Main.createLookingGlass().open();
                                   }),

                                   'r': Lang.bind(this, function() {
                                       global.reexec_self();
                                   }),

                                   // Developer brain backwards compatibility
                                   'restart': Lang.bind(this, function() {
                                       global.reexec_self();
                                   }),

                                   'debugexit': Lang.bind(this, function() {
                                       Meta.exit(Meta.ExitCode.ERROR);
                                   }),

                                   // rt is short for "reload theme"
                                   'rt': Lang.bind(this, function() {
                                       Main.loadTheme();
                                   })
                                 };


        let label = new St.Label({ style_class: 'run-dialog-label',
                                   text: _("Please enter a command:") });

        this.contentLayout.add(label, { y_align: St.Align.START });

        let entry = new St.Entry({ style_class: 'run-dialog-entry' });

        this._entryText = entry.clutter_text;
        this.contentLayout.add(entry, { y_align: St.Align.START });
        this.connect('opened',
                     Lang.bind(this, function() {
                         this._entryText.grab_key_focus();
                     }));

        this._errorBox = new St.BoxLayout();

        this.contentLayout.add(this._errorBox, { expand: true });

        let errorIcon = new St.Button({ style_class: 'run-dialog-error-icon' });

        this._errorBox.add(errorIcon);

        this._commandError = false;

        this._errorMessage = new St.Label({ style_class: 'run-dialog-error-label' });
        this._errorMessage.clutter_text.line_wrap = true;

        this._errorBox.add(this._errorMessage, { expand: true });

        this._errorBox.hide();

        this._pathCompleter = new Gio.FilenameCompleter();
        this._commandCompleter = new CommandCompleter();
        this._group.connect('notify::visible', Lang.bind(this._commandCompleter, this._commandCompleter.update));
        this._entryText.connect('key-press-event', Lang.bind(this, function(o, e) {
            let symbol = e.get_key_symbol();
            if (symbol == Clutter.Down) {
                this._setCommandFromHistory(this._historyIndex++);
                return true;
            }
            if (symbol == Clutter.Up) {
                this._setCommandFromHistory(this._historyIndex--);
                return true;
            }
            if (symbol == Clutter.Return || symbol == Clutter.KP_Enter) {
                if (Shell.get_event_state(e) & Clutter.ModifierType.CONTROL_MASK)
                    this._run(o.get_text(), true);
                else
                    this._run(o.get_text(), false);
                if (!this._commandError)
                    this.close(global.get_current_time());
            }
            if (symbol == Clutter.Escape) {
                this.close(global.get_current_time());
                return true;
            }
            if (symbol == Clutter.slash) {
                // Need preload data before get completion. GFilenameCompleter load content of parent directory.
                // Parent directory for /usr/include/ is /usr/. So need to add fake name('a').
                let text = o.get_text().concat('/a');
                let prefix;
                if (text.lastIndexOf(' ') == -1)
                    prefix = text;
                else
                    prefix = text.substr(text.lastIndexOf(' ') + 1);
                this._getCompletion(prefix);
                return false;
            }
            if (symbol == Clutter.Tab) {
                let text = o.get_text();
                let prefix;
                if (text.lastIndexOf(' ') == -1)
                    prefix = text;
                else
                    prefix = text.substr(text.lastIndexOf(' ') + 1);
                let postfix = this._getCompletion(prefix);
                if (postfix != null && postfix.length > 0) {
                    o.insert_text(postfix, -1);
                    o.set_cursor_position(text.length + postfix.length);
                    if (postfix[postfix.length - 1] == '/')
                        this._getCompletion(text + postfix + 'a');
                }
                return true;
            }
            return false;
        }));
    },

    _getCompletion : function(text) {
        if (text.indexOf('/') != -1) {
            return this._pathCompleter.get_completion_suffix(text);
        } else {
            return this._commandCompleter.getCompletion(text);
        }
    },

    _saveHistory : function() {
        if (this._history.length > HISTORY_LIMIT) {
            this._history.splice(0, this._history.length - HISTORY_LIMIT);
        }
        global.settings.set_strv(HISTORY_KEY, this._history);
    },

    _run : function(input, inTerminal) {
        let command = input;

        if (this._history.length == 0 ||
            this._history[this._history.length - 1] != input) {
            this._history.push(input);
            this._saveHistory();
        }

        this._commandError = false;
        let f;
        if (this._enableInternalCommands)
            f = this._internalCommands[input];
        else
            f = null;
        if (f) {
            f();
        } else if (input) {
            try {
                if (inTerminal)
                    command = 'gnome-terminal -x ' + input;
                Util.trySpawnCommandLine(command);
            } catch (e) {
                // Mmmh, that failed - see if @input matches an existing file
                let path = null;
                if (input.charAt(0) == '/') {
                    path = input;
                } else {
                    if (input.charAt(0) == '~')
                        input = input.slice(1);
                    path = GLib.get_home_dir() + '/' + input;
                }

                if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                    let file = Gio.file_new_for_path(path);
                    Gio.app_info_launch_default_for_uri(file.get_uri(),
                                                        global.create_app_launch_context());
                } else {
                    this._commandError = true;

                    let errorStr = _("Execution of '%s' failed:").format(command) + '\n' + e.message;
                    this._errorMessage.set_text(errorStr);

                    if (!this._errorBox.visible) {
                        let [errorBoxMinHeight, errorBoxNaturalHeight] = this._errorBox.get_preferred_height(-1);

                        let parentActor = this._errorBox.get_parent();
                        Tweener.addTween(parentActor,
                                         { height: parentActor.height + errorBoxNaturalHeight,
                                           time: DIALOG_GROW_TIME,
                                           transition: 'easeOutQuad',
                                           onComplete: Lang.bind(this,
                                               function() {
                                                    parentActor.set_height(-1);
                                                    this._errorBox.show();
                                               })
                                         });
                    }
                }
            }
        }
    },

    _setCommandFromHistory: function(lastI) {
        if (this._historyIndex < 0)
            this._historyIndex = 0;
        if (this._historyIndex > this._history.length)
            this._historyIndex = this._history.length;

        let text = this._entryText.get_text();
        if (text) {
            this._history[lastI] = text;
        }
        if (this._history[this._historyIndex]) {
            this._entryText.set_text(this._history[this._historyIndex]);
        } else
            this._entryText.set_text('');
    },

    open: function() {
        this._historyIndex = this._history.length;
        this._errorBox.hide();
        this._entryText.set_text('');
        this._commandError = false;

        ModalDialog.ModalDialog.prototype.open.call(this);
    },

};
Signals.addSignalMethods(RunDialog.prototype);
