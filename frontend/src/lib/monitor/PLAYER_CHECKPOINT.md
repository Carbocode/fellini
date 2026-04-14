# Monitor Player Checkpoint

Data checkpoint: 2026-04-11

Questo documento descrive il monitor realtime attualmente funzionante. Serve come riferimento stabile prima di ulteriori refactor o ottimizzazioni.

## Scopo attuale

Il monitor principale non usa piu` elementi HTML `<video>` o `<audio>` per la preview centrale. Il path attivo e`:

1. composizione timeline compilata una volta per revisione
2. demux ISOBMFF (`MP4` / `MOV`) via `MediaBunny`
3. decode audio via `WebCodecs.AudioDecoder`
4. transport audio via `WebAudio` con `AudioContext` come clock master
5. decode video via `WebCodecs.VideoDecoder` dentro un `DedicatedWorker`
6. trasferimento dei `VideoFrame` al main thread
7. compositing video via `WebGPU` su `canvas`

La sidebar preview degli asset resta separata e continua a usare i media element HTML nativi. Questo documento riguarda solo il monitor centrale.

## Perimetro supportato

- Browser target: Chromium / Brave
- Capability richieste: `WebGPU`, `VideoDecoder`, `AudioDecoder`
- Formato media supportato dal monitor: MP4 / MOV con video H.264 (`avc1` / `avc3`) e audio AAC (`mp4a`)
- Video monitor supporta: multi-lane, `z_index`, `visible`, trim, `original/cutout`, `x/y`, `scale`, `rotation`, `opacity`, `crop`
- Audio monitor supporta: mix di tutte le lane audio non mute con gain per clip
- Non supportato nel monitor v1: sottotitoli, fallback a `<video>` nel monitor, codec fuori da MP4/H.264/AAC

## File map

- `frontend/src/lib/monitor/composition.ts`
  Compila il progetto editoriale in una snapshot monitor-friendly.
- `frontend/src/lib/monitor/mp4.ts`
  Demuxa il file MP4 e produce i sample encoded video/audio.
- `frontend/src/lib/monitor/audio.ts`
  Decodifica AAC in `AudioBuffer` e gestisce il transport audio realtime.
- `frontend/src/lib/monitor/video-worker-types.ts`
  Definisce il protocollo messaggi tra main thread e worker video.
- `frontend/src/lib/monitor/video-decoder.worker.ts`
  Fa il decode video effettivo e pompa il decoder.
- `frontend/src/lib/monitor/video.ts`
  Gestisce il buffer locale di `VideoFrame` per una clip video.
- `frontend/src/lib/monitor/renderer.ts`
  Fa il compositing WebGPU sul `canvas`.
- `frontend/src/lib/monitor/runtime.ts`
  Orchestration layer: collega composizione, demux, audio, video e renderer.
- `frontend/src/components/Workspace.tsx`
  Integra il runtime nel pannello monitor.
- `frontend/src/index.css`
  Stili del canvas monitor, overlay unsupported e pannello debug.

## Architettura generale

L'architettura attuale e` intenzionalmente separata in quattro livelli:

1. `composition compiler`
   Traduzione da `EditorialProject` a una struttura prefiltrata per il monitor.
2. `media runtime`
   Demux MP4, cache audio, cache player video.
3. `transport`
   `AudioContext` come sorgente del tempo di playback.
4. `renderer`
   Canvas WebGPU come unica surface visibile del monitor.

Il punto chiave e` che il clock vero e` l'audio, non il render loop. Il video segue `AudioContext.currentTime`.

## Flusso end-to-end

### 1. Compilazione composizione

`compileMonitorComposition(project)` in `composition.ts` produce:

- `sequence`
  Risoluzione, fps, sample rate e background
- `videoLayers`
  Solo clip video abilitate, su track visibili, con draw metadata
- `audioClips`
  Solo clip audio effettivamente schedulabili

Le clip vengono filtrate una volta in base a:

- `clip.enabled`
- esistenza della track
- esistenza dell'asset
- esistenza del `mediaPath`
- durata clip positiva
- per il video: `track.kind === "video"` e `track.visible`
- per l'audio: track non muta, clip audio non muta e asset con audio reale

Il risultato viene ordinato:

- video: ordine di draw basato su `trackOrder`, `zIndex`, `start`, `id`
- audio: ordine di scheduling basato su `start`, `trackOrder`, `id`

Helper importanti:

- `activeVideoLayersAtTime(composition, time)`
- `audioClipsStartingFrom(composition, time)`
- `clipLocalTime(clip, timelineTime)`

