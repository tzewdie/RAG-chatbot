import OpenAI from "openai";

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
  return new OpenAI({ apiKey });
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const input = text.replace(/\n/g, " ");

  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input,
  });

  return response.data[0].embedding;
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const inputs = texts.map(t => t.replace(/\n/g, " "));

  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: inputs,
  });

  return response.data.map(item => item.embedding);
}



