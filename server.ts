import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

// Initialize Express
const app = express();
app.use(express.json({ limit: "20mb" }));

// In-memory ShareFile Simulator Database
let folders = [
  { id: "root", name: "Carpeta Raíz", parentId: null, createdAt: new Date("2026-01-01").toISOString() },
  { id: "folder-vip", name: "Cuentas VIP", parentId: "root", createdAt: new Date("2026-02-15").toISOString() },
  { id: "folder-leads", name: "Prospectos Comerciales", parentId: "root", createdAt: new Date("2026-03-10").toISOString() },
  { id: "folder-regular", name: "Documentos Comunes", parentId: "root", createdAt: new Date("2026-04-01").toISOString() }
];

let files: Array<{
  id: string;
  name: string;
  folderId: string;
  mimeType: string;
  size: number;
  createdAt: string;
  base64Data: string;
  text: string; // Ground truth text
}> = [];

// API endpoints for ShareFile Simulation
app.get("/api/sharefile/folders", (req, res) => {
  res.json(folders);
});

// Step 1: Search folders (matches folder_name query, partial & case-insensitive)
app.get("/api/sharefile/search-folders", (req, res) => {
  const query = (req.query.query as string || "").trim().toLowerCase();
  if (!query) {
    // Default to root
    const rootFolder = folders.find(f => f.id === "root");
    return res.json({ found: true, folders: [rootFolder] });
  }
  
  const matches = folders.filter(f => f.name.toLowerCase().includes(query));
  res.json({
    found: matches.length > 0,
    folders: matches,
    log: `Búsqueda en ShareFile para la carpeta: "${query}". Se encontraron ${matches.length} carpetas.`
  });
});

// Step 2: List files in a folder
app.get("/api/sharefile/list-items", (req, res) => {
  const folderId = req.query.folderId as string;
  if (!folderId) {
    return res.status(400).json({ error: "Se requiere folderId" });
  }
  
  const folderFiles = files.filter(f => f.folderId === folderId);
  res.json({
    files: folderFiles.map(f => ({
      id: f.id,
      name: f.name,
      folderId: f.folderId,
      mimeType: f.mimeType,
      size: f.size,
      createdAt: f.createdAt
    })),
    log: `Listado de ShareFile de la carpeta ID "${folderId}". Se encontraron ${folderFiles.length} archivos.`
  });
});

// Step 3 & 4: Download/get specific file
app.get("/api/sharefile/download-file", (req, res) => {
  const fileId = req.query.fileId as string;
  if (!fileId) {
    return res.status(400).json({ error: "Se requiere fileId" });
  }
  
  const file = files.find(f => f.id === fileId);
  if (!file) {
    return res.status(404).json({ error: "Archivo no encontrado" });
  }
  
  res.json({
    file: {
      id: file.id,
      name: file.name,
      folderId: file.folderId,
      mimeType: file.mimeType,
      size: file.size,
      createdAt: file.createdAt,
      base64Data: file.base64Data,
      text: file.text
    },
    log: `Descarga exitosa de ShareFile de: "${file.name}"`
  });
});

// Initialize simulation files with high-quality pre-rendered notes from the frontend
app.post("/api/sharefile/initialize", (req, res) => {
  const { initialFiles } = req.body;
  if (Array.isArray(initialFiles)) {
    // Overwrite or append based on uniqueness
    initialFiles.forEach(newFile => {
      const idx = files.findIndex(f => f.id === newFile.id);
      if (idx !== -1) {
        files[idx] = newFile;
      } else {
        files.push(newFile);
      }
    });
    return res.json({ success: true, count: files.length });
  }
  res.status(400).json({ error: "Datos de inicialización incorrectos" });
});

// Reset files to empty
app.post("/api/sharefile/reset", (req, res) => {
  files = [];
  res.json({ success: true });
});

// Upload a custom file
app.post("/api/sharefile/upload", (req, res) => {
  const { name, folderId, mimeType, base64Data, size, text } = req.body;
  if (!name || !folderId || !base64Data) {
    return res.status(400).json({ error: "Faltan parámetros obligatorios" });
  }

  const newFile = {
    id: `file-custom-${Date.now()}`,
    name,
    folderId,
    mimeType: mimeType || "image/png",
    size: size || Math.round(base64Data.length * 0.75),
    createdAt: new Date().toISOString(),
    base64Data,
    text: text || "Texto manuscrito personalizado"
  };

  files.push(newFile);
  res.json({ success: true, file: newFile });
});

// Lazy-initialized Google Gen AI client
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    return null;
  }
  
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });
  }
  return aiClient;
}

