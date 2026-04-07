# Fellini

Questo documento e' la descrizione canonica del prodotto.

Fellini e' un software locale di video editing non distruttivo. L'utente lavora in una workspace unica con asset library, preview, timeline multitraccia, inspector e tool richiamabili dall'interfaccia. Il prodotto non va descritto come una pipeline automatica: le elaborazioni pesanti esistono, ma sono subordinate all'editor.

## Principi di prodotto

- `editor-first`: il centro dell'applicazione e' il progetto editoriale, non una sequenza obbligata di step.
- `non destructive`: asset originali, clip, trasformazioni, gain, fade e subtitle block restano modificabili senza riscrivere il sorgente.
- `local-first`: media, progetto e output vivono nel workspace locale del repository.
- `tool-based automation`: trascrizione, suggerimenti editoriali, preview, render e future automazioni sono strumenti invocabili dall'editor.
- `async where needed`: operazioni pesanti possono essere eseguite in background e riportano stato/progresso, ma non definiscono la UX principale.

## Modello applicativo principale

Il modello centrale e' `EditorialProject`.

Dentro `EditorialProject` vivono:

- `sequence`: canvas, fps, sample rate e background del progetto
- `assets`: media disponibili nella library del progetto
- `tracks`: lane video e audio della timeline
- `clips`: istanze non distruttive degli asset sulla timeline
- `captions`: subtitle block generati o editati a mano
- `asset_transcriptions`: parole agganciate ai singoli asset
- `lane_transcriptions`: trascrizioni delle audio lane
- `selection`: selezione corrente nell'editor

`EditorialProject` e' la fonte di verita' del prodotto. `JobSnapshot` e `StepName` sono solo wrapper di stato backend per task asincroni e tool interni.

## Esperienza utente da documentare

Il workflow corretto da raccontare e' questo:

1. creazione del progetto con preset o dimensioni custom del canvas
2. caricamento degli asset nella library
3. preview di asset audio/video
4. drag and drop in timeline su lane video o audio
5. editing non distruttivo di clip, ordine, timing, crop, volume e fade
6. scelta della `story lane` per le operazioni guidate dal parlato
7. trascrizione di una audio lane
8. generazione e modifica dei subtitle block
9. esecuzione dei tool `Editorial` e `Render`
10. export finale del progetto

Nota importante: il primo asset sorgente puo' innescare un pass di ingest interno per creare il mezzanine iniziale del progetto, ma questo non cambia il framing prodotto. Per l'utente resta un'operazione di bootstrap dell'editor.

## Superfici di integrazione per automazioni

Le future automazioni vanno pensate come tool dell'editor, non come nuovi step di pipeline.

### Asset-level

- generazione preview filmstrip e waveform
- rimozione background foto o video
- denoise, source separation, restauro
- upscaling o transcode di supporto

### Clip-level

- stabilizzazione
- smart crop e reframing
- retime, repair locale, enhancement contestuale
- auto-fix audio o video su un solo clip

### Lane-level

- trascrizione della `story lane`
- voice cleanup e intelligibility boost
- ducking o support mix su lane secondarie
- rigenerazione subtitle block a partire dall'audio lane

### Timeline-level

- suggerimenti editoriali sul montaggio
- sincronizzazione subtitle/clip dopo edit
- automazioni su gruppi di clip collegati
- tooling assistito per revisioni e conform

### Export-level

- render master e deliverable finali
- burn-in subtitle
- preset social e canvas variants
- enhancement opzionali solo in uscita

## Come valutare nuove feature AI

Ogni report o proposta futura sui modelli locali deve usare questo schema:

- `punto d'invocazione nell'editor`: asset, clip, lane, timeline, export
- `ha senso usare un modello o un algoritmo`
- `peso`: leggero, medio, pesante
- `hardware minimo realistico`
- `compatibilita'`: CPU, NVIDIA, Apple Silicon, Vulkan/NCNN se rilevante
- `vincoli`: qualita', latenza, licenza, offline, dipendenze

La domanda giusta non e' "quale step aggiungo alla pipeline", ma "quale tool aggiungo all'editor e su quale entita' del progetto agisce".

## Stack attuale

- frontend `Solid` + `Vite`
- backend `FastAPI`
- progetto persistito come `editorial_project.json`
- `FFmpeg` / `ffprobe` per media processing, preview e render
- `faster-whisper` e `WhisperX` come dipendenze opzionali per trascrizione e alignment
- servizi dedicati per project store, asset previews e job execution

## Dettagli interni di implementazione

Il codice contiene ancora meccanismi `job`, `step` e `PipelineOrchestrator`. Vanno documentati solo come implementation detail:

- servono per eseguire tool pesanti in background
- persistono stato, log, artefatti e output nel workspace
- permettono retry e recupero di artefatti intermedi
- non rappresentano piu' il modello mentale principale del prodotto

Anche quando il codice usa nomi legacy come `pipeline`, `runStep` o `PipelineBar`, la narrativa esterna deve restare `editor`, `tool`, `workspace`, `timeline`, `lane`, `clip`, `subtitle block`, `export`.
