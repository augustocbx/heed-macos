# Controle do Heed na barra superior

Execute `bash packages/desktop/install-menubar.sh` para instalar o aplicativo em `~/Applications/Heed.app`. O LaunchAgent `local.heed.menubar` inicia o ícone no login, sem iniciar gravações.

O menu permite escolher português ou inglês, iniciar, parar e abrir `http://localhost:5170`. Mantenha a interface aberta durante a gravação e o salvamento. O ícone fica vermelho quando o servidor informa captura ativa.

A instalação registra o caminho do projeto em `Contents/Resources/heed-root.txt`, permitindo outros usuários e diretórios. Modelos opcionais de notas por IA são escolhidos na interface.

Consulte [a documentação de instalação](../../../README-macos.md).