// Step 5: Extract handwriting OCR via Gemini
app.post("/api/ocr", async (req, res) => {
  const { base64Data, mimeType, groundTruthText } = req.body;
  if (!base64Data) {
    return res.status(400).json({ error: "Se requiere la imagen en base64" });
  }

  // Check if Gemini Client is configured
  const ai = getGeminiClient();
  if (!ai) {
    // If not configured, fall back to simulated OCR using ground truth or a generic response
    console.log("No GEMINI_API_KEY detected. Using simulation fallback.");
    return res.json({
      success: true,
      text: groundTruthText || "Nota VIP: Por favor contactar al cliente John Smith en el teléfono (305) 555-0143 lo antes posible.",
      isSimulated: true,
      message: "Procesado mediante simulador OCR local (GEMINI_API_KEY no configurada)."
    });
  }

  try {
    // Strip base64 metadata prefix if exists
    const cleanBase64 = base64Data.split(",")[1] || base64Data;
    const cleanMime = mimeType || "image/png";

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          inlineData: {
            mimeType: cleanMime,
            data: cleanBase64
          }
        },
        "Extrae todo el texto de esta imagen, incluyendo texto manuscrito. Devuelve el texto completo."
      ]
    });

    const textOutput = response.text || "";
    res.json({
      success: true,
      text: textOutput,
      isSimulated: false,
      message: "OCR completado exitosamente con Gemini 3.5 Flash."
    });
  } catch (error: any) {
    console.error("Gemini OCR Error:", error);
    // Fallback on failure
    res.json({
      success: true,
      text: groundTruthText || "Nota VIP: Por favor contactar al cliente John Smith en el teléfono (305) 555-0143 lo antes posible.",
      isSimulated: true,
      errorDetails: error.message,
      message: "OCR completado con el simulador local debido a un error en el servidor de IA."
    });
  }
});

