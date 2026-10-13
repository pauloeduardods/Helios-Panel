# Helios Panel

Extensão do GNOME Shell que mostra na barra superior, ao lado do Wi-Fi e do idioma do teclado:

- a temperatura da **CPU** e da **GPU**, mudando de cor quando esquenta;
- o **perfil de energia** atual (Eco, Quiet, Balanced, Performance, Turbo);
- opcionalmente, a rotação das **ventoinhas**.

O menu mostra os detalhes e permite trocar de perfil. Foi feita para o Acer Predator Helios Neo 16 (PHN16-72), mas funciona em qualquer PC com sensores no `/sys/class/hwmon`, inclusive com CPU Ryzen e GPU Radeon.

```
 [▣ 61°] [▤ off] [◔ Balanced]   ← painel
```

## Requisitos

- GNOME Shell 46 a 50 (Ubuntu 24.04 ou mais novo).
- Para o perfil de energia: o driver `acer_wmi` carregado com `predator_v4=1`.
- Para a temperatura da NVIDIA: o driver proprietário (que traz o `nvidia-smi`).

## Instalar

```bash
./install.sh
```

No Wayland, o GNOME só carrega extensões novas depois de **sair e entrar de novo na sessão**. Depois disso:

```bash
gnome-extensions enable helios-panel@paulo
```

Para configurar, abra o menu da extensão → **Configurações**, ou rode `gnome-extensions prefs helios-panel@paulo`.

Para remover: `./install.sh --uninstall`.

## Como cada coisa é lida

| Item | Fonte | Precisa de root? |
|---|---|---|
| CPU | `coretemp` "Package id 0" (Intel) ou `k10temp` "Tctl" (AMD) | não |
| GPU NVIDIA | `nvidia-smi`, **só se a placa já estiver ligada** | não |
| GPU AMD | hwmon `amdgpu` (prefere a dedicada) | não |
| Ventoinhas | hwmon `acer` (do `acer_wmi`) | não |
| Perfil | `/sys/firmware/acpi/platform_profile` | não para ler |

### A GPU NVIDIA aparece "off"

Isso quer dizer que ela está desligada, economizando bateria (modo on-demand). Ler a temperatura com o `nvidia-smi` acordaria a placa, então a extensão não faz isso. Além disso, ela espaça as leituras para não impedir a placa de voltar a dormir. Se quiser a temperatura sempre, ative **Sensores → Acordar a GPU**, sabendo que isso gasta bateria.

## Trocar de perfil pelo menu

- **Sem configurar nada**, a troca passa pelo `power-profiles-daemon`, o mesmo do "Modo de energia" do Ubuntu. Ele só conhece 3 modos: Economia, Equilibrado e Desempenho (que vira o Turbo).
- **Para ter todos os perfis do firmware no menu**, instale a regra udev opcional em `extras/99-helios-platform-profile.rules`. As instruções e o risco estão no próprio arquivo.

A tecla de modo do teclado continua funcionando nos dois casos.

## Desenvolvimento

```bash
npm test          # testes da lógica (node, sem GNOME)
npm run check     # checagem de sintaxe de todos os módulos

# testar numa sessão aninhada, sem precisar sair da sua sessão:
dbus-run-session gnome-shell --devkit         # GNOME 49+
dbus-run-session gnome-shell --nested --wayland  # GNOME 46-48

# erros da extensão:
journalctl -f -o cat /usr/bin/gnome-shell | grep -i helios
```

A organização do código e o plano para adicionar o controle de iluminação estão em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
