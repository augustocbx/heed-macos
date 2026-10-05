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

O aplicativo fica em `~/Applications/Heed.app` e inicia com o login pelo LaunchAgent `local.heed.menubar`. O ícone oferece iniciar, parar, escolher o idioma e abrir [a interface](http://localhost:5170). Mantenha a aba da interface aberta durante a gravação e o salvamento; ela pode ficar minimizada.

O menu **Gravar automaticamente reuniões do Slack** vem habilitado: novas reuniões/huddles no aplicativo Slack instalado iniciam a gravação após alguns segundos, com o idioma selecionado. O Heed abre a interface se necessário e aguarda sua conexão. Pare pelo menu do Heed; sair do Slack não encerra a captura. Uma parada manual não reinicia a mesma reunião. O monitor acompanha novos estados nos registros locais, sem guardar mensagens; não inicia reuniões anteriores à abertura do Heed. Slack no navegador, Google Meet, Teams e Zoom não têm início automático. O estado aparece no menu e o diagnóstico em `~/Library/Logs/Heed/slack-auto.log`. Mudanças nos registros internos do Slack podem exigir atualização do detector.

Se aparecer o seletor de autorização, escolha a pasta **logs** do Slack e clique em **Autorizar registros**. O menu **Autorizar registros do Slack…** permite repetir. Essa autorização é limitada à pasta; acesso total ao disco não é necessário. Confira **Slack: aguardando próxima reunião** e então entre em uma nova reunião para testar. A autorização precisa ser feita em cada Mac.

Em Ajustes do Sistema → Privacidade e Segurança, autorize **Gravação de Tela e Áudio do Sistema** e **Microfone** para o componente solicitado pelo macOS. Se o pedido não aparecer, consulte essas telas manualmente. O capturador de áudio do sistema fica em `packages/transcription/native/heed-parakeet/.build/release/heed-syscap`. As permissões são concedidas individualmente em cada Mac. A captura do sistema funciona independentemente do uso de fones de ouvido.

Use **Configurações** na interface ou **Configurações e permissões…** no menu para consultar as autorizações deste Mac e abrir os Ajustes correspondentes. A tela também informa se o aplicativo nativo está desconectado. Depois de uma atualização, pode ser necessário desligar e ligar novamente a permissão de gravação do Heed, mesmo quando ela aparece habilitada, e aceitar o reinício solicitado pelo macOS.

Os áudios ficam localmente em `recordings/`. A política de retenção limita o total a 2 GB, remove primeiro os áudios das reuniões mais antigas e preserva suas transcrições. Uma gravação que atingir o limite individual é encerrada e salva. O limite de áudio e a transcrição nos dois idiomas devem ser usados igualmente em ambos os Macs.

Os serviços atendem somente na máquina local: interface na porta 5170, API na 5001, transcrição na 5002 e Ollama na 11434. Logs ficam em `~/Library/Logs/Heed/`. Para verificar instalação e modelos:

```sh
bun run doctor
```

O limite é de 2.000.000.000 bytes por máquina. O Heed reserva espaço para as cópias temporárias de processamento; uma gravação contínua muito longa pode ser encerrada antes de atingir 2 GB sozinha. O limite de saída por gravação é de aproximadamente 990 MB, para que os dois canais possam ser processados dentro do orçamento.

## Ouvir uma reunião com transcrição sincronizada

Abra **Sessions**, escolha a reunião e use o player de áudio acima da transcrição. O trecho correspondente ao tempo do áudio fica destacado e visível durante a reprodução. Clique em um trecho (ou use Enter/Espaço) para ouvir a partir dele. Falas simultâneas podem ficar destacadas juntas. A sincronização é por trecho, usando os timestamps da transcrição, não palavra por palavra.

O player usa a duração real do arquivo de áudio, que pode diferir do tempo indicado pelo cronômetro da captura. Não é aplicado ajuste artificial nos timestamps. Se o áudio tiver sido excluído pela retenção de 2 GB, a transcrição permanece disponível e a tela informa que o áudio não está mais disponível.
