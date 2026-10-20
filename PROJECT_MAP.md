# PROJECT_MAP — Whatfast (Tauri desktop)

Estado actual del repositorio. Solo datos verificados con un comando; no lleva
fechas. La bitácora de cambios vive en `PROJECT_MEMORY.md`.

## Qué es

Cliente de escritorio de WhatsApp. El webview SolidJS dibuja, el núcleo Rust
de Tauri hace de frontera tipada, y un sidecar Go (whatsmeow) es el único
dueño de la conexión, la historia, los medios y las bases de datos.

El proyecto se llama **Whatfast**. Repositorio: `github.com/Owning01/whatfast`.
La marca vive en el `productName` de `tauri.conf.json`, el paquete npm
`whatfast-tauri`, el crate `whatfast-tauri`, el binario `whatfast`, el sidecar
`whatfast-backend` y el paquete Go `github.com/Owning01/whatfast/backend`.

```
SolidJS 1.9 + TanStack Solid Virtual 3.13  (webview)
        invoke tipado + Channel de eventos ordenados
Tauri Rust core 2.11  (tauri/src-tauri/src/lib.rs)
        protobuf v21, framing 4 bytes BE + longitud, máximo 8 MiB
Go sidecar 1.25 (backend/)
        session.db + client.db + caché de medios acotada
```

## Capas y archivos que importan

| Ruta | Rol |
| --- | --- |
| `proto/bridge.proto` | Contrato de RPC. 50 peticiones, 51 respuestas, `PROTOCOL_VERSION = 21`, paquete `whatfast.bridge.v1`. Sin `service`: es un `oneof` por mensaje. |
| `backend/cmd/whatfast-backend/` | Entry point del sidecar Go. |
| `backend/internal/app/server.go` | Dispatcher Go de los 50 RPC, `wireChat`/`wireMessage`, `ProtocolVersion = 21`. |
| `backend/internal/store/store.go` | SQLite: `chats` (muted_until, archived, pinned, blocked), `messages`, `chat_addresses`, FTS. |
| `backend/internal/wa/client.go` | Puente con whatsmeow: envío/recepción, descarga de medios, reducción de mensajes, caché de medios (512 MiB) y de avatares (128 MiB). |
| `backend/internal/linkpreview/` | Resolvedor de previews de enlaces (OpenGraph) para los mensajes que traen una URL. |
| `tauri/src-tauri/src/lib.rs` | 70 comandos Tauri: los 50 RPC más los locales (staging, edición de imagen, aperturas, notificaciones). |
| `tauri/src-tauri/src/bridge.rs` | Cliente de transporte + backend fake en proceso. Copia byte a byte de `desktop/src/bridge.rs`. |
| `tauri/src/lib/bridge.ts` | Fachada TS de los comandos. `invoke` con nombres de comando; los errores son `BridgeError`. |
| `tauri/src/state/app.ts` | Store central (Solid store) y todas las acciones. Rollback optimista en archive/mute/block/pin. |
| `tauri/src/components/` | UI: `Sidebar`, `Conversation`, `MessageBubble`, `Composer`, `Panels`, `Screens`, `MediaEditor`, `StatusStrip`, `NewsletterPanel`. |
| `tauri/src/lib/media-crop.ts` | Geometría pura del editor de imagen (recorte, rotación, escala). Sin DOM. |
| `tauri/tests/` | 24 suites `node --test`. 153 tests. |
| `tauri/src-tauri/icons/` | Set de íconos de la app, generado con `tauri icon` desde el logo de Whatfast. |
| `desktop/` | Cliente GPUI legacy. Referencia de comportamiento. Comparte `bridge.rs`, `paths.rs`, `sticker.rs`. |

## Flujos que hay que conocer antes de tocar nada

- **Medios salientes:** el usuario elige un archivo → el núcleo Rust lo valida y
  lo copia a `<data>/staged-outgoing/<uuid>/<nombre>` → solo esa ruta
  viaja al backend. `send_image` y `send_attachment` rechazan cualquier ruta
  fuera de los cachés del núcleo (`staged-outgoing`, `pasted-images`,
  `voice-notes`).
