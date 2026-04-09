import packageJson from "../../package.json";

export type AboutDetail = {
  label: string;
  value: string;
};

export type AboutSoftwareEntry = {
  name: string;
  version: string;
  role: string;
  note?: string;
};

export type AboutSoftwareSection = {
  summary: string;
  tone: "accent" | "neutral" | "success" | "warning" | "feature";
  title: string;
  entries: AboutSoftwareEntry[];
};

export type AboutMetric = {
  label: string;
  value: string;
};

const FRONTEND_ROLES: Record<string, string> = {
  "solid-js": "Runtime UI e reattivita del workspace editoriale.",
  "@tanstack/solid-query": "Query client, cache e sincronizzazione stato remoto.",
  "wavesurfer.js": "Rendering waveform e interazione audio nella timeline.",
};

const TOOLCHAIN_ROLES: Record<string, string> = {
  "typescript": "Type-checking e build del frontend.",
  "vite": "Dev server e bundling dell'interfaccia.",
  "vite-plugin-solid": "Integrazione SolidJS nella toolchain Vite.",
};

function frontendEntries(
  dependencies: Record<string, string> | undefined,
  roles: Record<string, string>,
  fallbackRole: string,
): AboutSoftwareEntry[] {
  return Object.entries(dependencies ?? {}).map(([name, version]) => ({
    name,
    version,
    role: roles[name] ?? fallbackRole,
  }));
}

export const ABOUT_DETAILS: AboutDetail[] = [
  { label: "Prodotto", value: "Fellini" },
  { label: "Versione app", value: "0.1.0" },
  { label: "Licenza app", value: "MIT" },
  { label: "Frontend package", value: packageJson.name },
  { label: "Backend package", value: "fellini" },
  { label: "Python supportato", value: "3.12.x" },
  { label: "Server locale", value: "http://127.0.0.1:8123" },
  { label: "Workspace", value: "Editor locale, progetto persistito su disco" },
];

export const ABOUT_HERO_BADGES = [
  "Local-first",
  "Non distruttivo",
  "Editor-first",
  "Open source stack",
];

