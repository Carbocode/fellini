# Report: Modelli, Funzionalita' e Algoritmi Locali Integrabili in Fellini

Data riferimento ricerca: `4 aprile 2026`

## Obiettivo

Questo report raccoglie modelli locali, algoritmi e tool open source rilevanti per Fellini, organizzati secondo le superfici reali d'integrazione dell'editor:

- `asset-level`
- `clip-level`
- `lane-level`
- `timeline-level`
- `export-level`

Per ogni feature il report indica:

- se ha piu' senso usare un `modello` o un `algoritmo`
- la `pesantezza` operativa
- l'`hardware minimo realistico`
- la `compatibilita'` pratica
- il `punto d'invocazione` nell'editor
- i `link ufficiali` per visionare i progetti

## Come leggere le classificazioni

- `Peso`: stima pratica per integrazione ed esecuzione (`leggero`, `medio`, `pesante`, `molto pesante`)
- `HW minimo`: stima pratica, non sempre dichiarata ufficialmente dai maintainer
- `Compatibilita'`: backend o piattaforme che hanno piu' senso per uso locale

Regola generale:

- usare `algoritmi` per normalizzazione, QC, loudness, stabilizzazione base, shot detection
- usare `modelli` per matting, source separation, restauro, segmentation, OCR, diarization, interpolation

## Executive summary

Le integrazioni con il miglior rapporto valore/complessita' per Fellini sono:

1. `DeepFilterNet` + filtri `FFmpeg` per cleanup audio
2. `MediaPipe Face Landmarker` per auto-reframing 9:16
3. `PySceneDetect` + filtri `FFmpeg` per scene split e quality control
4. `BiRefNet_lite` per background removal foto
5. `RobustVideoMatting` per background removal video

Le integrazioni piu' potenti ma da tenere opzionali:

- `Real-ESRGAN`
- `GFPGAN`
- `RIFE`
- `SAM 2`
- `ProPainter`

Le integrazioni con caveat forti:

- `RMBG-2.0`: licenza non commerciale/self-host
- `CodeFormer`: licenza piu' restrittiva
- `ProPainter`: non commerciale
- `Ultralytics`: AGPL o enterprise
- `Demucs`: repo ufficiale archiviata il `1 gennaio 2025`

## Matrice principale

### Video / Vision

