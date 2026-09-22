import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'

export const  textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1500,
  chunkOverlap: 150,
  separators: ['\n\n', '\n', '. '],
});

export async function chunkContent(pdfContent: string): Promise<string[]> {
  const docs = await textSplitter.splitText(pdfContent.trim());
  return docs
}