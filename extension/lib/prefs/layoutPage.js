// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Layout: the segments of the top bar, their templates, icons and
// graphs, a live preview, presets, and import/export of the layout as JSON.
// All the rules live in lib/layout.js; this file only edits `panel-layout`.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {HeliosClient} from '../client.js';
import {paintBars, paintPieces} from '../draw.js';
import {
    GRAPH_READINGS, ICONS, MAX_SEGMENTS, PLACEHOLDERS, PRESETS, READINGS, addItem, addSegment,
    effectiveTemplate, exportLayout, loadLayout, moveItemTo, moveSegment, parseLayout, parseTemplate,
    presetLayout, readOptions, readStyle, readingInfo, removeItem, removeSegment, renderLayout,
    sampleHistory, sampleSnapshot, segmentMarkup, serializeLayout, setSegment, setTemplate,
} from '../layout.js';
import {barPieces, parseColor, sparklinePieces} from '../model.js';

const PREVIEW_CSS = `
.helios-preview {
    background-color: #1e1e1e;
    color: #ffffff;
    border-radius: 9px;
    padding: 6px 14px;
    font-weight: bold;
}
.helios-preview-empty { color: alpha(#ffffff, 0.5); font-weight: normal; }
`;

/** The largest layout file import reads. */
const MAX_IMPORT_BYTES = 64 * 1024;

const ICON_CHOICES = [['auto', 'Automatic (first reading)'], ['none', 'None'],
    ...ICONS.map(id => [id, id === 'cpu' || id === 'gpu' ? id.toUpperCase() : id[0].toUpperCase() + id.slice(1)])];
const KIND_CHOICES = [['line', 'Line'], ['area', 'Filled area'], ['bars', 'Bars']];
const WIDTH_CHOICES = [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']];
const WINDOW_CHOICES = [[60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']];

let cssLoaded = false;
function loadCss() {
    if (cssLoaded)
        return;
    const provider = new Gtk.CssProvider();
    if (provider.load_from_string)
        provider.load_from_string(PREVIEW_CSS);
    else
        provider.load_from_data(PREVIEW_CSS, -1);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    cssLoaded = true;
}

function flatButton(icon, tooltip, onClick, sensitive = true) {
    const button = new Gtk.Button({
        icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat'], sensitive,
    });
    button.connect('clicked', onClick);
    return button;
}

/** A combo row over [value, label] options that calls `onPick(value)`. */
function choiceRow(title, options, current, onPick) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(([, label]) => label))});
    const index = options.findIndex(([value]) => value === current);
    row.selected = index < 0 ? 0 : index;
    row.connect('notify::selected', () => {
        const option = options[row.selected];
        if (option && option[0] !== current)
            onPick(option[0]);
    });
    return row;
}

function isDismissed(e) {
    return e instanceof GLib.Error &&
        (e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
         e.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED));
}

function jsonFilters() {
    const filter = new Gtk.FileFilter({name: 'Layout files (JSON)'});
    filter.add_pattern('*.json');
    filter.add_mime_type('application/json');
    const store = new Gio.ListStore({item_type: Gtk.FileFilter});
    store.append(filter);
    return {store, filter};
}

export class LayoutPage {
    /**
     * @param {Gio.Settings} settings
     * @param {Adw.PreferencesWindow} window for dialogs and toasts
     * @param {string} extensionPath where the icons are
     */
    constructor(settings, window, extensionPath) {
        loadCss();
        this._settings = settings;
        this._window = window;
        this._path = extensionPath;
        this._expanded = new Set();
        this._rebuildId = 0;
        this._draft = null;

        const {layout, migrated} = loadLayout(settings);
        this._layout = layout;
        this._written = migrated ?? settings.get_string('panel-layout');
        if (migrated !== null)
            settings.set_string('panel-layout', migrated);

        this.page = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-grid-symbolic'});
        this.page.add(this._previewGroup());
        this.page.add(this._segmentsGroup());
        this.page.add(this._presetGroup());
        this.page.add(this._backupGroup());
        this._segmentRows = [];
        this._buildSegments();

        this._changedId = settings.connect('changed', (_s, key) => {
            if (key === 'panel-layout') {
                if (settings.get_string(key) === this._written)
                    return;
                this._written = settings.get_string(key);
                this._layout = loadLayout(settings).layout;
                this._scheduleRebuild();
            }
            this._updatePreview();
        });

        // Live values for the preview; sample values while heliosd is away.
        this._client = new HeliosClient(() => this._updatePreview());
        window.connect('close-request', () => {
            this.destroy();
            return false;
        });
        this._updatePreview();
    }