`clipLocalTime` converte il tempo timeline nel tempo locale dentro la clip: e` il valore usato sia per il decode video sia per l'offset audio.

### 2. Inizializzazione runtime

`CanvasMonitorRuntime` in `runtime.ts` e` il coordinatore centrale.

Responsabilita`:

- inizializzare il renderer WebGPU
- mantenere cache demux per media path
- mantenere cache `AudioBuffer`
- mantenere cache `VideoClipPlayer`
- pubblicare stato capability
- pubblicare diagnostica runtime
- controllare play / pause / seek / destroy

Cache principali:

- `demuxCache`
- `audioBufferCache`
- `videoPlayers`

Il runtime non demuxa o decodifica ogni frame. Prepara e riusa gli oggetti per media path o per clip player.

### 3. Capability gating

All'avvio il runtime controlla:

- presenza di `navigator.gpu`
- presenza di `window.VideoDecoder`
- presenza di `window.AudioDecoder`

Da questo deriva:

- stato GPU: `ready` o `unsupported`
- stato codec: `ready` o `unsupported`

Se manca una capability, il monitor mostra overlay unsupported e non tenta il rendering.

### 4. Demux MP4

`demuxMp4Asset(url)` in `mp4.ts`:

- fa `fetch()` del file media
- passa il buffer a `mp4box`
- valida che le track siano compatibili con il perimetro v1
- estrae sample video/audio encoded

Il monitor accetta solo:

- video `avc1.*` o `avc3.*`
- audio `mp4a.*`

Output del demux:

- `DemuxedVideoTrack`
  contiene codec, dimensioni coded, `description` H.264 e array di sample encoded
- `DemuxedAudioTrack`
  contiene codec AAC, sample rate, channel count, description e sample encoded

Nota importante sui sample video:

- i sample arrivano da `mp4box` in decode order
- `timestampUs` e` basato sul `CTS`, quindi rappresenta tempo di presentazione

Questa differenza e` critica con H.264 B-frame. Il worker attuale e` stato corretto per non assumere che l'array sia ordinato monotonicamente per `CTS`.

### 5. Audio path

L'audio vive sul main thread in `audio.ts`.

#### Decode audio

`decodeAudioTrackToAudioBuffer(track)`:

- verifica il supporto via `AudioDecoder.isConfigSupported`
- configura `AudioDecoder`
- decodifica tutti i sample AAC
- copia ogni `AudioData` in `Float32Array` planari
- ricostruisce un `AudioBuffer` unico per l'intera traccia

Il monitor usa questo `AudioBuffer` come base per i clip audio in playback.

#### Transport audio

`MonitorAudioTransport` e` il clock master del sistema.

Regole operative:

- il tempo corrente del monitor durante il play e` `AudioContext.currentTime`
- il transport crea un nuovo scheduling per le clip audio visibili dal punto di partenza in avanti
- ogni clip viene riprodotta con `AudioBufferSourceNode + GainNode`
- `gain` per clip viene rispettato
- lane/clip mute sono gia` state filtrate a monte dal compiler composizione

Dettagli pratici:

- `play(clips, startTime, duration)`:
  - crea o riusa `AudioContext`
  - resume del context
  - imposta `startContextTime` con un lead di 30 ms
  - schedula tutte le clip audio future
- `pause()`:
  - calcola il tempo corrente
  - stoppa i node schedulati
  - sospende l'`AudioContext`
- `seek(time, clips, duration)`:
  - se il transport e` in play, rischedula da capo sul nuovo tempo

Conseguenza architetturale importante:

- il render loop video non decide il tempo
- legge il tempo gia` deciso dal transport audio

### 6. Video decode: divisione worker / main thread

Il decode video e` spezzato in due parti:

- `video-decoder.worker.ts`
  worker dedicato che alimenta `VideoDecoder`
- `video.ts`
  buffer locale di `VideoFrame` sul main thread

Questo split evita di far vivere il pumping del decoder nella UI thread.

## Video worker: comportamento attuale

### Obiettivo del worker

Il worker non renderizza. Fa solo tre cose:

1. sceglie il punto corretto da cui ricominciare a decodificare
2. pompa chunk encoded dentro `VideoDecoder`
3. invia i `VideoFrame` al main thread via `postMessage(..., [frame])`

### Stato interno del worker

Variabili chiave:

- `track`
  traccia video encoded
- `decoder`
  istanza `VideoDecoder`
