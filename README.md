# Fellini

Pipeline locale per ingest, trascrizione, auto-editing e render di video verticali per social.

## Baseline ambiente

Fellini usa `Poetry` come package manager standard e supporta ufficialmente solo `Python 3.12.x`.

La ragione pratica e' `whisperx`: le release recenti non supportano `Python 3.14`, quindi l'installazione della stack ASR completa fallisce se usi il Python di sistema piu' nuovo.

## Perche' questa architettura

Il progetto e' diviso in layer chiari:

- `domain`: modelli tipizzati per job, transcript, spans, EDL e render plan
- `adapters`: integrazione con `ffmpeg`, `ffprobe`, ASR, alignment e ASS
- `pipeline`: runner step-by-step con artefatti intermedi persistiti su disco
- `services`: job store, workspace per-job e orchestrazione di esecuzione
- `ui`: interfaccia web locale servita direttamente dal backend

La pipeline segue la specifica del file `Agent.md`:

1. ingest e normalizzazione
2. trascrizione VAD-aware
3. alignment parola-per-parola
4. labeling editoriale ed EDL
5. generazione subtitle ASS
6. render finale clean e captioned

## Struttura repository

- `backend/`: progetto Python gestito con Poetry (`pyproject.toml`, `src/`, `tests/`, `fellini.example.yaml`)
- `frontend/`: UI Solid/Vite
- `workspace/`: dati runtime dei job, mantenuti in root repository

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

Avvia la UI locale:

```bash
cd backend && poetry run fellini serve
```

Il comando abilita il backend hot reload di default. Se vuoi un processo stabile senza reload:

```bash
cd backend && poetry run fellini serve --no-reload
```

Apri `http://127.0.0.1:8123`.

Run singolo da terminale:

```bash
cd backend && poetry run fellini run ./clip.mp4 --title "Test clip" --profile balanced
```

## Modalita' custom e debug

La UI supporta due modalita' di esecuzione:

- `automatic`: crea il job e lancia tutta la pipeline
- `step_by_step`: crea il job, ma ti lascia eseguire o ripetere ogni step manualmente

Se scegli il profilo `custom`, la form espone il fine tuning di:

- trascrizione
- decisione editoriale
- sottotitoli
- render

Per fare debug su un job esistente:

1. selezionalo nella control room
2. usa `Carica job nel form`
3. modifica la config
4. usa `Salva tuning sul job`
5. lancia `Esegui prossimo step` o `Ripeti step`

Fellini persiste anche uno snapshot dello stato pipeline in `temp/pipeline_state.json`, cosi' i rerun di uno step possono ripartire dagli artefatti gia' prodotti.

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

## Modelli e dipendenze AI

Se installi i gruppi `asr` e `llm`, i modelli principali vengono scaricati automaticamente al primo run.

- `faster-whisper` scarica il modello `large-v3`
- `WhisperX` scarica i componenti di alignment necessari
- il refinement LLM locale e' ancora predisposto come extension point

Se le dipendenze AI non sono installate, Fellini continua in modalita' degradata:

- mantiene il workflow step-by-step
- produce comunque il render verticale
- salta transcript-derived edits e subtitles avanzati

Sul lato video, se la build locale di `ffmpeg` non include `libx264`, Fellini prova in automatico
`libopenh264` e poi `mpeg4`, invece di fallire all'ingest.

## Workspace

Ogni job viene salvato in `workspace/jobs/<job_id>/`:

- `uploads/`: file sorgente
- `artifacts/`: JSON intermedi e `08_subtitles.ass`
- `output/`: `edited_master`, export clean e export captioned
- `temp/`: file di lavoro
- `job.json`: stato del job per UI e API

Questa cartella e' runtime-only: non viene usata per il packaging Python o per il lock delle dipendenze.

## API locali

- `GET /` UI
- `GET /api/jobs` lista job recenti
- `GET /api/jobs/{job_id}` dettaglio job
- `POST /api/jobs` creazione job via form multipart
- `PUT /api/jobs/{job_id}/request` aggiornamento tuning di un job esistente
- `POST /api/jobs/{job_id}/steps/{step_name}/run` esecuzione o rerun di un singolo step
- `GET /jobs/{job_id}/files/{relative_path}` download di artefatti e output

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
