# Heed on macOS

Local installation for Apple Silicon Macs running macOS 14 or later. Transcription supports Brazilian Portuguese (`pt`) and English (`en`), detected automatically after recording. The interface and menu support English, Brazilian Portuguese, French, and German, with English as the fallback. Installation instructions remain in English.

## Install or update

Install [Homebrew](https://brew.sh) and Apple's Command Line Tools first. If the tools are missing, run:

```sh
xcode-select --install
```

Clone the repository and run the installer from the checkout:

```sh
git clone https://github.com/augustocbx/heed-macos.git
cd heed-macos
bash install-macos.sh
```

The installer installs FFmpeg, Python, Node.js, and Ollama through Homebrew, Bun when needed, Python dependencies, Swift transcription and capture executables, the interface, and the menu app. The first health check can download transcription models and take several minutes. Optional AI notes models are not downloaded automatically. Do not run the installer with `sudo`.

To update, stop recording and wait for processing and saving to finish, then run:

```sh
git pull --ff-only
bash install-macos.sh
```

Recordings in `recordings/` and settings in `~/.heed-app/` are preserved. Do not copy these folders between machines to install the app. The installer refuses to restart active recordings or processing. If you move the checkout, run the installer again to update the project path used by the menu app.

## Use

The app is installed at `~/Applications/Heed.app` and starts at login through the `local.heed.menubar` LaunchAgent. The menu lets you start, stop, and open [the interface](http://localhost:5170). Keep the interface tab open during recording and saving; it can be minimized.

**Automatically record Slack meetings** is enabled by default. New meetings/huddles in the installed Slack app start recording after a few seconds, with an English live preview. Heed opens the interface if needed and waits for it to connect. A confirmed meeting end stops capture automatically; you can also stop through Heed's menu. A manual stop does not restart the same meeting. The monitor follows new local log states without storing messages, and does not start meetings that were already active when Heed opened. Slack in a browser, Google Meet, Teams, and Zoom do not have automatic start. The menu shows detector status, and diagnostics are written to `~/Library/Logs/Heed/slack-auto.log`. Slack log format changes may require detector updates.

If an authorization picker appears, select the exact Slack **logs** folder and click **Allow log access**. **Allow Slack log access…** in the menu lets you repeat this. Authorization is read-only and limited to that folder; Full Disk Access is not required. Check for **Slack: waiting for the next meeting**, then join a new meeting to test. Authorize each Mac separately.

In **System Settings → Privacy & Security**, allow **Screen & System Audio Recording** and **Microphone** for the component requested by macOS. If no prompt appears, check these settings manually. The capture executable is `packages/transcription/native/heed-parakeet/.build/release/heed-syscap`. Permissions must be granted separately on each Mac. System audio capture works with headphones.

Use **Settings** in the interface or **Settings and permissions…** in the menu to check this Mac's permissions and open their System Settings sections. The page also reports when the native app is disconnected. After an update, you may need to turn Heed's recording permission off and on again even when it appears enabled, then accept the restart requested by macOS.

Audio is stored locally in `recordings/`. The retention quota is **2,000,000,000 bytes per machine**. Oldest audio is removed first; transcripts are preserved. Space is reserved for temporary processing copies, so one continuous recording has an output limit of approximately **990 MB**. Reaching that limit stops and saves it. Models and dependencies are outside this quota. Each installation uses the same retention and bilingual transcription features, with independent local files.

The interface uses port **5170**, API **5001**, transcription **5002**, and Ollama **11434**, all on the local machine. Logs are stored in `~/Library/Logs/Heed/`. Check installation and models with:

```sh
bun run doctor
```

## Playback synchronized with the transcript

Abra **Meetings** (ou **Reuniões**, na interface em português), escolha uma reunião e pressione Play no reprodutor acima da transcrição. O trecho correspondente é destacado e mantido visível. Clique em um trecho, ou use Enter/Espaço, para reproduzir daquele ponto. Falas sobrepostas podem destacar vários trechos. A sincronização segue os tempos dos trechos, sem precisão por palavra.

The player uses the audio file's actual duration, which may differ from the recording timer. It does not artificially rescale timestamps. If audio has expired under the 2 GB retention policy, the transcript remains available and the interface reports that the audio is unavailable.

See [README.md](README.md) for the native capture architecture, storage paths, troubleshooting, and limitations.

### Live preview and final transcript

Cada gravação começa com uma prévia em inglês usando um modelo menor e janelas limitadas para reduzir o processamento e a memória. A prévia é provisória. Ao parar, o Heed detecta inglês ou português em amostras do áudio salvo e sempre retranscreve a gravação inteira com o modelo final de maior precisão. A reunião salva usa o idioma detectado e os tempos do áudio completo, preservando nomes atribuídos manualmente quando a correspondência é inequívoca. Se a etapa final falhar, o áudio continua disponível para recuperação; a recuperação também detecta o idioma e processa o áudio completo, em vez de salvar a prévia.

Para retranscrever uma reunião salva, abra **Meetings / Reuniões**, escolha a reunião e clique em **Transcribe / Transcrever**. Selecione **Parakeet v3** (padrão), **Whisper base**, **small**, **medium** ou **large-v3**, e detecção automática de inglês/português, inglês ou português (Brasil). O modelo selecionado é baixado localmente no primeiro uso quando necessário. Modelos maiores exigem mais memória e tempo. O Heed mostra o progresso e bloqueia novas gravações durante a transcrição; substitui a transcrição somente após salvar o resultado completo, preservando o áudio original e os nomes com correspondência inequívoca, e corrigindo a duração a partir do áudio completo quando disponível. Se a transcrição ou o salvamento falhar, a reunião anterior continua disponível.

Os cartões e detalhes mostram o idioma da reunião e os modelos de transcrição ao vivo e final registrados. Reuniões antigas sem esses metadados não exibem um modelo presumido. A transcrição manual atualiza o modelo final e mantém o modelo ao vivo original.

## Interface language

Choose **Interface language** in Settings or in the menu bar to switch between English, Portuguese (Brazil), French, and German. The preference is stored on each Mac and shared between its menu and open interface tabs. Unsupported locales and untranslated strings fall back to English. This setting affects app labels, not recorded speech: live transcription still starts in English, and the final pass detects English or Portuguese. Installation documentation and technical logs remain in English.
