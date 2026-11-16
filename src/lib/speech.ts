import type { SystemVoice } from "../types";

/** Turns a Markdown reply into short plain-text passages a voice can read. */
export function speechChunks(markdown: string): string[] {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, "\nCode omitted.\n")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ")
    .replace(/\|/g, ", ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/[*_`#>~]/g, "");
  const chunks: string[] = [];
  for (const paragraph of plain.split(/\n+/)) {
    let current = "";
    for (const sentence of paragraph.trim().split(/(?<=[.!?])\s+/)) {
      if (current && current.length + sentence.length > 220) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks;
}

/** The chosen voice, or the most natural English voice installed on this Mac. */
export function pickVoice(voices: SystemVoice[], name: string): SystemVoice | null {
  return voices.find((voice) => voice.name === name)
    ?? voices.find((voice) => /premium/i.test(voice.name))
    ?? voices.find((voice) => /enhanced/i.test(voice.name))
    ?? voices.find((voice) => /^(Samantha|Ava|Zoe|Daniel)\b/.test(voice.name))
    ?? voices[0]
    ?? null;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read microphone audio."));
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}
