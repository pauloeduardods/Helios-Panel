# Arquitetura

O código tem uma regra central: **a interface só desenha**. Quem fala com o hardware fica em camadas separadas, para dar para adicionar recursos novos (como a iluminação) sem mexer no painel.

```
extension/
├── extension.js            ciclo de vida: cria/remove o indicador e o posiciona
├── prefs.js                janela de configurações (libadwaita)
├── schemas/                configurações (GSettings)
├── icons/                  ícones simbólicos do painel
└── lib/
    ├── core/               LÓGICA PURA - sem nenhum import do GNOME
    │   ├── format.js         níveis de temperatura, formatação, intervalo da GPU
    │   ├── profiles.js       nomes dos perfis, cores, mapeamento para o PPD
    │   ├── hwmon.js          descoberta de sensores em /sys/class/hwmon
    │   └── platformProfile.js leitura do perfil e decisão de como trocá-lo
    ├── sys/                ACESSO AO SISTEMA (GLib/Gio)
    │   ├── sysfs.js          adaptador de arquivos usado pelo core
    │   ├── sensors.js        CpuSensor, GpuSensor, FanSensor
    │   └── nvidia.js         nvidia-smi sem acordar a placa
    ├── backends/           RECURSOS DO NOTEBOOK
    │   ├── platform.js       perfil de energia (sysfs direto ou power-profiles-daemon)
    │   └── lighting.js       ponto de extensão da iluminação (ainda vazio)
    └── ui/
        └── indicator.js      botão do painel e menu
```

## Por que o `core/` é puro

Os módulos do `core/` recebem o sistema de arquivos como parâmetro (`fs = {readText, listDir, exists, isWritable}`). No GNOME, esse parâmetro é o `sysfs.js`. Nos testes, é uma árvore falsa em memória que imita um PHN16-72 ou um desktop AMD. Assim, a lógica que decide qual sensor usar roda no `npm test`, sem precisar de GNOME nem do notebook.

O `tests/system.test.js` vai um passo além: troca `gi://GLib` e `gi://Gio` por stubs e testa o código de `sys/` contra uma pasta `/sys` falsa. É isso que garante que a NVIDIA suspensa nunca é acordada.

## Regras para código que roda dentro do gnome-shell

- **Nada que bloqueie.** Ler arquivos do sysfs é instantâneo e pode ser síncrono. Processos (como o `nvidia-smi`) e chamadas D-Bus precisam ser assíncronos, com timeout.
- **Nada de root.** A extensão roda dentro do processo da sua sessão gráfica. Tudo que precisa de privilégio vai para um helper separado (veja abaixo).
- **Limpar tudo no `disable()`:** timers, sinais, processos. O indicador faz isso em `_onDestroy`.

## Adicionando a iluminação (futuro)

No PHN16-72, o RGB do teclado e o logo da tampa passam pela interface WMI de gaming da Acer. O modelo não tem o chip ENEK5130 nem o teclado USB da Sunrex, então o caminho direto por `/dev/hidraw` não existe. Escrever nessa interface exige root. Por isso o caminho tem três partes:

```
indicador ──D-Bus──▶ helper privilegiado ──▶ WMI/ACPI ou módulo de kernel
(lighting.js)        (serviço de sistema
                      + regra polkit)
```

### 1. Descobrir o protocolo

Antes de abrir um disassembler, olhe o que já existe:
- O `facer.c` do projeto [predator-sense](https://github.com/cleyton1986/predator-sense) já implementa o teclado em 4 zonas por WMI (`ACER_CAP_GAMINGKB`, devices `/dev/acer-gkbbl*`). Está marcado como testado no PHN16-72. Ele é GPL-3: se copiar código, a extensão também precisa ser GPL-3.
- Mesmo método, o Linuwu-Sense.

Para o que faltar (por exemplo, o logo da tampa):
- **Dinâmico (mais fácil):** no Windows, com o PredatorSense aberto, capture as chamadas WMI (rastreamento ETW "WMI-Activity" no Visualizador de Eventos) enquanto muda cores. Você vê o método e os bytes enviados.
- **Estático:** abra as DLLs de iluminação do PredatorSense no Ghidra, direto ou via REA, e procure os GUIDs WMI da Acer (`7A4DDFE7-…`) e os números de método. As tabelas ACPI (`acpidump` + `iasl -d`) mostram o que o firmware aceita.
- Teste sempre começando por **leitura**, e uma escrita por vez.

### 2. O helper privilegiado

Um serviço de sistema pequeno (Python ou Rust) no D-Bus de sistema, com:
- uma lista **fechada** de ações (`SetKeyboard(zones, effect, brightness)`, `SetLogo(...)`), com todos os valores validados;
- uma ação polkit própria. Para iluminação, `allow_active=yes` é aceitável, porque o pior caso é uma cor errada. Para ventoinhas, EC ou chave MUX, use `auth_admin`.
- **nada** de escrita genérica ("escreva X no caminho Y") nem acesso cru ao EC. Foram os pontos fracos do predator-sense.

### 3. O backend na extensão

Crie `lib/backends/acerWmiGaming.js` estendendo `LightingBackend`:
- `probe()`: o helper está no D-Bus e o modelo é suportado?
- `capabilities()`: alvos, zonas, efeitos.
- `apply(state)`: chama o helper.

Registre a classe no array `BACKENDS` em `lighting.js`. O indicador já chama `detectLightingBackend()` e cria a seção "Iluminação" no menu quando um backend responde. A partir daí, é só trocar o placeholder em `_updateLightingSection()` por controles de verdade.