- `generation`
  token per invalidare seek / reset precedenti
- `targetUs`
  tempo timeline locale richiesto dal main thread
- `playing`
  indica se il transport e` in play o in pausa
- `sampleCursorIndex`
  indice del prossimo sample encoded da mandare al decoder
- `emittedUntilUs`
  copertura reale dei frame gia` emessi dal decoder
- `pumpPromise`
  lock per evitare pump concorrenti

### Configurazione decoder

`resolveSupportedDecoderConfig(track)` prova in ordine:

1. `prefer-hardware`
2. `no-preference`
3. `prefer-software`

Viene usata la prima config supportata da `VideoDecoder.isConfigSupported`.

Questo fallback e` importante per evitare falsi negativi di supporto su alcuni browser / GPU driver.

### Seek start corretto

`findSeekStartIndex(samples, targetUs)` fa scan dei soli keyframe e sceglie:

- l'ultimo keyframe con `timestampUs <= targetUs`, se esiste
- altrimenti il primo keyframe disponibile

Punto fondamentale:

- non viene fatto binary search ingenuo su `CTS`
- il motivo e` che con H.264 e B-frame il `CTS` non e` monotono rispetto al decode order

Questa e` una delle invarianti piu` importanti del player attuale.

### Watermark di buffering

Il worker non pompa "a finestre" rigide come nelle versioni precedenti.

Usa watermark:

- preroll: `VIDEO_PREROLL_US = 500_000`
- high watermark in play: `PLAYING_HIGH_WATERMARK_US = 3_000_000`
- high watermark in pausa: `PAUSED_HIGH_WATERMARK_US = 1_000_000`
- backpressure decoder: `MAX_DECODE_QUEUE_SIZE = 32`

Il target desiderato non e` "quanti chunk ho sottomesso", ma "fino a che tempo ho davvero ricevuto frame dal decoder".

Per questo `shouldPumpMore()` usa:

- `sampleCursorIndex < track.samples.length`
- `decoder.decodeQueueSize < MAX_DECODE_QUEUE_SIZE`
- `emittedUntilUs < desiredBufferedEndUs()`

`emittedUntilUs` e` la misura giusta del buffer utile. Non basta sapere quanti chunk sono gia` nel decoder.

### Pump decoder

`pumpDecoder()` manda al decoder i sample encoded in decode order:

- `type: "key"` se `sample.isKeyFrame`
- `type: "delta"` altrimenti

Il pump continua finche`:

- non finisce i sample
- non riempie troppo la `decodeQueueSize`
- non raggiunge la copertura desiderata

### Output decoder

Quando il decoder emette un `VideoFrame`:

- il worker aggiorna `emittedUntilUs`
- trasferisce il frame al main thread
- chiama `schedulePump()` per continuare a riempire il buffer

Anche l'evento `dequeue` del decoder richiama `schedulePump()`.

Quindi il refill e` guidato da:

- uscita reale di frame
- backpressure reale del decoder

non da un timer esterno.

### Seek e reset

`seekTo(nextTargetUs)` fa:

1. aggiorna `targetUs`
2. incrementa `generation`
3. aspetta che un eventuale pump precedente si quieti
4. calcola `decodeStartUs = max(0, targetUs - preroll)`
5. sceglie il keyframe corretto con `findSeekStartIndex`
6. imposta `sampleCursorIndex`
7. reimposta `emittedUntilUs`
8. configura un nuovo decoder
9. fa partire un primo `pumpDecoder()`

Nota importante:

- il worker attuale non usa `flush()` nel playback normale
- questa e` una scelta deliberata, per evitare stalli, richieste spurie di keyframe e hitch periodici

### Protocollo messaggi

Definito in `video-worker-types.ts`.

Comandi main -> worker:

- `init`
- `update-target`
- `dispose`

Eventi worker -> main:

- `ready`
- `frame`
- `error`

## VideoClipPlayer sul main thread

`VideoClipPlayer` in `video.ts` e` un controller per una singola clip video attiva.

