# Fellini

Editor video locale, non distruttivo e editor-first, con timeline multitraccia, asset library, subtitle block e tool AI richiamabili dall'interfaccia.

La descrizione canonica del prodotto e' in `Agent.md`. Questo README resta allineato a quella fonte e usa la stessa terminologia: `editor`, `workspace`, `timeline`, `lane`, `clip`, `subtitle block`, `tool`, `export`.

## Cosa e' Fellini oggi

Fellini non e' piu' da raccontare come una pipeline automatica end-to-end. Il prodotto attuale e':

- un editor locale con progetto persistito
- una timeline non distruttiva con lane video e audio
- una library di asset con preview audio/video
- un inspector per contesto e modifica della selezione
- una serie di tool richiamabili quando servono, come trascrizione lane, editorial assistito e render

Il modello applicativo principale e' `EditorialProject`, che contiene:

- `sequence`
- `assets`
- `tracks`
- `clips`
- `captions`
- `asset_transcriptions`
- `lane_transcriptions`
- `selection`

`JobSnapshot`, `StepName` e l'orchestrazione a step restano dettagli interni per esecuzioni asincrone e caching di tool pesanti.

## Baseline ambiente

Fellini usa `Poetry` come package manager standard e supporta ufficialmente solo `Python 3.12.x`.

La ragione pratica e' `whisperx`: le release recenti non supportano `Python 3.14`, quindi l'installazione della stack ASR completa fallisce se usi il Python di sistema piu' nuovo.

## Architettura reale

Il repository e' organizzato in layer chiari, ma il centro del prodotto e' l'editor:

- `domain`: modelli tipizzati del progetto editoriale, dei job e degli artefatti
- `adapters`: integrazione con `ffmpeg`, `ffprobe`, ASR, alignment e ASS
- `services`: project store, asset previews, workspace per-job e coordinamento esecuzioni
- `pipeline`: meccanismo interno legacy per orchestrare tool pesanti in background
- `frontend`: interfaccia `Solid/Vite` con workspace unica, timeline, preview e inspector

Da un punto di vista prodotto, Fellini va letto cosi':

1. crei un progetto e scegli il canvas
2. carichi asset nella library
3. apri preview e trascini clip in timeline
4. selezioni una `story lane` audio quando vuoi lavorare sul parlato
5. trascrivi una lane o aggiorni i subtitle block
6. usi i tool `Editorial` e `Render`
7. esporti il progetto finale

## Struttura repository

- `backend/`: progetto Python gestito con Poetry (`pyproject.toml`, `src/`, `tests/`, `fellini.example.yaml`)
- `frontend/`: UI `Solid/Vite`
- `workspace/`: dati runtime dei job/progetti, mantenuti in root repository

## Setup

1. Installa `Python 3.12.x`
2. Installa `Poetry`
3. Entra nella root del progetto
4. Spostati nel backend Python:

```bash
cd backend
```

5. Se il tuo Python di default non e' `3.12`, punta Poetry all'interprete giusto:

```bash
poetry env use python3.12
```

Per un clone fresco del repository, il comando consigliato dalla root e':

```bash
make setup
```

Se vuoi installare subito anche la stack AI completa:

```bash
make setup-full
```

Installazione base per sviluppo applicativo:

```bash
poetry install --with dev
```

Installazione completa della stack AI:

```bash
poetry install --with dev,asr,llm
```

L'ambiente virtuale viene creato in `backend/.venv/` tramite `backend/poetry.toml`.

## Quickstart

Avvia l'app locale:

```bash
cd backend && poetry run fellini serve
```

Apri `http://127.0.0.1:8123`.

Workflow consigliato:

1. crea un nuovo progetto
2. imposta il canvas
3. carica il primo asset sorgente
4. aggiungi asset secondari alla library
5. trascina clip nelle lane della timeline
6. marca una audio lane come `story`
7. usa la trascrizione lane quando serve
8. modifica clip e subtitle block nell'editor
9. lancia `Editorial` e `Render` dai tool dell'interfaccia

Per sviluppo separato backend + frontend:

```bash
make dev-all
```

## Operazioni disponibili nell'editor

Oggi la UI e il backend supportano gia' queste superfici principali:

- creazione progetto con preset canvas o dimensioni custom
- library di asset audio/video
- preview media, filmstrip e waveform
- timeline multitraccia con lane video e audio
- clip linked A/V, trim non distruttivo, transform, crop, gain e fade
- scelta della `story lane`
- trascrizione di audio lane
- generazione e sincronizzazione di subtitle block
- tool editoriale e tool di render
- export finale del progetto

## Tool asincroni e dettagli interni

Alcune operazioni usano ancora internamente `job`, `step`, `PipelineOrchestrator` e artefatti intermedi. Questo e' un dettaglio di implementazione, non il framing del prodotto.

