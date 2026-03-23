Software che implementa la pipeline per **creazione e montaggio automatico di video verticali** con focus su **italiano**, **take unici**, **ripulitura del parlato** e **sottotitoli animati**:

## Stack definitivo

**ASR / timing**

* `faster-whisper` con **`openai/whisper-large-v3`**
* `WhisperX` per **word-level timestamps** e riallineamento preciso
* `Silero VAD` per segmentare il parlato e ridurre silenzi/allucinazioni

**Editing decision**

* regole deterministiche
* un piccolo LLM locale per classificare cosa tenere/tagliare, per esempio **Qwen3-8B**

**Render**

* `FFmpeg` per trim, concat, crop 9:16, normalizzazione, burn-in
* sottotitoli in **ASS** renderizzati con il filtro `subtitles` di FFmpeg via **libass**

**Opzionale**

* `pyannote/speaker-diarization-community-1` solo se hai davvero più speaker nello stesso file

La scelta è questa perché `faster-whisper` è una reimplementazione di Whisper con CTranslate2, dichiarata fino a **4x più veloce** dell’implementazione OpenAI a parità di accuratezza e con meno memoria; integra anche il filtro VAD basato su Silero. `WhisperX` aggiunge word timestamps accurati, diarization e VAD, e dichiara modelli di allineamento automatici anche per **`it`**. FFmpeg supporta il filtro `subtitles` via `libass`, converte i sottotitoli in ASS e offre opzioni utili come `original_size`, `fontsdir` e `force_style`. Le animazioni ASS si fanno con tag come `\t(...)`, che Aegisub documenta come trasformazioni animate di scala, colore, blur, shadow, clip e altro. ([GitHub][1])

## Principio chiave

Non farei mai una pipeline “ASR che decide tutto”.
La dividerei in **tre livelli**:

1. **capire cosa è stato detto**
2. **decidere cosa tagliare e cosa mostrare**
3. **renderizzare il video finale**

Questo separa bene precisione audio, decisione editoriale e output visivo.

## Architettura completa

### 1. Ingest e normalizzazione

Input: qualunque file camera/phone.
Output di lavoro:

* `source_mezzanine.mp4`
* `audio_16k_mono.wav`

Qui fai:

* `ffprobe` per leggere fps, durata, sample rate, aspect ratio
* `ffmpeg` per estrarre audio mono a 16 kHz
* eventuale normalizzazione audio leggera per stabilizzare l’ASR

FFmpeg è pensato per leggere, filtrare e transcodificare input diversi, e il suo sistema di filtergraph è il centro giusto per una pipeline di montaggio automatica. ([FFmpeg][2])

### 2. Speech segmentation

Prima segmenti il parlato con **VAD**.
Puoi farlo in due modi:

* usando `vad_filter=True` direttamente in `faster-whisper`
* oppure facendo un pass separato con `Silero VAD`

Silero è molto leggero e il repo dichiara tempi inferiori a **1 ms** per chunk da 30+ ms su un singolo thread CPU; `faster-whisper` lo integra per filtrare le parti senza parlato, mentre WhisperX dichiara che il VAD riduce le hallucinations senza peggiorare il WER. ([GitHub][3])

### 3. Trascrizione master

Trascrivi con:

* modello: `large-v3`
* lingua: `it`
* beam size: 5
* `condition_on_prev_text=False`
* `vad_filter=True`

Qui vuoi un transcript **verbatim**, non “bello”.
Serve come base oggettiva per:

* word timing
* decisione tagli
* captions

`openai/whisper-large-v3` è pubblicato con licenza **Apache-2.0** e la pagina del modello lo riporta come supporto a **99 lingue**. WhisperX usa `faster-whisper` come backend e raccomanda l’uso di modelli Whisper grandi per le lingue non inglesi. ([Hugging Face][4])

### 4. Allineamento parola-per-parola

Subito dopo, passi tutto a **WhisperX** per ottenere:

* `segments`
* `words`
* start/end di ogni parola
* opzionalmente speaker labels

Questo step è fondamentale: WhisperX spiega esplicitamente che Whisper tende ad avere timestamp a livello di utterance, non di parola, e che il forced alignment con modelli fonemici dà word-level timestamps più accurati. Nella README dichiara supporto automatico per `{en, fr, de, es, it}` tramite torchaudio pipelines, più altre lingue via Hugging Face. ([GitHub][5])

### 5. Doppio transcript: uno “vero”, uno “display”

Qui farei una distinzione che per me è obbligatoria:

**A. transcript verbatim**
Quello che davvero è stato pronunciato, con filler, restart, esitazioni.

**B. transcript display**
Quello che mostri come sottotitolo:

* togli filler inutili
* sistemi punteggiatura
* compatta micro-ripetizioni
* correggi solo errori ASR evidenti, non il contenuto inventando parole

