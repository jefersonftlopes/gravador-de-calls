// Base64 sem FileReader e sem Array.from (usado no MAIN world, no SW e no offscreen).

const STEP = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[])
  }
  return btoa(bin)
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function base64ToBlob(b64: string, type: string): Blob {
  return new Blob([base64ToBytes(b64)], { type })
}
