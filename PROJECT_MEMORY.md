# PROJECT_MEMORY — bitácora

Historial append-only de qué cambió y por qué. El estado actual vive en
`PROJECT_MAP.md`. Nunca se reescribe ni se borra una entrada.

## 2026-10-20 — Auditoría completa de la app y arreglo del pipeline de medios

**Qué se cambió**

- El protocolo subió a v21 con tres RPC nuevos: `set_chat_archive`,
  `set_chat_mute` y `set_chat_block`. Antes el frontend llamaba a seis
  comandos Tauri (`archive_chat`, `unarchive_chat`, `mute_chat`, `unmute_chat`,
  `block_chat`, `unblock_chat`) que **no existían** en `invoke_handler`: en la
  app real archivado/mute/bloqueo fallaban siempre y el estado volvía atrás.
  Ahora son RPC de verdad en proto, Go, fake y Rust.
- El chat trae `blocked` y `mute_until_ms`. El mute indefinido se guarda como
  instante lejano (`253402300799000`).
- Nuevo `stage_outgoing_media` y `edit_image` en el núcleo Rust. El usuario
  elige un archivo, el núcleo lo valida y lo copia a
  `<data>/staged-outgoing/<uuid>/<nombre>`; solo esa ruta puede llegar al
  backend. `send_image` y `send_attachment` rechazan el resto.
- Nuevo editor de imagen (`tauri/src/components/MediaEditor.tsx`) con recorte
  libre y rotación de 90°; el recorte viaja en los píxeles de la imagen ya
  rotada. Geometría pura en `tauri/src/lib/media-crop.ts` (20 tests).
- El scope del protocolo `asset` pasó de `["**"]` (leía todo el disco) a
  `[]` más las carpetas del perfil que concede el núcleo Rust.
- El fake backend genera imágenes reales en `<data>/media` y las devuelve en
  los mensajes: antes el chat fake no tenía ninguna foto, así que la vista
  previa no se podía ver.
- `send_image` pasó de 60 s a 22 min de timeout y `get_message_image` de 30 s
  a 22 min: el shell cortaba antes que el backend (subida 120 s, descarga
  60 s) y tiraba la respuesta de una foto que ya se había enviado.
- `publishStatus` ya no pasa el archivo del usuario como temporal: se
  descartaba el archivo del usuario al terminar el envío.

**Por qué**

El síntoma reportado era "no se ve la vista previa, ni se permite modificar,
ni recortar, ni nada". La causa no era una sola: seis comandos rotos, ningún
editor de imagen, ninguna imagen en el fake, y un timeout que mataba los
envíos de medios.

- Se corrigió además el buffer del waveform de la nota de voz: usaba
  `analyser.frequencyBinCount` (64) en vez de `analyser.fftSize` (128), así
  que la onda se dibujaba a media velocidad y con la mitad de la ventana.
- El grupo de mensajes ya no pinta el nombre del remitente dentro de la
  burbuja, y el avatar cae en el ÚLTIMO mensaje de la ráfaga, como en
  WhatsApp Desktop.
- Los mensajes de sistema (invitación a grupo, evento, mensajes que
  desaparecen, llamada, pago, canal, álbum) tienen su propia línea, en vez
  de la tarjeta genérica de "no compatible".
- Se agregó el estilo `||spoiler||` al parser de formato.
- El resolvedor de previews de enlaces vive en
  `backend/internal/linkpreview`: extrae OpenGraph, cachea por URL y nunca
  bloquea la entrega del mensaje.
- Se arregló el WebP animado: `golang.org/x/image/webp` no decodifica WebP
  animado, así que el envío y la descarga fallaban. Ahora se detecta con
  `webpIsAnimated` y la operación no se cae.
- La tabla `chats` tiene columna `blocked` con su migración.

**Evidencia**

- `pnpm check`: 0 errores. `pnpm test`: 153 tests, 0 fallos. `pnpm build`: OK.
- `go test ./...`: todos los paquetes en verde. `go vet ./...`: limpio.
- `cargo clippy --all-targets --locked -- -D warnings`: limpio.
- `cargo check --all-targets --locked`: limpio (crate Tauri y crate GPUPI).
- 3 tests Rust nuevos para el editor de imagen y el staging.