Responsabilita`:

- creare il worker on-demand
- ricevere i `VideoFrame`
- mantenerli in un array locale ordinato per `timestampUs`
- restituire il frame migliore per un certo `targetUs`
- fare eviction dei frame vecchi
- attendere l'arrivo di un frame quando necessario

### Buffer locale frame

Ogni elemento bufferizzato contiene:

- `timestampUs`
- `durationUs`
- `frame`

I frame vengono inseriti ordinati per `timestampUs`.
Se arriva un frame con stesso timestamp, quello precedente viene chiuso e sostituito.

### Scelta del frame da renderizzare

`findFrameAt(targetUs)` cerca nell'ordine:

1. frame che copre davvero il tempo richiesto
2. ultimo frame precedente
3. primo frame bufferizzato

Questa logica evita buchi visivi se il frame esatto non e` ancora arrivato ma esiste gia` un frame precedente valido da tenere a schermo.

### Retention locale

`evictFramesBefore(targetUs - 1_000_000)` chiude i frame troppo vecchi e limita la crescita del buffer locale.

Il player non mantiene tutta la clip in memoria. Tiene solo una finestra utile piu` un po' di storia.

### Attesa frame

Se serve davvero un frame e non e` ancora disponibile:

- `waitForFrameAt(targetUs)` aspetta fino a 4 secondi
- se non arriva nulla, segnala `Timeout attesa frame video`

### Logica `ensureWindow`

`ensureWindow(targetUs, playing)` fa:

1. assicura l'esistenza del worker
2. misura il range bufferizzato locale
3. decide se serve un seek worker-side
4. invia `update-target`
5. fa eviction dei frame vecchi
6. se serve, aspetta l'arrivo di un frame

Seek forzato solo se:

- il target e` prima del buffer locale e non c'e` frame di fallback utile
- oppure in pausa il target va oltre il buffer locale

Nel playback normale in avanti si preferisce estendere il buffer, non rifare seek continuamente.

## Renderer WebGPU

`MonitorWebGpuRenderer` in `renderer.ts` e` l'unico renderer visibile del monitor.

### Surface

- context: `canvas.getContext("webgpu")`
- output visibile: solo `canvas`
- niente `<video>` nascosti o paralleli nel monitor

### Setup GPU

Durante `initialize(sequence)` il renderer:

- ottiene `GPUAdapter`
- richiede `GPUDevice`
- configura il `GPUCanvasContext`
- crea un `sampler`
- crea un `uniformBuffer`
- crea una render pipeline con shader WGSL

Sono anche registrati:

- listener `uncapturederror`
- handler `device.lost`

Gli errori arrivano fino al runtime e finiscono nella diagnostica del monitor.

### Path di sampling video

Il renderer attuale usa:

- `device.importExternalTexture({ source: layer.frame })`
- shader fragment con `texture_external`
- `textureSampleBaseClampToEdge`

Questo e` il path che attualmente funziona con i `VideoFrame` prodotti da WebCodecs.

### Uniform per layer

Ogni layer viene convertito in un blocco uniform con:

- scala base contain rispetto al canvas
- translate da `x/y`
- UV origin e UV scale per il crop
- cos/sin della rotazione
- opacity

`crop` accetta:

- valori `< 1` interpretati come ratio
- valori `>= 1` interpretati come pixel

### Draw loop renderer

`render(sequence, layers)` fa:

1. clear del canvas con `sequence.background`
2. per ogni layer:
   - scrive le uniform
   - importa la external texture dal `VideoFrame`
   - crea il bind group
   - esegue `draw(6)`
3. submit del command buffer

L'ordine dei layer in input e` gia` l'ordine di compositing deciso a monte.

## Runtime di playback

### `setComposition`

Quando cambia progetto o revisione:

- aggiorna `composition`
- riallinea `currentTime`
- distrugge i `VideoClipPlayer` non piu` necessari
- avvia preload demux/audio
- se era in play, rischedula l'audio
- renderizza subito il frame corrente in modalita` blocking

### `play`

`play()` fa:

1. verifica che il renderer sia pronto
2. render blocking al tempo corrente
3. avvia il transport audio con le clip da `currentTime` in avanti
4. marca `playing = true`
5. avvia il loop `requestAnimationFrame`

### `pause`

`pause()` fa:

1. prende il tempo corrente dal transport audio
2. stoppa il loop RAF
3. mette `playing = false`
4. aggiorna il playhead UI
5. renderizza una volta il frame corrente

### `seek`

`seek(time)` fa:

1. clamp del tempo
2. update del playhead UI
3. rischedula il transport audio
4. se il transport resta in play, riavvia il loop
5. render blocking sul nuovo tempo

### Loop durante il play

Il loop non gira sempre. Parte solo quando il transport e` in play.

Ad ogni tick:

1. legge il tempo canonico dal transport audio
2. aggiorna il playhead UI
3. se arriva a fine timeline, chiama `pause()`
4. invoca `renderAtTime(currentTime, false)`
5. richiede il frame successivo con `requestAnimationFrame`

Questa e` un'altra invariante importante: niente loop 60 fps costante quando il monitor e` in pausa.

