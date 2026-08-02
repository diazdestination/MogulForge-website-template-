// Minimal Vite import.meta.env typing for this library.
// Consumers (Vite apps) provide the real values at build time.
interface ImportMetaEnv {
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
