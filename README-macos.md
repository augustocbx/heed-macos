# Heed no macOS

Instalação local para Macs com Apple Silicon e macOS 14 ou posterior. A transcrição suporta português brasileiro (`pt`) e inglês (`en`), selecionados no menu do ícone.

## Instalar ou atualizar

Instale previamente [Homebrew](https://brew.sh) e as ferramentas da Apple:

```sh
xcode-select --install
```

Com este checkout em qualquer diretório do usuário, execute:

```sh
bash install-macos.sh
```

O instalador instala FFmpeg, Python e Ollama pelo Homebrew, Bun quando necessário, dependências Python, os executáveis Swift de transcrição e captura, a interface e o aplicativo do menu. A primeira verificação pode baixar modelos de transcrição e levar alguns minutos. Modelos opcionais para notas por IA não são baixados automaticamente. O instalador não executa `sudo`.

Execute novamente para atualizar dependências e reinstalar o aplicativo após atualizar o código. Gravações em `recordings/` e configurações em `~/.heed-app/` são preservadas. Não copie esses diretórios entre máquinas para instalar o programa. Atualizações não devem ser executadas durante uma gravação ou seu processamento; encerre a reunião e aguarde o salvamento antes de atualizar. Se mover o checkout, execute o instalador novamente para atualizar o caminho usado pelo ícone.

## Usar

O aplicativo fica em `~/Applications/Heed.app` e inicia com o login pelo LaunchAgent `local.heed.menubar`. O ícone oferece iniciar, parar, escolher o idioma e abrir [a interface](http://localhost:5170). Mantenha a aba da interface aberta durante a gravação e o salvamento; ela pode ficar minimizada. Não inicia gravações automaticamente.

Em Ajustes do Sistema → Privacidade e Segurança, autorize **Gravação de Tela e Áudio do Sistema** e **Microfone** para o componente solicitado pelo macOS. Se o pedido não aparecer, consulte essas telas manualmente. O capturador de áudio do sistema fica em `packages/transcription/native/heed-parakeet/.build/release/heed-syscap`. As permissões são concedidas individualmente em cada Mac. A captura do sistema funciona independentemente do uso de fones de ouvido.

Os áudios ficam localmente em `recordings/`. A política de retenção limita o total a 2 GB, remove primeiro os áudios das reuniões mais antigas e preserva suas transcrições. Uma gravação que atingir o limite individual é encerrada e salva. O limite de áudio e a transcrição nos dois idiomas devem ser usados igualmente em ambos os Macs.

Os serviços atendem somente na máquina local: interface na porta 5170, API na 5001, transcrição na 5002 e Ollama na 11434. Logs ficam em `~/Library/Logs/Heed/`. Para verificar instalação e modelos:

```sh
bun run doctor
```

O limite é de 2.000.000.000 bytes por máquina. O Heed reserva espaço para as cópias temporárias de processamento; uma gravação contínua muito longa pode ser encerrada antes de atingir 2 GB sozinha. O limite de saída por gravação é de aproximadamente 990 MB, para que os dois canais possam ser processados dentro do orçamento.
