export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db-config";
import { documents } from "@/lib/db-schema";
import { generateEmbeddings } from "@/lib/embeddings";
import { chunkContent } from "@/lib/chunking";

// ✅ IMPORTANT: legacy build
const pdfParse = require("pdf-parse/lib/pdf-parse");

export async function POST(req: NextRequest) {
  try {
    console.log("📄 /api/upload called");

    const formData = await req.formData();
    const file = formData.get("pdf") as File;

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No PDF provided" },
        { status: 400 }
      );
    }

    // Convert to buffer
    const buffer = Buffer.from(await file.arrayBuffer());

    // Extract text
    const data = await pdfParse(buffer);

    if (!data.text || !data.text.trim()) {
      return NextResponse.json(
        { success: false, error: "No extractable text in PDF" },
        { status: 400 }
      );
    }

    // Chunk
    const chunks = await chunkContent(data.text);

    // Embeddings
    const embeddings = await generateEmbeddings(chunks);

    // Save to DB
    await db.insert(documents).values(
      chunks.map((chunk, i) => ({
        content: chunk,
        embedding: embeddings[i],
      }))
    );

    return NextResponse.json({
      success: true,
      message: `Stored ${chunks.length} chunks`,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to process PDF" },
      { status: 500 }
    );
  }
}
