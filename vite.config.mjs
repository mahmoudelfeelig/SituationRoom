import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const englishOcrModel = new URL(
  "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  import.meta.url,
);
const stableOcrModelFile = "assets/ocr/4.0.0_best_int/eng.traineddata.gz";

function emitStableOcrModel() {
  return {
    name: "situationroom-stable-ocr-model",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: stableOcrModelFile,
        source: readFileSync(englishOcrModel),
      });
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), emitStableOcrModel()],
});
