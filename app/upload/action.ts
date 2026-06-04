"use server";

import { getDb } from "@/lib/db-config";
import { documents } from "@/lib/db-schema";
import { generateEmbeddings } from "@/lib/embeddings";
import { chunkContent } from "@/lib/chunking";

export async function processPdfFile(formData: FormData) {
  try {
    const file = formData.get("pdf") as File;
    if (!file) {
      return { success: false, error: "No PDF file provided." };
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes); 

    
   const pdfParse = require("pdf-parse"); 

    const data = await pdfParse(buffer); 

    if (!data.text || data.text.trim().length === 0) {
      return {
        success: false,
        error: "The uploaded PDF contains no extractable text.",
      };
    }

    const chunks = await chunkContent(data.text);
    const embeddings = await generateEmbeddings(chunks);

    const records = chunks.map((chunk, index) => ({
      content: chunk,
      embedding: embeddings[index],
    }));

    await getDb().insert(documents).values(records);

    return {
      success: true,
      message: `Successfully processed and stored ${records.length} chunks from the PDF.`,
    };
  } catch (error) {
    console.error("Error processing PDF file:", error);
    return {
      success: false,
      error: "An error occurred while processing the PDF file.",
    };
  }
}