Questo è il punto più importante dell’intera pipeline.
Se mescoli le due cose, ottieni sottotitoli “puliti” ma fuori sync con l’audio.

## Cosa intendo per “rimozione errori” nei take unici

Qui bisogna essere netti:

* se l’errore è **di dizione**, **filler**, **restart**, **ripetizione**, lo puoi sistemare benissimo con tagli automatici
* se l’errore è **semantico** (“ho detto la parola sbagliata”), senza rigenerazione vocale **non lo correggi davvero**: puoi solo tagliare, accorciare o mascherare con il montaggio

Quindi io farei così:

### Autocut sicuro

Tagli automatici solo su classi ad alta confidenza:

* `FILLER`: eh, emm, allora, cioè, ok ripetuto
* `FALSE_START`: “oggi vi voglio… oggi vi faccio vedere…”
* `IMMEDIATE_REPETITION`
* silenzi troppo lunghi
* respiri o click marginali

### Autocut prudente

Non tagliare in automatico:

* nomi propri
* numeri
* parole di contenuto a bassa confidenza
* frasi che cambiano il significato

### Compressione, non solo rimozione

Per i silenzi non farei sempre delete.
Meglio:

* silenzio < 250 ms → lascia
* 250–700 ms → comprimi
* > 700 ms → taglia o comprimi forte

## Livello decisionale: regole + LLM locale

Il LLM locale non lo userei per trascrivere.
Lo userei per produrre una **decisione editoriale** su span già temporizzati.

Input:

* parole con start/end
* confidence
* segmenti VAD
* transcript verbatim

Output:

* etichetta per span: `KEEP`, `CUT`, `SHORTEN`, `MAYBE`
* motivazione
* testo pulito per caption
* livello di rischio

Per questo ruolo Qwen3-8B è adatto perché il model card ufficiale lo presenta come modello multilingua con supporto a **100+ lingue e dialetti** e licenza **Apache-2.0**. ([Hugging Face][6])

### Regole che metterei prima del LLM

Prima del LLM farei sempre un pass deterministico:

* rimuovi filler da una whitelist italiana
* collassa ripetizioni identiche entro 400–600 ms
* marca false partenze
* marca pause lunghe
* proteggi parole con confidenza bassa ma “informative”
* proteggi numeri, date, importi, nomi propri

Il LLM entra **dopo**, non prima.

## Formati intermedi

Io salverei sempre questi file:

* `01_media_probe.json`
* `02_vad_segments.json`
* `03_transcript_raw.json`
* `04_transcript_aligned.json`
* `05_spans_labeled.json`
* `06_edit_decision_list.json`
* `07_caption_display.json`
* `08_subtitles.ass`
* `09_render_plan.json`

Così la pipeline è debuggabile.

### Schema mentale del file più importante: `edit_decision_list.json`

```json
{
  "source_video": "source_mezzanine.mp4",
  "keep_ranges": [
    { "start": 0.42, "end": 4.88, "reason": "intro clean" },
    { "start": 5.21, "end": 8.66, "reason": "removed filler" },
    { "start": 9.02, "end": 14.37, "reason": "content keep" }
  ],
  "soft_cuts": [
    { "at": 5.21, "audio_fade_ms": 20, "video_cut": "hard" }
  ]
}
```

## Montaggio automatico con FFmpeg

### 6. Trim e concat

FFmpeg ha i filtri `trim` e `concat` per tagliare una sottoparte continua e poi concatenare segmenti audio/video. `trim` non resetta i timestamp da solo, quindi dopo i trim conviene usare `setpts` e `asetpts`; `concat` unisce stream audio e video sincronizzati in sequenza. ([FFmpeg][7])

### 7. Verticale 9:16

Per la versione social:

* crop a 9:16
* scale a `1080x1920`
* padding se serve
* safe area per subtitle nel lower third

FFmpeg documenta `crop` come filtro con `x` e `y` espressioni per frame; questo è utile anche se in futuro vuoi farlo diventare “dynamic crop” guidato da un tracker. ([FFmpeg][7])

### 8. Audio seam hiding

Su parlato puro non farei crossfade lunghi.
Meglio:

* hard cut video
* micro fade audio 10–25 ms su bordi selezionati
* eventuale music bed sotto per mascherare i join

## Sottotitoli animati

Qui la scelta migliore è **ASS**, non SRT semplice.

Perché:

* FFmpeg `subtitles` usa **libass**
* converte i sottotitoli nel formato ASS
* supporta `fontsdir`, `force_style`, `original_size`
* Aegisub documenta il tag `\t(...)` per animazioni graduali di scala, colore, blur, shadow, clip e altro ([FFmpeg][7])

### Stile che userei

Per short/reel verticali:

* 2–4 parole per chunk
* highlight della parola attiva
* pop-in rapido all’inizio chunk
* outline forte
* shadow moderata
* blocco nella parte bassa ma sopra la safe area UI