| Feature | Modello o algoritmo | Peso | HW minimo realistico | Compatibilita' | Dove in Fellini | Progetti consigliati |
|---|---|---:|---|---|---|---|
| Rimozione background foto | Modello | Medio | CPU per batch piccoli, meglio GPU 6-8 GB | CPU, CUDA; Apple possibile ma meno battuta | `asset-level` | [BiRefNet_lite](https://huggingface.co/ZhengPeng7/BiRefNet_lite), [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) |
| Rimozione background video / portrait matting | Modello | Medio | GPU 6-8 GB consigliata | PyTorch, ONNX, TensorFlow, CoreML | `asset-level`, `clip-level` | [RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting) |
| Stabilizzazione clip | Algoritmo prima | Leggero | CPU | CPU; Gyroflow accelera con GPU ma non la richiede | `clip-level` | [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [OpenCV videostab](https://docs.opencv.org/4.x/d5/d50/group__videostab.html), [Gyroflow](https://docs.gyroflow.xyz/app) |
| Smart crop / auto-reframe 9:16 | Ibrido | Leggero -> Pesante | CPU per face tracking semplice, GPU 6-8 GB se object tracking/segmentation | MediaPipe cross-platform; tracking pesante meglio su GPU | `clip-level` | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker), [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker), [Ultralytics](https://docs.ultralytics.com/), [SAM 2](https://github.com/facebookresearch/sam2) |
| Upscaling / restauro generale | Modello | Medio | GPU 6-8 GB consigliata; path NCNN/Vulkan utile | PyTorch, NCNN/Vulkan | `clip-level`, `export-level` | [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) |
| Restauro facciale | Modello | Medio | GPU 6 GB consigliata | CPU/GPU; GFPGAN ha anche percorsi piu' leggeri | `clip-level`, `export-level` | [GFPGAN](https://github.com/TencentARC/GFPGAN), [CodeFormer](https://github.com/sczhou/CodeFormer) |
| Frame interpolation / slow motion | Modello | Pesante | GPU 8 GB consigliata | NVIDIA best-effort; altri backend meno maturi | `clip-level`, `export-level` | [RIFE](https://github.com/hzwer/ECCV2022-RIFE) |
| Object removal / video inpainting | Modello | Pesante -> Molto pesante | LaMa: GPU 6-8 GB; ProPainter: 12 GB+ realistici | CUDA consigliata | `clip-level` | [LaMa](https://github.com/advimman/lama), [ProPainter](https://github.com/sczhou/ProPainter) |
| OCR su frame / testo on-screen | Modello | Leggero -> Medio | CPU ok, GPU per batch/video | CPU, CUDA, ONNX | `asset-level`, `timeline-level` | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) |

### Audio

| Feature | Modello o algoritmo | Peso | HW minimo realistico | Compatibilita' | Dove in Fellini | Progetti consigliati |
|---|---|---:|---|---|---|---|
| Riduzione rumore voce | Modello o algoritmo | Leggero -> Medio | RNNoise/FFmpeg: CPU; DeepFilterNet: CPU forte o piccola GPU | Cross-platform | `asset-level`, `lane-level` | [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet), [RNNoise](https://github.com/xiph/rnnoise), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) |
| Miglioramento voce / bandwidth enhancement | Modello | Medio | GPU 6-8 GB consigliata | PyTorch | `lane-level` | [Resemble Enhance](https://github.com/resemble-ai/resemble-enhance) |
| Boost voce / intelligibilita' nel mix | Algoritmo prima, modello se mix sporco | Leggero -> Pesante | DSP: CPU; separation: GPU 8-12 GB | FFmpeg ovunque; source separation meglio su CUDA | `lane-level` | [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [Demucs](https://github.com/facebookresearch/demucs) |
| VAD / dead-air trimming | Algoritmo leggero o piccolo modello | Leggero | CPU | CPU, ONNX, PyTorch | `lane-level`, `timeline-level` | [Silero VAD](https://github.com/snakers4/silero-vad), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) |
| Diarizzazione speaker | Modello | Medio | CPU possibile, GPU meglio | PyTorch, offline supportato | `lane-level` | [pyannote community-1](https://huggingface.co/pyannote/speaker-diarization-community-1), [pyannote-audio](https://github.com/pyannote/pyannote-audio) |

### Timeline / QC / automazioni extra

| Feature | Modello o algoritmo | Peso | HW minimo realistico | Compatibilita' | Dove in Fellini | Progetti consigliati |
|---|---|---:|---|---|---|---|
| Shot detection / auto scene split | Algoritmo | Leggero | CPU | CPU | `timeline-level` | [PySceneDetect](https://www.scenedetect.com/docs/latest/) |
| QC video: black frames, blur, freeze, scene cut, blockiness | Algoritmo | Leggerissimo | CPU | CPU | `timeline-level`, `export-level` | [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) |
| QC audio: silence, loudness, speech norm, ducking | Algoritmo | Leggerissimo | CPU | CPU | `lane-level`, `export-level` | [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) |
| Tracking multi-oggetto per crop dinamico / mask assistite | Modello | Medio -> Pesante | GPU 6-8 GB consigliata | YOLO su piu' piattaforme; SAM 2 piu' GPU-centric | `clip-level`, `timeline-level` | [Ultralytics](https://docs.ultralytics.com/), [SAM 2](https://github.com/facebookresearch/sam2) |

## Cosa usare di default

### Algoritmi da preferire come default

- stabilizzazione base
- loudness normalization
- silence detect / silence compression
- shot detection
- black / blur / freeze QC
- ducking, compression, EQ e speech normalization

### Modelli da preferire quando servono davvero

- background removal
- matting video
- denoise ed enhancement voce avanzato
- OCR
- face restoration
- upscaling
- frame interpolation
- inpainting
- diarizzazione

## Roadmap consigliata per Fellini

### Tier 1

Massimo rapporto valore/complessita':

- `DeepFilterNet` + catena `FFmpeg` (`loudnorm`, `speechnorm`, `silencedetect`, `sidechaincompress`)
- `MediaPipe Face Landmarker` per auto-follow 9:16
- `PySceneDetect` per split, markers e rilevamento take
- `BiRefNet_lite` per foto
- `RobustVideoMatting` per video portrait

### Tier 2

Molto utili ma non indispensabili al core:

- `Real-ESRGAN` + `GFPGAN`
- `PaddleOCR` per rilevare testo gia' presente sul frame
- `pyannote` se il prodotto si apre a interviste, podcast o multi-speaker

### Tier 3

Potenti ma piu' costosi e specialistici:

- `RIFE`
- `SAM 2` per maschere interattive e segmentazione robusta
- `LaMa` / `ProPainter`

## Note hardware

- `CPU-only` realistico:
  - `FFmpeg`
  - `PySceneDetect`
  - `OpenCV videostab`
  - `RNNoise`
  - `Silero VAD`
  - parte di `PaddleOCR`
- `GPU 6-8 GB`:
  - `BiRefNet_lite`
  - `RobustVideoMatting` con backbone leggero
  - `Real-ESRGAN`
  - `GFPGAN`
  - `Resemble Enhance` piccolo/medio
- `GPU 8-12 GB`:
  - `RIFE`
  - `SAM 2` small
  - `Demucs` in uso comodo
- `GPU 12 GB+`:
  - `ProPainter`
  - `SAM 2` grandi
  - batch pesanti di inpainting / segmentation / video enhancement

Quando il requisito hardware non e' esplicitato dalle fonti, questa classificazione e' una inferenza pratica basata su dimensione modello, backend disponibili e uso tipico.

## Licenze e caveat da tenere presenti

- `RMBG-2.0`: licenza non commerciale/self-host da verificare con attenzione
- `RobustVideoMatting`: GPL-3.0
- `Ultralytics`: AGPL-3.0 o licenza enterprise
- `CodeFormer`: licenza piu' restrittiva rispetto ad altri progetti MIT/Apache
- `ProPainter`: non commerciale
- `Demucs`: repo archiviata dal `1 gennaio 2025`

## Link ufficiali principali

### Background removal / matting

- [BiRefNet_lite](https://huggingface.co/ZhengPeng7/BiRefNet_lite)
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet)
- [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0)
- [RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting)

### Audio cleanup / speech

- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)
- [RNNoise](https://github.com/xiph/rnnoise)
- [Resemble Enhance](https://github.com/resemble-ai/resemble-enhance)
- [Silero VAD](https://github.com/snakers4/silero-vad)
- [pyannote community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
- [pyannote-audio](https://github.com/pyannote/pyannote-audio)
- [Demucs](https://github.com/facebookresearch/demucs)

### Smart crop / tracking / segmentation

- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
- [Ultralytics](https://docs.ultralytics.com/)
- [SAM 2](https://github.com/facebookresearch/sam2)

### Enhancement / restoration

- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)
- [GFPGAN](https://github.com/TencentARC/GFPGAN)
- [CodeFormer](https://github.com/sczhou/CodeFormer)
- [RIFE](https://github.com/hzwer/ECCV2022-RIFE)
- [LaMa](https://github.com/advimman/lama)
- [ProPainter](https://github.com/sczhou/ProPainter)

### OCR / timeline analysis / filters

- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
- [PySceneDetect](https://www.scenedetect.com/docs/latest/)
- [OpenCV videostab](https://docs.opencv.org/4.x/d5/d50/group__videostab.html)
- [Gyroflow](https://docs.gyroflow.xyz/app)
- [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)

## Criterio di valutazione per i prossimi report

Ogni nuova feature proposta per Fellini dovrebbe essere classificata con questa griglia:

- `surface`: asset, clip, lane, timeline, export
- `approccio`: modello vs algoritmo
- `peso`
- `hardware minimo`
- `compatibilita'`
- `endpoint o tool UI previsto`
- `dipendenze`
- `rischi principali`

La domanda corretta non e' "quale step aggiungere alla pipeline", ma "quale tool aggiungere all'editor e su quale entita' del progetto agisce".