**Trampas**

- El toolchain de Go del sistema tiene el GOROOT incompleto; hay que forzar
  `GOTOOLCHAIN=go1.25.0`.
- MSVC está en `G:\Dev\MSVC` pero `link.exe` no está en el PATH.
- `tauri/node_modules` está roto; la verificación corre en una copia con
  `src` y `tests` copiados (no junctions: rompen la resolución de Vite).
- El binario de test de la librería Rust no arranca en esta máquina
  (`0xC0000139` antes de `main`): el binario de la app arranca bien, así que
  es el entorno, no el código. El crate GPUPI sí corre sus tests.
- `protoc` no está en el PATH: se usa el binario de
  `protoc-bin-vendored` del registro de Cargo, y `protoc-gen-go` se compila
  del módulo cacheado. El `--go_out` debe apuntar a `backend/gen` y el
  resultado se mueve a `backend/gen/bridgev1/`.

**Pendiente**

- `cargo test` del crate Tauri no corre en esta máquina.
- Scheduled send, message info, disappearing timer editable e historial de
  edición siguen sin RPC.
- La galería "Photos & videos" por chat no existe.

## 2026-10-20 — WebP animado, lista local de bloqueados, link preview y metadatos de adjuntos

**Qué se cambió**

- `backend/internal/wa/client.go`: el WebP animado ya no rompe el envío ni la
  descarga. `golang.org/x/image/webp` ignora los chunks `ANIM`/`ANMF`, así que
  `image.Decode` fallaba con "webp: invalid format" y el thumbnail borraba el
  archivo descargado. Ahora el primer frame se extrae del chunk `ANMF` y se
  decodifica aparte (`webpFirstFrame`, `decodeStillImage`); si tampoco se
  decodifica, la miniatura conserva los bytes originales y la vista previa
  JPEG se omite sin fallar la operación.
- `backend/internal/store/store.go` + `backend/internal/domain/types.go`: la
  lista local de bloqueados. Columna `chats.blocked` agregada con el mismo
  mecanismo de migración que `pinned` (`hasColumn` + `ALTER TABLE`),
  `Store.SetChatBlocked(ctx, jid, blocked)` resuelve el chat como
  `SetChatMute` y `domain.Chat.Blocked` viaja en los SELECT de chat, lista y
  búsqueda.
- `backend/internal/linkpreview/` (paquete nuevo): resuelve el OpenGraph de la
  primera URL del mensaje. Solo acepta `http`/`https`, cliente con timeout de
  10 s, cuerpo acotado a 1 MiB, hasta 3 redirects, User-Agent de escritorio,
  escáner propio de `<meta>`/`<title>` sin dependencias nuevas, y caché con
  TTL acotada con mutex. La resolución corre en segundo plano: el mensaje se
  entrega igual y la tarjeta aparece después, guardada en `link_preview_*` y
  emitida como evento `message`.
- Metadatos de los adjuntos salientes: la duración, el tamaño y la animación
  salen del archivo (MP4/MOV por `mvhd`/`tkhd`, WebM/Matroska por EBML, Ogg por
  granule, WAV por byte rate, GIF por cantidad de image descriptors). El
  `VideoMessage` ahora lleva `Seconds`, `Width`, `Height` y `GifPlayback`, y el
  `AudioMessage` lleva `Seconds`.

**Por qué**

El WebP animado no se podía enviar ni mostrar, el bloqueo no existía en el
perfil del escritorio, los enlaces no mostraban tarjeta porque el cliente de
WhatsApp casi nunca manda el preview, y un video o audio saliente llegaba sin
duración ni tamaño, así que la UI no lo podía detectar como GIF.

**Evidencia**

- `go build ./...`, `go vet ./...` y `go test ./...` verdes (con
  `GOTOOLCHAIN=go1.25.0`).
- Tests nuevos: `backend/internal/wa/client_animated_webp_test.go` (fixture
  WebP animado real armado a mano), `client_attachment_metadata_test.go`,
  `client_linkpreview_test.go`, `backend/internal/store/store_blocked_test.go`
  y `backend/internal/linkpreview/resolver_test.go`.