### Logica subtitle

Per ogni chunk:

* testo completo visibile
* parola attiva con colore o scala diversa
* animazione in ingresso 120–180 ms
* niente karaoke “iperattivo” se il ritmo parlato è lento

### Esempio concettuale ASS

```ass
Dialogue: 0,0:00:01.20,0:00:02.10,Base,,0,0,0,,{\an2\pos(540,1540)\fscx92\fscy92\t(0,120,\fscx100\fscy100)}questa è la {\c&H00FFFF&}parte{\c&HFFFFFF&} importante
```

## Ordine completo della pipeline

1. `ffprobe` sul file
2. estrazione audio WAV mono 16k
3. VAD
4. `faster-whisper` large-v3
5. allineamento WhisperX
6. normalizzazione transcript verbatim
7. labeling spans con regole
8. labeling/refinement con Qwen3-8B locale
9. generazione EDL
10. trim + concat con FFmpeg
11. crop/scale verticale
12. generazione ASS animato
13. burn-in finale con FFmpeg
14. export:

* `master_vertical_clean.mp4`
* `master_vertical_captioned.mp4`
* `subtitles.ass`
* `project_debug.json`

## Le mie regole editoriali di default

Queste le imposterei hardcoded:

* non cancellare automaticamente parole con confidenza bassa se sono nomi, numeri o parole chiave
* non correggere mai “semanticamente” il parlato se l’audio non è stato davvero corretto
* sottotitoli leggermente più puliti dell’audio, ma non diversi nel significato
* mantieni una piccola quota di naturalezza: non eliminare tutte le pause
* fai “hard cut first, fancy effects second”

## Quando aggiungere diarization

Solo se fai:

* interviste
* podcast
* duetti
* reaction con più voci

`pyannote/speaker-diarization-community-1` supporta uso locale/offline e introduce anche `exclusive_speaker_diarization`, che il model card descrive come più semplice da riconciliare con i timestamp della trascrizione. Per talking-head singolo non lo accenderei. ([Hugging Face][8])

## Comandi FFmpeg base che terrei come fondazione

Crop verticale e burn-in ASS:

```bash
ffmpeg -i edited_master.mp4 \
  -vf "crop=ih*9/16:ih:(iw-ow)/2:0,scale=1080:1920,subtitles=08_subtitles.ass:original_size=1080x1920:fontsdir=./fonts" \
  -c:v libx264 -crf 18 -preset slow \
  -c:a aac -b:a 192k \
  output_vertical_captioned.mp4
```

Il filtro `subtitles` accetta `original_size` e `fontsdir`, utili proprio per scaling corretto dei font e font custom nel burn-in finale. ([FFmpeg][7])

## Mia opinione finale, senza ambiguità

Per il tuo caso non costruirei la pipeline intorno a “un solo modello”.

La costruirei così:

**`faster-whisper (large-v3)` → `WhisperX` → `regole + Qwen3-8B locale` → `FFmpeg + ASS`**

Per me è il miglior stack oggi perché:

* massimizza qualità in italiano
* dà timing parola-per-parola
* ti consente vero auto-editing sui take unici
* resta tutto self-hostabile
* usa componenti noti e battuti

Il punto tecnico decisivo è questo:
**usa Whisper per capire il parlato, WhisperX per agganciarlo al tempo, e FFmpeg/ASS per trasformarlo in montaggio e sottotitoli belli.**

Nel messaggio dopo ti posso scrivere la **struttura concreta del progetto** con file Python, JSON intermedi e lo **script orchestratore end-to-end**.

[1]: https://github.com/SYSTRAN/faster-whisper "GitHub - SYSTRAN/faster-whisper: Faster Whisper transcription with CTranslate2 · GitHub"
[2]: https://ffmpeg.org/ffmpeg.html?utm_source=chatgpt.com "ffmpeg Documentation"
[3]: https://github.com/snakers4/silero-vad?utm_source=chatgpt.com "Silero VAD: pre-trained enterprise-grade Voice Activity ..."
[4]: https://huggingface.co/openai/whisper-large-v3/blame/main/README.md?utm_source=chatgpt.com "README.md · openai/whisper-large-v3 at main"
[5]: https://github.com/m-bain/whisperx "GitHub - m-bain/whisperX: WhisperX:  Automatic Speech Recognition with Word-level Timestamps (& Diarization) · GitHub"
[6]: https://huggingface.co/Qwen/Qwen3-8B?utm_source=chatgpt.com "Qwen/Qwen3-8B"
[7]: https://ffmpeg.org/ffmpeg-filters.html "      FFmpeg Filters Documentation
"
[8]: https://huggingface.co/pyannote/speaker-diarization-community-1?utm_source=chatgpt.com "pyannote/speaker-diarization-community-1"