// Full Assistant Step-by-Step execution orchestration API
app.post("/api/execute-assistant", async (req, res) => {
  const { folderName, fileNameContains } = req.body;
  const searchFolderQuery = (folderName || "").trim();
  const searchFileTerm = (fileNameContains || "VIP").trim().toLowerCase();

  const logs: Array<{ timestamp: string; level: string; message: string; payload?: any }> = [];
  const addLog = (level: "info" | "success" | "warning" | "error", message: string, payload?: any) => {
    logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
      payload
    });
  };

  addLog("info", `Iniciando proceso automatizado. Búsqueda de carpeta: "${searchFolderQuery || 'Carpeta Raíz'}", término de archivo: "${searchFileTerm}"`);

  try {
    // Step 1: Search in ShareFile for folder
    addLog("info", `[Paso 1/7] Buscando la carpeta "${searchFolderQuery || 'Raíz'}" en ShareFile...`);
    let matchedFolder = null;

    if (!searchFolderQuery) {
      matchedFolder = folders.find(f => f.id === "root");
      addLog("success", `No se especificó carpeta. Usando la Carpeta Raíz por defecto (ID: ${matchedFolder?.id})`);
    } else {
      const matches = folders.filter(f => f.name.toLowerCase().includes(searchFolderQuery.toLowerCase()));
      if (matches.length === 0) {
        addLog("warning", `No se encontró ninguna carpeta que coincida con "${searchFolderQuery}". Usando la Carpeta Raíz.`);
        matchedFolder = folders.find(f => f.id === "root");
      } else {
        matchedFolder = matches[0];
        addLog("success", `Carpeta localizada: "${matchedFolder.name}" (ID: ${matchedFolder.id})`, matchedFolder);
      }
    }

    if (!matchedFolder) {
      throw new Error("No se pudo resolver ninguna carpeta de origen para iniciar la búsqueda.");
    }

    // Step 2: List files in folder
    addLog("info", `[Paso 2/7] Listando archivos dentro de la carpeta "${matchedFolder.name}" (ID: ${matchedFolder.id})...`);
    const folderFiles = files.filter(f => f.folderId === matchedFolder!.id);
    addLog("success", `Se listaron ${folderFiles.length} archivos en la carpeta.`, folderFiles.map(f => ({ id: f.id, name: f.name })));

    // Step 3: Identify VIP file
    addLog("info", `[Paso 3/7] Buscando archivo que contenga "${searchFileTerm}" en su nombre (insensible a mayúsculas/minúsculas)...`);
    const matchedFiles = folderFiles.filter(f => f.name.toLowerCase().includes(searchFileTerm));
    
    if (matchedFiles.length === 0) {
      addLog("error", `No se encontró ningún archivo que contenga "${searchFileTerm}" en la carpeta "${matchedFolder.name}".`);
      return res.json({
        status: "error",
        phone_number: null,
        message: `No se encontró ningún archivo que contenga "${searchFileTerm}" en la carpeta "${matchedFolder.name}".`,
        logs
      });
    }

    // Choose the first one (or most recent)
    const targetFile = matchedFiles[0];
    addLog("success", `Archivo identificado: "${targetFile.name}" (ID: ${targetFile.id})`, {
      name: targetFile.name,
      id: targetFile.id,
      size: targetFile.size,
      createdAt: targetFile.createdAt
    });

    // Step 4: Download File
    addLog("info", `[Paso 4/7] Descargando el archivo "${targetFile.name}" desde ShareFile...`);
    // Simulated delay or actual file fetch from memory
    addLog("success", `Archivo descargado con éxito. Tamaño: ${targetFile.size} bytes. Tipo de archivo: ${targetFile.mimeType}.`);

    // Step 5: OCR Extraer Texto
    addLog("info", `[Paso 5/7] Procesando imagen mediante OCR. Extrayendo texto manuscrito...`);
    
    // Call our internal OCR service
    let extractedText = "";
    let isSimulatedOCR = true;
    const ai = getGeminiClient();
    if (ai) {
      try {
        const cleanBase64 = targetFile.base64Data.split(",")[1] || targetFile.base64Data;
        const response = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: [
            {
              inlineData: {
                mimeType: targetFile.mimeType,
                data: cleanBase64
              }
            },
            "Extrae todo el texto de esta imagen, incluyendo texto manuscrito. Devuelve el texto completo."
          ]
        });
        extractedText = response.text || "";
        isSimulatedOCR = false;
        addLog("success", `OCR por Inteligencia Artificial completado con éxito (Gemini 3.5 Flash).`, { extractedText });
      } catch (err: any) {
        addLog("warning", `Error al llamar a Gemini: ${err.message}. Usando el texto simulado pre-guardado.`);
        extractedText = targetFile.text;
      }
    } else {
      extractedText = targetFile.text;
      addLog("info", `Se utilizó el motor OCR simulado local (Gemini no configurado).`, { extractedText });
    }

    // Step 6: Find Phone Number
    addLog("info", `[Paso 6/7] Analizando el texto extraído en busca de números de teléfono...`);
    // Regex matches common US and international phone patterns
    // e.g., (123) 456-7890, 123-456-7890, 123.456.7890, +1 123 456 7890, 1234567890, etc.
    const phoneRegex = /(?:\+?(\d{1,3})[-. ]*)?\(?(\d{3})\)?[-. ]*(\d{3})[-. ]*(\d{4})/g;
    const matchesPhone = [...extractedText.matchAll(phoneRegex)];
    
    let phoneNumber: string | null = null;
    if (matchesPhone && matchesPhone.length > 0) {
      // Return the first match clean
      phoneNumber = matchesPhone[0][0];
      addLog("success", `¡Número de teléfono localizado!: ${phoneNumber}`, { matches: matchesPhone.map(m => m[0]) });
    } else {
      // Let's also do a fallback check for any sequence of 7-15 digits with hyphens
      const genericPhoneRegex = /\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g;
      const secondMatch = extractedText.match(genericPhoneRegex);
      if (secondMatch && secondMatch.length > 0) {
        phoneNumber = secondMatch[0];
        addLog("success", `Número de teléfono localizado (formato secundario): ${phoneNumber}`);
      } else {
        addLog("warning", `No se detectó ningún número de teléfono con formato estándar en el texto manuscrito.`);
      }
    }

    // Step 7: Return final result
    addLog("info", `[Paso 7/7] Generando salida JSON estructurada final...`);
    
    if (phoneNumber) {
      addLog("success", `Proceso finalizado con Éxito. Número extraído: ${phoneNumber}`);
      return res.json({
        status: "success",
        phone_number: phoneNumber,
        message: "El número de teléfono fue extraído exitosamente de la imagen manuscrita de ShareFile.",
        logs,
        extracted_text: extractedText,
        file_info: {
          name: targetFile.name,
          folder: matchedFolder.name
        },
        is_simulated_ocr: isSimulatedOCR
      });
    } else {
      addLog("error", `Proceso finalizado. No se encontró ningún número de teléfono.`);
      return res.json({
        status: "error",
        phone_number: null,
        message: "No se encontró ningún número de teléfono en la imagen.",
        logs,
        extracted_text: extractedText,
        file_info: {
          name: targetFile.name,
          folder: matchedFolder.name
        },
        is_simulated_ocr: isSimulatedOCR
      });
    }

  } catch (error: any) {
    addLog("error", `Error crítico en la ejecución del asistente: ${error.message}`);
    res.json({
      status: "error",
      phone_number: null,
      message: `Error durante la ejecución del proceso: ${error.message}`,
      logs
    });
  }
});

// Serve frontend assets
async function startServer() {
  const PORT = 3000;

  // Serve static dist folder in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