**Trampas**

- `golang.org/x/image/webp` sí decodifica el *config* de un WebP animado (sale
  del chunk `VP8X`), pero no el frame completo: por eso el thumbnail puede
  calcularse sin decodificar y el preview sale del primer frame.
- `gif.DecodeAll` materializa todos los frames: un GIF chico puede ocupar
  gigabytes de píxeles. El conteo de frames del backend recorre los bloques
  del GIF sin decodificar ninguno.
- Una voz nota que no sea Ogg Opus se rechaza con error (no se degrada a audio
  común): el test existente `TestOpenAttachmentSourceValidatesKindsAndVoiceNotes`
  lo exige.

**Pendiente**

- La miniatura JPEG del link preview sigue vacía: no hay descarga de la
  `og:image`, la tarjeta se paints sin imagen.
- El preview no se actualiza en los mensajes que entraron por el diario de
  entrada (se reintentan después sin preview).
- Markup, memes y recorte de vídeo no existen.

## 2026-10-20 — Renombre del proyecto a Whatfast, íconos nuevos y publicación en GitHub

**Qué se cambió**

- Todo el proyecto se renombró a **Whatfast**: 73 archivos de texto, más el
  entrypoint del sidecar Go (`backend/cmd/whatfast-backend`), el crate
  `whatfast-tauri` (lib `whatfast_tauri_lib`), el crate legacy
  `whatfast-desktop`, el binario `whatfast`, el paquete npm `whatfast-tauri`,
  el `productName`, el `identifier` (`com.whatfast.desktop`), el título de la
  ventana, la bandeja, las notificaciones nativas y todas las variables de
  entorno, que ahora llevan el prefijo `WHATFAST_`.
- El paquete del protocolo pasó a `whatfast.bridge.v1` y el `go_package` a
  `github.com/Owning01/whatfast/backend/gen/bridgev1`. Se regeneró
  `backend/gen/bridgev1/bridge.pb.go` con `protoc` + `protoc-gen-go` v1.36.11.
  El módulo Go quedó en `github.com/Owning01/whatfast/backend`.
- Se borró toda referencia al proyecto anterior y a su responsable: la URL
  del repositorio en `tauri/src-tauri/Cargo.toml`, el fixture de test de
  iniciales de avatar y los nombres de muestra de los datos de prueba. No
  queda una sola coincidencia del nombre viejo fuera del paquete upstream
  `whatsmeow`, ni en el árbol actual ni en los 210 commits del historial.
- Set completo de íconos regenerado con `tauri icon` desde el logo de
  Whatfast (PNG 1024 de Flow): `.ico`, `.icns`, PNG de 32 a 512, los
  `Square*Logo` de Windows y las carpetas `android/` e `ios/`.
- El historial de git se reatribuyó a Octavio Gonzalez
  <octaviofacultad@gmail.com> y se publicó en
  `github.com/Owning01/whatfast` (público).

**Por qué**

El proyecto se llama Whatfast y es trabajo de una sola persona: publicarlo
bajo la cuenta de otro le atribuiría el trabajo a alguien que no lo hizo, y
el nombre viejo no correspondía a la marca.

**Evidencia**

- `go build ./...`, `go vet ./...` y `go test ./...`: verdes (9 paquetes).
- `pnpm check`: 0 errores. `pnpm test`: 153/153.
- `cargo check --all-targets --locked` y `cargo clippy --all-targets --locked
  -- -D warnings`: limpios en el crate Tauri.
- Release recompilada: `build/tauri-target/release/whatfast.exe` con el
  sidecar `whatfast-backend.exe` al lado.

**Trampas**

