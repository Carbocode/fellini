import { EncodedPacketSink, Input, MP4, QTFF, UrlSource } from "mediabunny";

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

export async function extractVideoThumbnail(url: string, maxWidth = 240): Promise<string | null> {
  if (cache.has(url)) return cache.get(url)!;
  if (inFlight.has(url)) return inFlight.get(url)!;

  const promise = _extract(url, maxWidth).then((result) => {
    cache.set(url, result);
    inFlight.delete(url);
    return result;
  });

  inFlight.set(url, promise);
  return promise;
}

async function _extract(url: string, maxWidth: number): Promise<string | null> {
  const input = new Input({
    source: new UrlSource(url, { requestInit: { cache: "force-cache" } }),
    formats: [MP4, QTFF],
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;

    const decoderConfig = await videoTrack.getDecoderConfig();
    if (!decoderConfig?.codec) return null;

    const sink = new EncodedPacketSink(videoTrack);
    const keyPacket = await sink.getFirstKeyPacket({ verifyKeyPackets: false });
    if (!keyPacket) return null;

    return await new Promise<string | null>((resolve) => {
      let done = false;

      const decoder = new VideoDecoder({
        output: (frame) => {
          if (done) { frame.close(); return; }
          done = true;

          const w = Math.min(maxWidth, frame.displayWidth);
          const h = Math.round(w * (frame.displayHeight / frame.displayWidth));
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext("2d");
          if (!ctx) { frame.close(); resolve(null); return; }

          ctx.drawImage(frame, 0, 0, w, h);
          frame.close();

          canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 }).then((blob) => {
            resolve(URL.createObjectURL(blob));
          }).catch(() => resolve(null));

          try { decoder.close(); } catch { /* ignore */ }
        },
        error: () => {
          if (!done) { done = true; resolve(null); }
        },
      });

      try {
        decoder.configure(decoderConfig);
        decoder.decode(new EncodedVideoChunk({
          type: "key",
          timestamp: keyPacket.microsecondTimestamp,
          duration: keyPacket.microsecondDuration > 0 ? keyPacket.microsecondDuration : 1,
          data: keyPacket.data,
        }));
        decoder.flush().catch(() => {
          if (!done) { done = true; resolve(null); }
        });
      } catch {
        if (!done) { done = true; resolve(null); }
      }
    });
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}
