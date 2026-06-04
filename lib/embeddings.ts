import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function generateEmbedding(text: string): Promise<number[]> {
  const input = text.replace(/\n/g, " ");

  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input,
  });

  return response.data[0].embedding;
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const inputs = texts.map(t => t.replace(/\n/g, " "));

  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: inputs, // array = ONE API CALL
  });

  return response.data.map(item => item.embedding);
}