    destroy() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._client?.destroy();
        this._client = null;
    }

    // ------------------------------------------------------------ state

    /** Stores a new layout; Settings rebuilds its rows unless `rebuild` is false. */
    _write(next, {rebuild = true} = {}) {
        this._layout = next;
        this._draft = null;
        this._written = serializeLayout(next);
        this._settings.set_string('panel-layout', this._written);
        if (rebuild)
            this._scheduleRebuild();
        this._updatePreview();
    }

    /** Applies `next` and offers to undo it. */
    _writeWithUndo(next, message) {
        const previous = this._layout;
        this._expanded.clear();
        this._write(next);
        this._toast(message, () => this._write(previous));
    }

    _toast(title, undo = null) {
        const toast = new Adw.Toast({title, timeout: 5});
        if (undo) {
            toast.button_label = 'Undo';
            toast.connect('button-clicked', undo);
        }
        this._window.add_toast?.(toast);
    }

    /** Rebuilds after the current signal handler returns (never from inside a widget's own signal). */
    _scheduleRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._buildSegments();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------ preview

    _previewGroup() {
        const group = new Adw.PreferencesGroup({title: 'Preview'});
        this._previewSource = new Gtk.Label({css_classes: ['dim-label', 'caption'], xalign: 0});
        group.set_header_suffix(this._previewSource);
        this._preview = new Gtk.Box({
            spacing: 10, halign: Gtk.Align.CENTER, css_classes: ['helios-preview'], margin_bottom: 6,
        });
        group.add(this._preview);
        return group;
    }

    /** What the preview draws: heliosd's values and history, or samples. */
    _data() {
        const snap = this._client?.snapshot();
        if (snap?.state === 'running')
            return {snap, history: this._client.historyView(), live: true};
        this._sample ??= {snap: sampleSnapshot(), history: sampleHistory(), live: false};
        return this._sample;
    }

    _updatePreview() {
        if (!this._preview)
            return;
        const {snap, history, live} = this._data();
        this._previewSource.label = live ? 'Live values from heliosd' : 'Sample values (heliosd is not running)';
        const layout = this._draft ?? this._layout;
        const options = readOptions(this._settings);
        const style = readStyle(this._settings);
        const rendered = renderLayout(layout, snap, options);

        let child;
        while ((child = this._preview.get_first_child()))
            this._preview.remove(child);
        let shown = 0;
        for (const r of rendered) {
            if (!r.visible)
                continue;
            shown++;
            const box = new Gtk.Box({spacing: 3, opacity: r.dim ? 0.5 : 1});
            if (r.icon) {
                box.append(new Gtk.Image({
                    gicon: Gio.icon_new_for_string(`${this._path}/icons/${r.icon}-symbolic.svg`), pixel_size: 14,
                }));
            }
            if (r.showText) {
                const label = new Gtk.Label();
                label.set_markup(segmentMarkup(r, style));
                box.append(label);
            }
            if (r.graph)
                box.append(this._graphArea(r.graph, history, style));
            this._preview.append(box);
        }
        if (shown === 0) {
            this._preview.append(new Gtk.Label({
                label: 'Nothing to show', css_classes: ['helios-preview-empty'],
            }));
        }
        this._updateTitles(rendered);
    }

    _graphArea(spec, history, style) {
        const area = new Gtk.DrawingArea({content_width: spec.width, content_height: 16, valign: Gtk.Align.CENTER});
        const fixed = spec.color === 'follow' ? null : parseColor(spec.color);
        const rgbOf = level => fixed ??
            parseColor({hot: style.hot, warm: style.warm}[level] ?? style.normal) ?? [1, 1, 1];
        area.set_draw_func((_area, cr, width, height) => {
            const options = {windowS: spec.window, levelOf: spec.levelOf};
            if (spec.kind === 'bars')
                paintBars(cr, barPieces(history, spec.series, width, height, options), rgbOf);
            else
                paintPieces(cr, height, sparklinePieces(history, spec.series, width, height, options), rgbOf,
                    {fill: spec.kind === 'area'});
            cr.$dispose();
        });
        return area;
    }

    // ------------------------------------------------------------ segments

    _segmentsGroup() {
        this._segmentGroup = new Adw.PreferencesGroup({
            title: 'Segments',
            description: 'Left to right in the top bar. Each segment has one icon, one text and ' +
                'optionally a graph. Move a reading into the next segment to merge them.',
        });
        this._addSegmentButton = flatButton('list-add-symbolic', 'Add a segment',
            () => this._write(addSegment(this._layout)));
        this._segmentGroup.set_header_suffix(this._addSegmentButton);
        return this._segmentGroup;
    }

    /** (Re)creates one expander row per segment. */
    _buildSegments() {
        for (const row of this._segmentRows)
            this._segmentGroup.remove(row);
        this._draft = null;
        const layout = this._layout;
        const count = layout.segments.length;
        this._addSegmentButton.sensitive = count < MAX_SEGMENTS;
        this._expanders = layout.segments.map((seg, i) => this._segmentRow(seg, i, count));
        this._segmentRows = [...this._expanders];
        if (count === 0) {
            this._segmentRows.push(new Adw.ActionRow({
                title: 'The top bar is empty',
                subtitle: 'Add a segment, or pick a preset below',
            }));
        }
        for (const row of this._segmentRows)
            this._segmentGroup.add(row);
        this._updatePreview();
    }

    _updateTitles(rendered) {
        for (const [i, row] of (this._expanders ?? []).entries()) {
            const r = rendered[i];
            if (!r)
                continue;
            const text = r.text || '(empty)';
            row.title = r.showText || !r.graph ? text : `${text} (graph only)`;
        }
    }

    _segmentRow(seg, index, count) {
        const row = new Adw.ExpanderRow({
            use_markup: false,
            subtitle: seg.items.map(id => readingInfo(id).label).join(' + ') || 'Text only',
            expanded: this._expanded.has(index),
        });
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(index);
            else
                this._expanded.delete(index);
        });
        const swapExpanded = delta => {
            const a = this._expanded.has(index);
            const b = this._expanded.has(index + delta);
            this._expanded.delete(index);
            this._expanded.delete(index + delta);
            if (a)
                this._expanded.add(index + delta);
            if (b)
                this._expanded.add(index);
        };
        // An expander row puts each new suffix before the previous ones.
        row.add_suffix(flatButton('user-trash-symbolic', 'Remove this segment', () => {
            this._expanded.clear();
            this._writeWithUndo(removeSegment(this._layout, index), 'Segment removed');
        }));
        row.add_suffix(flatButton('go-down-symbolic', 'Move right', () => {
            swapExpanded(1);
            this._write(moveSegment(this._layout, index, 1));
        }, index < count - 1));
        row.add_suffix(flatButton('go-up-symbolic', 'Move left', () => {
            swapExpanded(-1);
            this._write(moveSegment(this._layout, index, -1));
        }, index > 0));

        for (const id of seg.items)
            row.add_row(this._itemRow(seg, index, count, id));
        row.add_row(this._addItemRow(seg, index));
        for (const r of this._templateRows(seg, index))
            row.add_row(r);
        row.add_row(choiceRow('Icon', ICON_CHOICES, seg.icon,
            icon => this._write(setSegment(this._layout, index, {icon}))));
        for (const r of this._graphRows(seg, index))
            row.add_row(r);
        return row;
    }

    _itemRow(seg, index, count, id) {
        const row = new Adw.ActionRow({title: readingInfo(id).label, subtitle: `{${id}}`, use_markup: false});
        const move = to => {
            this._expanded.add(to === 'new' ? index + 1 : to);
            this._write(moveItemTo(this._layout, index, id, to));
        };
        row.add_suffix(flatButton('go-previous-symbolic', 'Move into the segment on the left',
            () => move(index - 1), index > 0));
        row.add_suffix(flatButton('go-next-symbolic', 'Move into the segment on the right',
            () => move(index + 1), index < count - 1));
        row.add_suffix(flatButton('edit-cut-symbolic', 'Move into a segment of its own',
            () => move('new'), seg.items.length > 1));
        row.add_suffix(flatButton('list-remove-symbolic', 'Remove from this segment',
            () => this._write(removeItem(this._layout, index, id))));
        return row;
    }

    _addItemRow(seg, index) {
        const missing = READINGS.filter(r => !seg.items.includes(r.id));
        const options = [['', 'Choose…'], ...missing.map(r => [r.id, r.label])];
        return choiceRow('Add a reading', options, '',
            id => this._write(addItem(this._layout, index, id)));
    }

    _templateRows(seg, index) {
        const entry = new Adw.EntryRow({
            title: 'Template (empty: the readings joined by " · ")',
            text: seg.template,
            show_apply_button: true,
        });
        const help = new Adw.ActionRow({
            title: 'Placeholders',
            subtitle_selectable: true,
            use_markup: false,
            css_classes: ['property'],
        });
        const placeholderHelp = `${PLACEHOLDERS.map(p => `{${p}}`).join(' ')}. ` +
            'Add :1 for one decimal, e.g. {cpu:1}. Press Enter to apply.';
        const validate = () => {
            const {errors} = parseTemplate(entry.text);
            if (errors.length) {
                entry.add_css_class('error');
                help.title = 'Shown as "--" until fixed';
                help.subtitle = errors.join('; ');
            } else {
                entry.remove_css_class('error');
                help.title = entry.text ? 'Placeholders' : `Now: ${effectiveTemplate(seg)}`;
                help.subtitle = placeholderHelp;
            }
        };
        entry.connect('changed', () => {
            validate();
            // Preview the draft while typing; it is stored on Enter.
            this._draft = setTemplate(this._layout, index, entry.text);
            this._updatePreview();
        });
        entry.connect('apply', () => this._write(setTemplate(this._layout, index, entry.text)));
        validate();
        return [entry, help];
    }

    _graphRows(seg, index) {
        const g = seg.graph;
        const set = patch => this._write(setSegment(this._layout, index, {graph: patch}));
        const options = [['', 'None'], ...GRAPH_READINGS.map(id => [id, readingInfo(id).label])];
        const rows = [choiceRow('Graph', options, g?.reading ?? '',
            reading => set(reading ? {reading} : null))];
        if (!g)
            return rows;

        rows.push(choiceRow('Graph style', KIND_CHOICES, g.kind, kind => set({kind})));
        const only = new Adw.SwitchRow({title: 'Graph only', subtitle: 'Hide the text', active: g.only});
        only.connect('notify::active', () => set({only: only.active}));
        rows.push(only);
        rows.push(choiceRow('Graph width', WIDTH_CHOICES, g.width, width => set({width})));
        rows.push(choiceRow('Time span', WINDOW_CHOICES, g.window, window => set({window})));

        const fixed = g.color !== 'follow';
        rows.push(choiceRow('Graph color', [['follow', 'Temperature colors'], ['fixed', 'One fixed color']],
            fixed ? 'fixed' : 'follow', mode => set({color: mode === 'fixed' ? '#62a0ea' : 'follow'})));
        if (fixed) {
            const colorRow = new Adw.ActionRow({title: 'Fixed color'});
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER,
            });
            const rgba = new Gdk.RGBA();
            if (rgba.parse(g.color))
                button.rgba = rgba;
            button.connect('notify::rgba', () => this._write(
                setSegment(this._layout, index, {graph: {color: button.rgba.to_string()}}), {rebuild: false}));
            colorRow.add_suffix(button);
            rows.push(colorRow);
        }
        return rows;
    }

    // ------------------------------------------------------------ presets and backup

    _presetGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Presets',
            description: 'Replace the layout with a ready-made one. Colors and thresholds are kept.',
        });
        for (const preset of PRESETS) {
            const row = new Adw.ActionRow({title: preset.label, subtitle: preset.description});
            const button = new Gtk.Button({label: 'Use', valign: Gtk.Align.CENTER});
            button.connect('clicked', () =>
                this._writeWithUndo(presetLayout(preset.id), `${preset.label} layout applied`));
            row.add_suffix(button);
            row.activatable_widget = button;
            group.add(row);
        }
        return group;
    }

    _backupGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Backup and sharing',
            description: 'The layout as a JSON file: segments, templates, icons and graphs.',
        });
        const exportRow = new Adw.ActionRow({title: 'Export the layout…'});
        const exportButton = flatButton('document-save-symbolic', 'Export', () => this._export());
        exportRow.add_suffix(exportButton);
        exportRow.activatable_widget = exportButton;
        group.add(exportRow);

        const importRow = new Adw.ActionRow({title: 'Import a layout…', subtitle: 'Replaces the current layout'});
        const importButton = flatButton('document-open-symbolic', 'Import', () => this._import());
        importRow.add_suffix(importButton);
        importRow.activatable_widget = importButton;
        group.add(importRow);
        return group;
    }

    _export() {
        const {store, filter} = jsonFilters();
        const dialog = new Gtk.FileDialog({
            title: 'Export the layout', initial_name: 'helios-panel-layout.json', filters: store, default_filter: filter,
        });
        dialog.save(this._window, null, (_d, result) => {
            let file;
            try {
                file = dialog.save_finish(result);
            } catch (e) {
                if (!isDismissed(e))
                    this._toast(`Could not export: ${e.message}`);
                return;
            }
            try {
                file.replace_contents(new TextEncoder().encode(exportLayout(this._layout)), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._toast(`Layout exported to ${file.get_basename()}`);
            } catch (e) {
                this._toast(`Could not export: ${e.message}`);
            }
        });
    }

    _import() {
        const {store, filter} = jsonFilters();
        const dialog = new Gtk.FileDialog({title: 'Import a layout', filters: store, default_filter: filter});
        dialog.open(this._window, null, (_d, result) => {
            let text;
            try {
                const file = dialog.open_finish(result);
                const [, bytes] = file.load_contents(null);
                if (bytes.length > MAX_IMPORT_BYTES) {
                    this._toast('That file is too large to be a layout');
                    return;
                }
                text = new TextDecoder().decode(bytes);
            } catch (e) {
                if (!isDismissed(e))
                    this._toast(`Could not import: ${e.message}`);
                return;
            }
            const {ok, layout, errors} = parseLayout(text);
            if (!ok) {
                this._toast(`Not a Helios Panel layout: ${errors[0]}`);
                return;
            }
            this._writeWithUndo(layout, errors.length
                ? `Layout imported; ${errors.length} template mistake(s) show as "--"`
                : 'Layout imported');
        });
    }
}