### Build dei render layer

`buildRenderLayers(time, blocking)`:

1. calcola le clip video attive al tempo richiesto
2. per ogni layer:
   - recupera o crea il `VideoClipPlayer`
   - converte il tempo timeline in `localTimeUs`
   - invoca `ensureWindow(localTimeUs, playing)`
   - legge stats decode/buffer
   - prende il `VideoFrame` migliore con `getFrameAtTime`
3. produce un array `RenderVideoLayer[]`

Se un layer attivo non ha ancora un frame, non viene incluso in `renderLayers`.

## Integrazione UI

`MonitorPanel` in `Workspace.tsx`:

- costruisce `composition` con `compileMonitorComposition(project)`
- istanzia `CanvasMonitorRuntime`
- inoltra `onTimeUpdate` verso `setPlayheadTime`
- inoltra `onPlayingChange` verso lo stato UI
- mostra capability WebGPU / WebCodecs
- mostra il `canvas`
- mostra un overlay se il monitor non e` supportato
- mostra un pannello debug con diagnostica runtime

### Diagnostica esposta

Il runtime pubblica:

- `renderer`
- `currentTime`
- `activeLayers`
- `renderedLayers`
- `decodedFrames`
- `bufferedFrames`
- `lastError`

Questi campi sono stati essenziali per portare il player allo stato funzionante attuale e conviene mantenerli finche` il runtime non sara` molto piu` maturo.

## Invarianti da non rompere

Questi punti sono attualmente strutturali. Se cambiano, il monitor puo` tornare a scattare, bucarsi o bloccarsi.

1. Il monitor centrale deve avere una sola surface visibile: il `canvas`.
2. La sidebar asset preview resta separata e puo` continuare a usare media element HTML.
3. Il clock master deve restare l'audio via `AudioContext`, non il renderer.
4. Il decode video deve restare fuori dalla UI thread.
5. Il worker non deve usare `flush()` nel playback continuo.
6. Il refill del decoder deve basarsi su copertura reale dei frame emessi, non solo sul numero di chunk gia` inviati.
7. Il seek video deve partire da un keyframe reale, non da una ricerca ingenua su `CTS`.
8. In pausa non deve girare un render loop continuo.
9. Il renderer deve tenere il frame precedente finche` non ne arriva uno piu` aggiornato, evitando buchi neri temporanei.
10. Gli errori WebGPU e decoder devono continuare a emergere nella diagnostica.

## Limitazioni note

- Supporto codec molto stretto: solo MP4 / H.264 / AAC
- Audio decode ancora sul main thread
- Nessun subtitle rendering nel monitor
- Nessun batching GPU avanzato tra layer
- Un `VideoClipPlayer` per clip/layer attivo, non ancora un pool piu` sofisticato
- Nessuna strategia avanzata di adaptive buffering
- Nessun fallback monitor-side a renderer 2D o `<video>`

## Modifiche future relativamente sicure

- aumentare la copertura dei test automatici
- rifinire watermark e retention dei frame
- migliorare la cache demux/audio
- ottimizzare la creazione dei bind group WebGPU
- spostare anche il decode audio in worker se serve
- aggiungere metriche piu` strutturate oltre al pannello debug

## Modifiche future ad alto rischio

- reintrodurre `<video>` nel monitor come preview parallela
- cambiare il clock master dal transport audio a `performance.now()`
- usare `flush()` come parte del refill video normale
- rimettere nel worker una ricerca del seek point basata solo su `CTS`
- rifare il refill guidandolo da finestre rigide invece che da output coverage + backpressure
- rimuovere la diagnostica runtime prima di avere test di playback affidabili

## Sintesi finale

Il checkpoint attuale funziona perche` il monitor e` stato reso coerente:

- una sola surface visibile
- audio come tempo canonico
- decode video worker-side
- frame cache main-thread
- compositing WebGPU canvas-only

Se in futuro il player smette di funzionare, i primi punti da verificare sono quasi sempre questi:

1. il worker continua a ricevere il keyframe corretto dopo seek / init
2. `emittedUntilUs` continua ad avanzare
3. `VideoClipPlayer` continua ad avere almeno un frame utile da mostrare
4. il renderer continua a ricevere `RenderVideoLayer[]` non vuoti
5. il tempo di playback continua a provenire dal transport audio
