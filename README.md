# Heed macOS

Personalização do [Heed original](https://github.com/isjunrod/heed), de Junior Rodriguez, sob licença MIT. Oferece transcrição local em português brasileiro e inglês, controles na barra superior e retenção automática de áudio com limite de 2 GB por máquina.

## Instalação

Em um Mac com Apple Silicon, macOS 14 ou posterior, Homebrew e Command Line Tools:

```sh
git clone https://github.com/augustocbx/heed-macos.git
cd heed-macos
bash install-macos.sh
```

Consulte [as instruções completas](README-macos.md), incluindo permissões, uso e atualizações. Cada Mac mantém seus próprios arquivos localmente.

## Atualização

Encerre a gravação e aguarde o salvamento. Depois:

```sh
git pull --ff-only
bash install-macos.sh
```

## Validação

```sh
bun test packages/server/lib
NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run
bun run build
```

A licença original permanece em [LICENSE](LICENSE). A documentação original está em [README-upstream.md](README-upstream.md).
