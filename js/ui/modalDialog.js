/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;

const Params = imports.misc.params;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

const OPEN_AND_CLOSE_TIME = 0.1;
const FADE_OUT_DIALOG_TIME = 1.0;

const State = {
    OPENED: 0,
    CLOSED: 1,
    OPENING: 2,
    CLOSING: 3,
    FADED_OUT: 4
};

function ModalDialog() {
    this._init();
}

ModalDialog.prototype = {
    _init: function(params) {
        params = Params.parse(params, { styleClass: null });

        this.state = State.CLOSED;

        this._group = new St.Group({ visible: false,
                                     x: 0,
                                     y: 0 });
        Main.uiGroup.add_actor(this._group);
        global.focus_manager.add_group(this._group);
        this._initialKeyFocus = this._group;

        this._group.connect('destroy', Lang.bind(this, this._onGroupDestroy));

        this._actionKeys = {};
        this._group.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));

        this._lightbox = new Lightbox.Lightbox(this._group,
                                               { inhibitEvents: true });

        this._backgroundBin = new St.Bin();

        this._group.add_actor(this._backgroundBin);
        this._lightbox.highlight(this._backgroundBin);

        this._dialogLayout = new St.BoxLayout({ style_class: 'modal-dialog',
                                                vertical:    true });
        if (params.styleClass != null) {
            this._dialogLayout.add_style_class_name(params.styleClass);
        }
        this._backgroundBin.child = this._dialogLayout;

        this.contentLayout = new St.BoxLayout({ vertical: true });
        this._dialogLayout.add(this.contentLayout,
                               { x_fill:  true,
                                 y_fill:  true,
                                 x_align: St.Align.MIDDLE,
                                 y_align: St.Align.START });

        this._buttonLayout = new St.BoxLayout({ opacity:  220,
                                                vertical: false });
        this._dialogLayout.add(this._buttonLayout,
                               { expand:  true,
                                 x_align: St.Align.MIDDLE,
                                 y_align: St.Align.END });
    },

    setButtons: function(buttons) {
        this._buttonLayout.remove_all();
        let i = 0;
        for (let index in buttons) {
            let buttonInfo = buttons[index];
            let label = buttonInfo['label'];
            let action = buttonInfo['action'];
            let key = buttonInfo['key'];

            let button = new St.Button({ style_class: 'modal-dialog-button',
                                         reactive:    true,
                                         can_focus:   true,
                                         label:       label });

            let x_alignment;
            if (buttons.length == 1)
                x_alignment = St.Align.END;
            else if (i == 0)
                x_alignment = St.Align.START;
            else if (i == buttons.length - 1)
                x_alignment = St.Align.END;
            else
                x_alignment = St.Align.MIDDLE;

            this._initialKeyFocus = button;
            this._buttonLayout.add(button,
                                   { expand: true,
                                     x_fill: false,
                                     y_fill: false,
                                     x_align: x_alignment,
                                     y_align: St.Align.MIDDLE });

            button.connect('clicked', action);

            if (key)
                this._actionKeys[key] = action;
            i++;
        }
    },

    _onKeyPressEvent: function(object, keyPressEvent) {
        let symbol = keyPressEvent.get_key_symbol();
        let action = this._actionKeys[symbol];

        if (action)
            action();
    },

    _onGroupDestroy: function() {
        this.emit('destroy');
    },

    _fadeOpen: function() {
        let monitor = global.get_focus_monitor();

        this._backgroundBin.set_position(monitor.x, monitor.y);
        this._backgroundBin.set_size(monitor.width, monitor.height);

        this.state = State.OPENING;

        this._dialogLayout.opacity = 255;
        this._lightbox.show();
        this._group.opacity = 0;
        this._group.show();
        Tweener.addTween(this._group,
                         { opacity: 255,
                           time: OPEN_AND_CLOSE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this._initialKeyFocus.grab_key_focus();
                                   this.state = State.OPENED;
                                   this.emit('opened');
                               }),
                         });
    },

    open: function(timestamp) {
        if (this.state == State.OPENED || this.state == State.OPENING)
            return true;

        if (!Main.pushModal(this._group, timestamp))
            return false;

        global.stage.set_key_focus(this._group);

        this._fadeOpen();
        return true;
    },

    close: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING)
            return;

        let needsPopModal;

        if (this.state == State.OPENED || this.state == State.OPENING)
            needsPopModal = true;
        else
            needsPopModal = false;

        this.state = State.CLOSING;

        Tweener.addTween(this._group,
                         { opacity: 0,
                           time: OPEN_AND_CLOSE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this.state = State.CLOSED;
                                   this._group.hide();

                                   if (needsPopModal)
                                       Main.popModal(this._group, timestamp);
                               })
                         });
    },

    // This method is like close, but fades the dialog out much slower,
    // and leaves the lightbox in place. Once in the faded out state,
    // the dialog can be brought back by an open call, or the lightbox
    // can be dismissed by a close call.
    //
    // The main point of this method is to give some indication to the user
    // that the dialog reponse has been acknowledged but will take a few
    // moments before being processed.
    // e.g., if a user clicked "Log Out" then the dialog should go away
    // imediately, but the lightbox should remain until the logout is
    // complete.
    _fadeOutDialog: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING)
            return;

        if (this.state == State.FADED_OUT)
            return;

        Tweener.addTween(this._dialogLayout,
                         { opacity: 0,
                           time:    FADE_OUT_DIALOG_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this.state = State.FADED_OUT;
                                   Main.popModal(this._group, timestamp);
                               })
                         });
    }
};
Signals.addSignalMethods(ModalDialog.prototype);