In pratica:

- l'editor rimane la UX principale
- i task pesanti vengono eseguiti in background
- backend e UI mostrano stato, progresso, log e output
- il primo asset puo' attivare un ingest interno per creare il mezzanine sorgente del progetto
- endpoint e nomi legacy come `/steps/...` o `PipelineBar` non cambiano il modello mentale pubblico

## Modelli e dipendenze AI

Se installi i gruppi `asr` e `llm`, i componenti principali vengono scaricati al primo uso.

- `faster-whisper` gestisce la trascrizione
- `WhisperX` gestisce alignment e timing piu' accurati
- la parte LLM locale resta un extension point per tool editoriali assistiti

Per la rimozione background video:

- `MatAnyone2` viene clonato automaticamente in `backend/third_party/MatAnyone2` al primo uso
- il checkpoint `pretrained_models/matanyone2.pth` viene scaricato automaticamente al primo uso
- `SAM2` e i relativi pesi vengono scaricati on demand tramite Hugging Face

Se le dipendenze AI non sono installate, Fellini continua a funzionare in modalita' degradata:

- l'editor resta utilizzabile
- il render del progetto continua a funzionare
- le feature transcript-derived diventano piu' limitate o indisponibili

Sul lato video, se la build locale di `ffmpeg` non include `libx264`, Fellini prova in automatico `libopenh264` e poi `mpeg4`.

## Workspace su disco

Ogni progetto viene salvato in `workspace/projects/<project_id>/`:

- `uploads/`: file originali caricati nel progetto
- `project/editorial_project.json`: stato persistito dell'editor
- `project/asset_previews.json`: stato preview per asset
- `jobs/`: risultati persistenti delle elaborazioni backend per il progetto
- `jobs/previews/<asset_id>/<variant>/`: filmstrip e waveform per asset/variante
- `jobs/background-removal/<asset_id>/<run_id>/`: output e log delle esecuzioni mask
- `jobs/runtime/`: file persistenti di pipeline riutilizzati tra i tool
- `jobs/transcriptions/<asset_id>/`: bounce audio persistiti per clip e per trascrizioni che ricadono su un singolo asset
- `jobs/transcriptions/lane_<lane_id>/`: bounce lane-scoped quando una lane trascritta copre piu asset
- `output/`: export del progetto
- `temp/`: scratch directory effimera, svuotata a fine lavorazione
- `project.json`: stato del wrapper backend per esecuzioni asincrone

Questa cartella e' runtime-only: non viene usata per il packaging Python o per il lock delle dipendenze.

## API locali

Endpoint principali:

- `GET /` UI
- `GET /api/jobs` lista progetti/job recenti
- `POST /api/jobs` creazione progetto
- `GET /api/jobs/{job_id}` dettaglio stato job
- `DELETE /api/jobs/{job_id}` eliminazione progetto
- `PUT /api/jobs/{job_id}/request` aggiornamento impostazioni progetto
- `GET /api/jobs/{job_id}/editorial-project` caricamento progetto editoriale
- `PUT /api/jobs/{job_id}/editorial-project` salvataggio progetto editoriale
- `POST /api/jobs/{job_id}/assets` upload asset nella library
- `POST /api/jobs/{job_id}/asset-previews` richiesta preview media
- `POST /api/jobs/{job_id}/audio-lanes/{lane_id}/transcribe` trascrizione di una audio lane
- `PUT /api/jobs/{job_id}/transcript` modifica transcript persistiti
- `POST /api/jobs/{job_id}/steps/{step_name}/run` trigger di tool interni pesanti
- `GET /jobs/{job_id}/files/{relative_path}` download di artefatti e output

Gli endpoint `/steps/...` sono interni alla gestione asincrona dei tool e non vanno trattati come interfaccia prodotto primaria.

## Makefile

Il `Makefile` in root delega i target Python a `backend/` e lascia invariati i comandi piu' comuni:

```bash
make setup
make setup-full
make install
make install-full
make dev
make dev-all
make test
make lint
make lock
make check
```

Se preferisci usare Poetry direttamente, esegui i comandi da `backend/`.
`make setup` installa backend e frontend. `make install` resta backend-only.

## Configurazione

Copia `backend/fellini.example.yaml` in `backend/fellini.yaml` se vuoi cambiare porta, workspace o directory font.

La configurazione YAML gestisce il runtime dell'app, non il setup Python o Poetry. Di default il backend continua a usare `workspace/` nella root del repository.

## Verifica

```bash
cd backend && poetry check
cd backend && poetry run ruff check .
cd backend && poetry run pytest
cd backend && poetry run python -c "from fellini.app import create_app; print(create_app().title)"
```