export const ABOUT_SOFTWARE_SECTIONS: AboutSoftwareSection[] = [
  {
    summary: "Dipendenze runtime che costruiscono il workspace e la UI dell'editor.",
    tone: "accent",
    title: "Frontend runtime",
    entries: frontendEntries(
      packageJson.dependencies,
      FRONTEND_ROLES,
      "Dipendenza runtime del frontend.",
    ),
  },
  {
    summary: "Strumenti usati per sviluppo locale, bundling e type-checking.",
    tone: "neutral",
    title: "Build e toolchain",
    entries: frontendEntries(
      packageJson.devDependencies,
      TOOLCHAIN_ROLES,
      "Tool open source usato per sviluppo e build.",
    ),
  },
  {
    summary: "Servizi core del backend e binari esterni richiesti dal runtime.",
    tone: "success",
    title: "Backend core",
    entries: [
      {
        name: "fastapi",
        version: ">=0.116.0,<1.0.0",
        role: "API HTTP locale e serving dell'app.",
      },
      {
        name: "pydantic",
        version: ">=2.11.0,<3.0.0",
        role: "Modelli tipizzati e validazione dei payload.",
      },
      {
        name: "python-multipart",
        version: ">=0.0.20,<1.0.0",
        role: "Gestione upload multipart degli asset.",
      },
      {
        name: "pyyaml",
        version: ">=6.0.2,<7.0.0",
        role: "Configurazione YAML del runtime.",
      },
      {
        name: "uvicorn",
        version: ">=0.35.0,<1.0.0",
        role: "ASGI server del backend.",
      },
      {
        name: "ffmpeg",
        version: "binario esterno",
        role: "Ingest, preview, render e mix audio/video.",
        note: "Usato insieme a ffprobe; richiesto nel runtime locale.",
      },
      {
        name: "ffprobe",
        version: "binario esterno",
        role: "Analisi metadati media e probing dei file.",
      },
    ],
  },
  {
    summary: "Stack opzionale per trascrizione, alignment, vision e supporto modelli locali.",
    tone: "warning",
    title: "Media e AI opzionali",
    entries: [
      {
        name: "faster-whisper",
        version: ">=1.1.0,<2.0.0",
        role: "Trascrizione audio locale.",
      },
      {
        name: "whisperx",
        version: ">=3.4.0,<4.0.0",
        role: "Alignment e timing piu accurati per transcript e subtitle.",
      },
      {
        name: "torch",
        version: "2.10.0",
        role: "Runtime ML per stack ASR e vision.",
      },
      {
        name: "torchaudio",
        version: "2.10.0",
        role: "Operazioni audio per pipeline speech.",
      },
      {
        name: "torchvision",
        version: ">=0.25.0,<0.26.0",
        role: "Supporto vision nella stack opzionale.",
      },
      {
        name: "transformers",
        version: ">=4.57.0,<5.0.0",
        role: "Caricamento modelli e inference helpers.",
      },
      {
        name: "accelerate",
        version: ">=1.10.0,<2.0.0",
        role: "Utility per esecuzione modelli locali.",
      },
      {
        name: "av",
        version: ">=16.0.0,<17.0.0",
        role: "I/O media per stack video opzionale.",
      },
      {
        name: "opencv-python",
        version: ">=4.8.0,<5.0.0",
        role: "Operazioni CV e preprocessing video.",
      },
      {
        name: "imageio",
        version: ">=2.25.0,<3.0.0",
        role: "Gestione frame sequence e immagini.",
      },
      {
        name: "imageio-ffmpeg",
        version: ">=0.6.0,<1.0.0",
        role: "Bridge ffmpeg per workflow image/video.",
      },
      {
        name: "hydra-core",
        version: ">=1.3.2,<2.0.0",
        role: "Configurazione stack vision opzionale.",
      },
      {
        name: "tqdm",
        version: ">=4.66.1,<5.0.0",
        role: "Progress reporting per job pesanti.",
      },
      {
        name: "requests",
        version: ">=2.32.0,<3.0.0",
        role: "Download e richieste HTTP ausiliarie.",
      },
      {
        name: "huggingface-hub",
        version: "0.36.2",
        role: "Download e cache modelli da Hugging Face.",
      },
      {
        name: "safetensors",
        version: ">=0.6.0,<1.0.0",
        role: "Checkpoint tensor in formato sicuro.",
      },
      {
        name: "einops",
        version: ">=0.6.0,<1.0.0",
        role: "Tensor reshaping nella stack vision.",
      },
    ],
  },
  {
    summary: "Moduli inclusi direttamente nel repository e richiamati dal backend.",
    tone: "feature",
    title: "Moduli inclusi nel repository",
    entries: [
      {
        name: "MatAnyone2",
        version: "vendorizzato in backend/third_party/MatAnyone2",
        role: "Motore di background removal integrato nel backend.",
        note: "Licenza inclusa nel repository: S-Lab License 1.0.",
      },
    ],
  },
];

const TOTAL_SOFTWARE_COUNT = ABOUT_SOFTWARE_SECTIONS.reduce(
  (count, section) => count + section.entries.length,
  0,
);

const FRONTEND_SOFTWARE_COUNT = ABOUT_SOFTWARE_SECTIONS
  .filter((section) => section.title === "Frontend runtime" || section.title === "Build e toolchain")
  .reduce((count, section) => count + section.entries.length, 0);

const OPTIONAL_SOFTWARE_COUNT = ABOUT_SOFTWARE_SECTIONS
  .find((section) => section.title === "Media e AI opzionali")
  ?.entries.length ?? 0;

export const ABOUT_METRICS: AboutMetric[] = [
  { label: "Componenti censiti", value: String(TOTAL_SOFTWARE_COUNT) },
  { label: "Stack frontend", value: String(FRONTEND_SOFTWARE_COUNT) },
  { label: "Moduli opzionali", value: String(OPTIONAL_SOFTWARE_COUNT) },
];

export const ABOUT_FOOTNOTE =
  "Le versioni riportate sono quelle dichiarate nei manifest del repository o del modulo incluso.";