- El volumen G: no deja borrar ni renombrar archivos preexistentes ("Acceso
  denegado" incluso como administrador; crear y editar sí funciona). Por eso
  el entrypoint anterior del sidecar Go quedó como stub `//go:build ignore`
  en vez de borrarse, y el `git rm --cached` de ese camino quedó registrado en
  `.git/info/exclude` (local, no se publica). Por lo mismo el índice de git
  no se puede escribir: los commits se hacen en una copia de trabajo en C: y
  se replican acá moviendo el ref a mano.
- `git filter-repo` no estaba instalado: se compiló `protoc-gen-go` desde el
  módulo cacheado de Go y se instaló `git-filter-repo` con pip.
- El logo lo generó Flow (Nano Banana 2.1, no Pro: el panel no toma el chip
  "Pro"). Quedó en la carpeta de descargas, en `logo-whatsapp-fast\`.

**Pendiente**

- La imagen de showcase del README apunta a un adjunto de usuario de GitHub
  (`github.com/user-attachments/assets/...`): si esa cuenta se borra, la
  imagen del README se rompe.
- `tauri/node_modules` sigue roto: `make deps` y `make build` fallan en el
  repo hasta que se repare el volumen o se reinicie la máquina.

## 2026-10-20 — README nuevo con benchmarks medidos, capturas de la UI y auditoría de datos

**Qué se cambió**

- `README.md` reescrito en español: qué es la app, ocho capturas de la UI con
  chats y contactos mockeados, tabla comparativa contra WhatsApp Web y contra
  la app de Windows, sección de "dónde gana" y de "dónde todavía pierde",
  arquitectura, privacidad, compilación y protocolo.
- Ocho capturas en `docs/screenshots/`: lista de chats, conversación con foto
  y nota de voz, grupo con video, nota de voz, búsqueda sobre contactos y
  mensajes, ficha del contacto, editor de imagen y picker de emoji. Se
  sacaron con un Chromium headless propio contra el modo mock del repo, así
  que no tocan la sesión del navegador del usuario.
- `LICENSE-MIT` y `LICENSE-APACHE`: el repo declaraba la licencia dual en los
  `Cargo.toml` pero no tenía los archivos.
- Se sacaron las 3 rutas absolutas con el nombre de usuario de esta máquina
  que quedaban en `PROJECT_MAP.md`, `PROJECT_MEMORY.md` y
  `docs/WA_DESKTOP_FEATURE_BASELINE.md`.

**Por qué**

El README viejo describía la arquitectura y no decía nada de por qué usar esta
app en vez de WhatsApp Web o la app de Windows. La comparación tiene que
apoyarse en números, y los números tienen que estar medidos, no estimados.

**Evidencia**

- Todo el árbol y los 214 commits auditados: sin tokens, sin API keys, sin
  claves privadas, sin credenciales en URL, sin `.env`/`.pem`/`.key`, sin
  bases de datos ni logs versionados, sin artefactos de build. Los únicos
  correos son el del autor y JID de prueba (`@s.whatsapp.net`).
- Tree publicado: 284 archivos, 3,9 MB, el más grande es el `.pb.go`
  generado (386 KB).
- Mediciones del 20/10/2026 en esta máquina: ventana visible a los 0,25 s;
  lista de chats a los 1,16 s (build de desarrollo, Chromium headless);
  núcleo Rust 25,6 MB, sidecar Go 31,8 MB, WebView2 366,8 MB, total 432 MB;
  UI 411 KB (127 KB gzip). WhatsApp Web en el mismo Chromium headless: FCP
  0,91 s, `load` 3,50 s, 5.948 KB de JS solo la pantalla de login, 79 MB de
  heap JS. Brave con 6 pestañas: 612,7 MB.
- La app de Windows no está instalada en esta máquina: sus celdas quedan sin
  medir y la diferencia se explica por estructura (trae su propio Chromium),
  no con un número inventado.

**Trampas**

- El modo mock del navegador solo existe en build de desarrollo
  (`import.meta.env.DEV`): el bundle de producción sin Tauri no muestra la
  UI, así que el tiempo de pintado no se puede medir en el navegador con el
  bundle de producción.
- La página de WhatsApp Web rechaza el user agent de headless: hay que
  falsearlo o devuelve "WhatsApp works with Google Chrome 100+".
- La app real sí abre ventana y dibuja, pero en una sesión sin escritorio
  visible hay que capturarla por `hwnd` (PrintWindow): con captura de
  pantalla completa se captura lo que el usuario tiene abierto.

**Pendiente**

- La app de Windows sigue sin medirse en esta máquina.
- El PNG de showcase del README viejo (un adjunto de usuario de GitHub de la
  cuenta anterior) ya no está: el README nuevo usa capturas propias.