- **Editor de imagen:** `stage_outgoing_media` + `edit_image` (comando Rust,
  crate `image`). El recorte se expresa en los píxeles de la imagen YA
  rotada; la rotación es horaria (0/90/180/270). `tauri/src/lib/media-crop.ts`
  y el Rust usan la misma convención.
- **Link preview:** el backend resuelve el OpenGraph de la primera URL del
  mensaje y lo guarda en `link_preview_*`; el frontend lo pinta con
  `LinkPreviewCard`.
- **Ajustes de chat:** archivar/mutar/bloquear son RPC nuevos (`set_chat_archive`,
  `set_chat_mute`, `set_chat_block`). El transporte no expone app-state de
  WhatsApp, así que el estado vive en el perfil del escritorio. Un mute
  indefinido se guarda como instante lejano (`253402300799000`).
- **Protocolo:** el shell y el sidecar deben recompilarse juntos. Cambiar
  `proto/bridge.proto` obliga a subir `PROTOCOL_VERSION` en
  `tauri/src-tauri/src/bridge.rs`, `desktop/src/bridge.rs` y
  `backend/internal/app/server.go`, y a regenerar `backend/gen/bridgev1/bridge.pb.go`.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `make dev-fake` | Levanta la app con el backend fake en proceso (10 000 chats). No pide cuenta. |
| `make dev` | Levanta la app contra el sidecar Go real. |
| `make check` | `go test` + `go vet` + `tsc --noEmit` + `cargo clippy -D warnings`. |
| `make test` | `go test` + `pnpm test` + `pnpm build` + `cargo test`. |
| `make build` | Bundle Tauri sin empaquetar. |

Variables: `WHATFAST_BACKEND` (ruta del sidecar), `WHATFAST_DATA_DIR`
(perfil aislado), `WHATFAST_FAKE_PAIRING` (pairing fake).

## Trampas del entorno de esta máquina

- El toolchain de Go de `G:\Dev\GoLang` tiene el GOROOT incompleto (falta
  `src/go/build`). Compilar con `$env:GOTOOLCHAIN="go1.25.0"`.
- MSVC sí está instalado (`G:\Dev\MSVC`), pero `link.exe` no está en el PATH
  por defecto. Cargar `C:\Users\tu_usuario\AppData\Local\Temp\opencode\msvc.ps1`.
- `.cargo/config.toml` fija `rustc-wrapper = "sccache"` y sccache no está
  instalado. Compilar con `--config "build.rustc-wrapper=''"`.
- `tauri/node_modules` está roto (instalación interrumpida). `pnpm check`,
  `pnpm test` y `pnpm build` funcionan en una copia limpia con `src` y
  `tests` como junction al repo.
- **El volumen G: no permite borrar ni renombrar archivos que ya existían.**
  Crear y editar sí funciona; borrar y `Move-Item` dan "Acceso denegado"
  incluso como administrador. Por eso el entrypoint anterior del sidecar Go
  quedó como stub con `//go:build ignore` en vez de eliminarse, y quedó
  fuera del repo con `git rm --cached` + `.git/info/exclude`.
  Tampoco se puede escribir el índice de git: los commits se hacen en una
  copia de trabajo en C: y se replican acá moviendo el ref a mano.
- El binario de test de la librería Rust (`cargo test`) no arranca en esta
  máquina: sale con `0xC0000139` antes de `main`. El binario de la app sí
  arranca. `cargo check` y `cargo clippy` funcionan.

## Alcance pendiente documentado

- Llamadas VoIP: `whatsmeow` no trae señalización. La app avisa en vez de
  fingir la llamada.
- Scheduled send, message info, disappearing timer editable e historial de
  edición: requieren RPC nuevos; no están en el protocolo.
- Crop de imagen existe solo en el cliente (recorte libre y rotación), no hay
  markup ni memes.
- La galería "Photos & videos" por chat no existe todavía.
