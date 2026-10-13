import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {listTemperatureSensors, NVIDIA_SMI_ID} from './lib/sys/sensors.js';
import {readProfileState, writableProfilePath} from './lib/core/index.js';
import {sysfs} from './lib/sys/sysfs.js';

export default class HeliosPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.add(this._panelPage(settings));
        window.add(this._temperaturePage(settings));
        window.add(this._sensorPage(settings));
    }

    // ------------------------------------------------------------ pages

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Painel', icon_name: 'video-display-symbolic'});

        const show = new Adw.PreferencesGroup({title: 'O que mostrar na barra'});
        show.add(switchRow(settings, 'show-cpu', 'Temperatura da CPU'));
        show.add(switchRow(settings, 'show-gpu', 'Temperatura da GPU'));
        show.add(switchRow(settings, 'hide-gpu-when-off', 'Esconder a GPU quando desligada',
            'Senão mostra "off" esmaecido'));
        show.add(switchRow(settings, 'show-fans', 'Rotação das ventoinhas'));
        show.add(switchRow(settings, 'show-profile', 'Perfil de energia'));
        show.add(switchRow(settings, 'show-icons', 'Ícones'));
        show.add(switchRow(settings, 'show-unit', 'Mostrar "°C"', 'Desligado mostra só "°"'));
        page.add(show);

        const profile = new Adw.PreferencesGroup({title: 'Perfil'});
        profile.add(comboRow(settings, 'profile-names', 'Nomes dos perfis', [
            ['predator', 'PredatorSense (Quiet, Balanced, Turbo…)'],
            ['portuguese', 'Português (Silencioso, Equilibrado…)'],
            ['linux', 'Linux (quiet, balanced, performance…)'],
        ]));
        profile.add(switchRow(settings, 'color-profile', 'Colorir conforme a potência',
            'Azul na economia, laranja no Performance, vermelho no Turbo'));
        page.add(profile);

        const place = new Adw.PreferencesGroup({title: 'Posição e atualização'});
        place.add(comboRow(settings, 'panel-position', 'Área da barra', [
            ['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita (perto do Wi-Fi)'],
        ]));
        place.add(spinRow(settings, 'panel-index', 'Ordem dentro da área', '0 = mais à esquerda', 0, 20));
        place.add(spinRow(settings, 'refresh-interval', 'Atualizar a cada (segundos)', null, 1, 60));
        page.add(place);
        return page;
    }

    _temperaturePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Cores', icon_name: 'applications-graphics-symbolic'});

        const cpu = new Adw.PreferencesGroup({title: 'Limites da CPU (°C)'});
        cpu.add(spinRow(settings, 'cpu-warm', 'Morna a partir de', null, 30, 110));
        cpu.add(spinRow(settings, 'cpu-hot', 'Quente a partir de', null, 30, 110));
        page.add(cpu);

        const gpu = new Adw.PreferencesGroup({title: 'Limites da GPU (°C)'});
        gpu.add(spinRow(settings, 'gpu-warm', 'Morna a partir de', null, 30, 110));
        gpu.add(spinRow(settings, 'gpu-hot', 'Quente a partir de', null, 30, 110));
        page.add(gpu);

        const colors = new Adw.PreferencesGroup({title: 'Cores'});
        colors.add(colorRow(settings, 'color-normal', 'Normal', 'Vazio = cor do tema'));
        colors.add(colorRow(settings, 'color-warm', 'Morno', null));
        colors.add(colorRow(settings, 'color-hot', 'Quente', null));
        colors.add(switchRow(settings, 'bold-when-hot', 'Negrito quando quente'));
        page.add(colors);
        return page;
    }

    _sensorPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Sensores', icon_name: 'utilities-system-monitor-symbolic'});
        const sensors = listTemperatureSensors();
        const sensorOptions = sensors.map(s => [s.id, `${s.chip} / ${s.label}`]);

        const pick = new Adw.PreferencesGroup({
            title: 'Fonte das leituras',
            description: 'Automático escolhe o pacote da CPU (coretemp/k10temp) e a GPU dedicada.',
        });
        pick.add(comboRow(settings, 'cpu-sensor', 'Sensor da CPU',
            [['', 'Automático'], ...sensorOptions]));
        pick.add(comboRow(settings, 'gpu-sensor', 'Sensor da GPU',
            [['', 'Automático'], [NVIDIA_SMI_ID, 'NVIDIA (nvidia-smi)'], ...sensorOptions]));
        page.add(pick);

        const nvidia = new Adw.PreferencesGroup({
            title: 'GPU NVIDIA',
            description: 'Cada leitura do nvidia-smi liga a placa se ela estiver em repouso. ' +
                'Com a opção abaixo desligada, o painel mostra "off" e deixa ela dormir.',
        });
        nvidia.add(switchRow(settings, 'allow-wake-dgpu', 'Acordar a GPU para ler a temperatura',
            'Gasta bateria: a placa nunca desliga'));
        nvidia.add(spinRow(settings, 'gpu-min-interval', 'Intervalo mínimo entre leituras (s)',
            'Maior que o tempo de repouso da placa, para não mantê-la acordada', 2, 120));
        page.add(nvidia);

        const diag = new Adw.PreferencesGroup({title: 'Diagnóstico'});
        const state = readProfileState(sysfs);
        diag.add(infoRow('Perfil de energia', state.available
            ? `${state.current} (driver: ${state.driver ?? 'acpi'})`
            : 'indisponível — o acer_wmi está carregado?'));
        diag.add(infoRow('Perfis do firmware', state.choices.join(', ') || '—'));
        diag.add(infoRow('Troca de perfil pelo menu', writableProfilePath(sysfs)
            ? 'direta (todos os perfis)'
            : 'via power-profiles-daemon (3 perfis)'));
        diag.add(infoRow('Sensores de temperatura', `${sensors.length} encontrados`));
        page.add(diag);
        return page;
    }
}

// ------------------------------------------------------------ row helpers

function switchRow(settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title});
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    if (subtitle)
        row.subtitle = subtitle;
    row.value = settings.get_int(key);
    row.connect('notify::value', () => settings.set_int(key, Math.round(row.value)));
    return row;
}

/** options: [value, label][] for a string key. Unknown stored values are kept. */
function comboRow(settings, key, title, options) {
    const current = settings.get_string(key);
    if (!options.some(([value]) => value === current))
        options = [...options, [current, `${current} (não encontrado)`]];
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
        selected: options.findIndex(([value]) => value === current),
    });
    row.connect('notify::selected', () => {
        const option = options[row.selected];
        if (option)
            settings.set_string(key, option[0]);
    });
    return row;
}

function colorRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title});
    if (subtitle)
        row.subtitle = subtitle;

    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const rgba = new Gdk.RGBA();
    if (rgba.parse(settings.get_string(key) || '#ffffff'))
        button.rgba = rgba;
    button.connect('notify::rgba', () => settings.set_string(key, button.rgba.to_string()));
    row.add_suffix(button);

    const reset = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        tooltip_text: 'Restaurar o padrão',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);
    return row;
}

function infoRow(title, value) {
    const row = new Adw.ActionRow({title, subtitle: value});
    row.add_css_class('property');
    return row;
}
