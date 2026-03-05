import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { decode, encode, isSilk } from "silk-wasm";

// ============ 文件就绪等待 ============

/**
 * 等待文件就绪（非空且大小稳定）
 *
 * 解决时序竞争问题：框架 TTS 工具异步生成音频文件，AI 模型拿到路径后
 * 立即输出到 <qqvoice> 标签，但文件可能还没写完（0 bytes 或正在写入中）。
 *
 * 策略：轮询文件大小，当连续两次检测大小相同且 > 0 时视为就绪。
 *
 * @param filePath 文件路径
 * @param timeoutMs 最大等待时间（默认 15 秒，TTS 生成通常需要 2-8 秒）
 * @param pollMs 轮询间隔（默认 300ms）
 * @returns 文件大小（字节），超时或文件始终为空返回 0
 */
export async function waitForFile(filePath: string, timeoutMs: number = 30000, pollMs: number = 500): Promise<number> {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  let fileExists = false;
  let pollCount = 0;

  while (Date.now() - start < timeoutMs) {
    pollCount++;
    try {
      const stat = fs.statSync(filePath);
      if (!fileExists) {
        fileExists = true;
        console.log(`[audio-convert] waitForFile: file appeared (${stat.size} bytes, after ${Date.now() - start}ms): ${path.basename(filePath)}`);
      }
      if (stat.size > 0) {
        if (stat.size === lastSize) {
          stableCount++;
          if (stableCount >= 2) {
            console.log(`[audio-convert] waitForFile: ready (${stat.size} bytes, waited ${Date.now() - start}ms, polls=${pollCount})`);
            return stat.size;
          }
        } else {
          stableCount = 0;
        }
        lastSize = stat.size;
      }
    } catch {
      // 文件可能还不存在，继续等
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  // 超时后最后检查一次
  try {
    const finalStat = fs.statSync(filePath);
    if (finalStat.size > 0) {
      console.warn(`[audio-convert] waitForFile: timeout but file has data (${finalStat.size} bytes), using it`);
      return finalStat.size;
    }
    console.error(`[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file exists but empty (0 bytes): ${path.basename(filePath)}`);
  } catch {
    console.error(`[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file never appeared: ${path.basename(filePath)}`);
  }

  return 0;
}

// ============ ffmpeg 可用性检测 ============

let _ffmpegAvailable: boolean | null = null;

/**
 * 检测系统是否安装了 ffmpeg
 * 结果会缓存，只检测一次
 */
function checkFfmpeg(): Promise<boolean> {
  if (_ffmpegAvailable !== null) return Promise.resolve(_ffmpegAvailable);
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (err) => {
      _ffmpegAvailable = !err;
      if (_ffmpegAvailable) {
        console.log("[audio-convert] ffmpeg detected, using ffmpeg for audio decoding");
      } else {
        console.warn("[audio-convert] ffmpeg not found, falling back to WASM decoders (limited format support)");
      }
      resolve(_ffmpegAvailable);
    });
  });
}

/**
 * 使用 ffmpeg 将任意音频文件转换为 PCM s16le 单声道 24kHz
 *
 * 这是业界标准做法（Discord/Telegram/NapCat/go-cqhttp 均使用 ffmpeg 做前置解码）：
 * - 支持所有主流音频格式（mp3, ogg, opus, aac, flac, wav, wma, m4a...）
 * - 高质量重采样（SoX resampler）
 * - 正确处理各种边界情况（截断文件、非标准头、流式编码等）
 */
function ffmpegToPCM(inputPath: string, sampleRate: number = 24000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-f", "s16le",      // 输出格式: raw PCM signed 16-bit little-endian
      "-ar", String(sampleRate),  // 采样率
      "-ac", "1",          // 单声道
      "-acodec", "pcm_s16le",
      "-v", "error",       // 只输出错误日志
      "pipe:1",            // 输出到 stdout
    ];

    const proc = execFile("ffmpeg", args, {
      maxBuffer: 50 * 1024 * 1024, // 50MB，足以处理大多数语音
      encoding: "buffer" as any,
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${err.message}`));
        return;
      }
      resolve(stdout as unknown as Buffer);
    });
  });
}

// ============ WASM fallback: MP3 解码 ============

/**
 * 使用 mpg123-decoder (WASM) 解码 MP3 为 PCM
 * 仅在 ffmpeg 不可用时作为 fallback
 */
async function wasmDecodeMp3ToPCM(buf: Buffer, targetRate: number): Promise<Buffer | null> {
  try {
    const { MPEGDecoder } = await import("mpg123-decoder");
    console.log(`[audio-convert] WASM MP3 decode: size=${buf.length} bytes`);
    const decoder = new MPEGDecoder();
    await decoder.ready;
    const decoded = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    decoder.free();

    if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
      console.error(`[audio-convert] WASM MP3 decode: no samples (samplesDecoded=${decoded.samplesDecoded})`);
      return null;
    }

    console.log(`[audio-convert] WASM MP3 decode: samples=${decoded.samplesDecoded}, sampleRate=${decoded.sampleRate}, channels=${decoded.channelData.length}`);

    // Float32 多声道混缩为单声道
    let floatMono: Float32Array;
    if (decoded.channelData.length === 1) {
      floatMono = decoded.channelData[0]!;
    } else {
      floatMono = new Float32Array(decoded.samplesDecoded);
      const channels = decoded.channelData.length;
      for (let i = 0; i < decoded.samplesDecoded; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += decoded.channelData[ch]![i]!;
        }
        floatMono[i] = sum / channels;
      }
    }

    // Float32 → s16le
    const s16 = new Uint8Array(floatMono.length * 2);
    const view = new DataView(s16.buffer);
    for (let i = 0; i < floatMono.length; i++) {
      const clamped = Math.max(-1, Math.min(1, floatMono[i]!));
      const val = clamped < 0 ? clamped * 32768 : clamped * 32767;
      view.setInt16(i * 2, Math.round(val), true);
    }

    // 简单线性插值重采样（仅 fallback 时使用，质量不如 ffmpeg）
    let pcm: Uint8Array = s16;
    if (decoded.sampleRate !== targetRate) {
      const inputSamples = s16.length / 2;
      const outputSamples = Math.round(inputSamples * targetRate / decoded.sampleRate);
      const output = new Uint8Array(outputSamples * 2);
      const inView = new DataView(s16.buffer, s16.byteOffset, s16.byteLength);
      const outView = new DataView(output.buffer, output.byteOffset, output.byteLength);
      for (let i = 0; i < outputSamples; i++) {
        const srcIdx = i * decoded.sampleRate / targetRate;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, inputSamples - 1);
        const frac = srcIdx - idx0;
        const s0 = inView.getInt16(idx0 * 2, true);
        const s1 = inView.getInt16(idx1 * 2, true);
        const sample = Math.round(s0 + (s1 - s0) * frac);
        outView.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
      }
      pcm = output;
    }

    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  } catch (err) {
    console.error(`[audio-convert] WASM MP3 decode failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(`[audio-convert] stack: ${err.stack}`);
    }
    return null;
  }
}

// ============ SILK 相关基础函数 ============

/**
 * 去除 QQ 语音文件的 AMR 头（如果存在）
 * QQ 的 .amr 文件可能在 SILK 数据前有 "#!AMR\n" 头（6 字节）
 */
function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/**
 * 将 PCM (s16le) 数据封装为 WAV 文件格式
 * WAV = 44 字节 RIFF 头 + PCM 原始数据
 */
function pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

// ============ 格式列表标准化 ============

/**
 * 标准化音频格式列表（统一为 ".xxx" 小写格式）
 * 供入站 STT 和出站上传共用
 */
export function normalizeFormats(formats?: string[]): string[] {
  if (!formats?.length) return [];
  return formats.map(f => f.startsWith(".") ? f.toLowerCase() : `.${f.toLowerCase()}`);
}

// ============ 入站：SILK → WAV ============

/**
 * 将 SILK/AMR 语音文件转换为 WAV 格式（用于 STT）
 * @param sttDirectFormats - STT 模型直接支持的格式列表，匹配时跳过转换，直接返回原始路径
 */
export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
  sttDirectFormats?: string[],
): Promise<{ wavPath: string; duration: number; skipped?: boolean } | null> {
  if (!fs.existsSync(inputPath)) return null;

  const ext = path.extname(inputPath).toLowerCase();

  // 如果 STT 模型直接支持该格式，跳过转换
  const normalized = normalizeFormats(sttDirectFormats);
  if (normalized.includes(ext)) {
    console.log(`[audio-convert] STT direct format (skip SILK→WAV): ${ext}`);
    return { wavPath: inputPath, duration: 0, skipped: true };
  }

  const fileBuf = fs.readFileSync(inputPath);
  const strippedBuf = stripAmrHeader(fileBuf);
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  if (!isSilk(rawData)) return null;

  const sampleRate = 24000;
  const result = await decode(rawData, sampleRate);
  const wavBuffer = pcmToWav(result.data, sampleRate);

  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}

// ============ 工具函数 ============

export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) return true;
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".amr", ".silk", ".slk", ".slac"].includes(ext);
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}分${remainSeconds}秒` : `${minutes}分钟`;
}

export function isAudioFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".silk", ".slk", ".amr", ".wav", ".mp3", ".ogg", ".opus", ".aac", ".flac", ".m4a", ".wma", ".pcm"].includes(ext);
}

// ============ TTS（文字转语音）============

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null {
  const c = cfg as any;

  // 优先使用 channels.qqbot.tts（插件专属配置）
  const channelTts = c?.channels?.qqbot?.tts;
  if (channelTts && channelTts.enabled !== false) {
    const providerId: string = channelTts?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = channelTts?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = channelTts?.apiKey || providerCfg?.apiKey;
    const model: string = channelTts?.model || "tts-1";
    const voice: string = channelTts?.voice || "alloy";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model, voice };
    }
  }

  // 回退到 messages.tts（openclaw 框架级 TTS 配置）
  const msgTts = c?.messages?.tts;
  if (msgTts && msgTts.auto !== "disabled") {
    const providerId: string = msgTts?.provider || "openai";
    const providerBlock = msgTts?.[providerId];  // messages.tts.openai / messages.tts.xxx
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = providerBlock?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = providerBlock?.apiKey || providerCfg?.apiKey;
    const model: string = providerBlock?.model || "tts-1";
    const voice: string = providerBlock?.voice || "alloy";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model, voice };
    }
  }

  return null;
}

export async function textToSpeechPCM(
  text: string,
  ttsCfg: TTSConfig,
): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  const sampleRate = 24000;

  const resp = await fetch(`${ttsCfg.baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ttsCfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ttsCfg.model,
      input: text,
      voice: ttsCfg.voice,
      response_format: "pcm",
      sample_rate: sampleRate,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`TTS failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return { pcmBuffer: Buffer.from(arrayBuffer), sampleRate };
}

export async function pcmToSilk(
  pcmBuffer: Buffer,
  sampleRate: number,
): Promise<{ silkBuffer: Buffer; duration: number }> {
  const pcmData = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const result = await encode(pcmData, sampleRate);
  return {
    silkBuffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    duration: result.duration,
  };
}

export async function textToSilk(
  text: string,
  ttsCfg: TTSConfig,
  outputDir: string,
): Promise<{ silkPath: string; silkBase64: string; duration: number }> {
  const { pcmBuffer, sampleRate } = await textToSpeechPCM(text, ttsCfg);
  const { silkBuffer, duration } = await pcmToSilk(pcmBuffer, sampleRate);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const silkPath = path.join(outputDir, `tts-${Date.now()}.silk`);
  fs.writeFileSync(silkPath, silkBuffer);

  return { silkPath, silkBase64: silkBuffer.toString("base64"), duration };
}

// ============ 核心：任意音频 → SILK Base64 ============

/** QQ Bot API 原生支持上传的音频格式（无需转换为 SILK） */
const QQ_NATIVE_UPLOAD_FORMATS = [".wav", ".mp3", ".silk"];

/**
 * 将本地音频文件转换为 QQ Bot 可上传的 Base64
 *
 * QQ Bot API 支持直传 WAV、MP3、SILK 三种格式，其他格式仍需转换。
 * 转换策略（参考 NapCat/go-cqhttp/Discord/Telegram 的做法）：
 *
 * 1. WAV / MP3 / SILK → 直传（跳过转换）
 * 2. 有 ffmpeg → ffmpeg 万能解码为 PCM → silk-wasm 编码
 *    支持: ogg, opus, aac, flac, wma, m4a, pcm 等所有 ffmpeg 支持的格式
 * 3. 无 ffmpeg → WASM fallback（仅支持 pcm, wav）
 *
 * @param directUploadFormats - 自定义直传格式列表，覆盖默认值。传 undefined 使用 QQ_NATIVE_UPLOAD_FORMATS
 */
export async function audioFileToSilkBase64(filePath: string, directUploadFormats?: string[]): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    console.error(`[audio-convert] file is empty: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();

  // 0. 直传判断：QQ Bot API 原生支持 WAV/MP3/SILK，可通过配置覆盖
  const uploadFormats = directUploadFormats ? normalizeFormats(directUploadFormats) : QQ_NATIVE_UPLOAD_FORMATS;
  if (uploadFormats.includes(ext)) {
    console.log(`[audio-convert] direct upload (QQ native format): ${ext} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  // 1. .slk / .amr 扩展名 → 检测 SILK 魔数，是 SILK 则直传
  if ([".slk", ".slac"].includes(ext)) {
    const stripped = stripAmrHeader(buf);
    const raw = new Uint8Array(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    if (isSilk(raw)) {
      console.log(`[audio-convert] SILK file, direct use: ${filePath} (${buf.length} bytes)`);
      return buf.toString("base64");
    }
  }

  // 按文件头检测 SILK（不依赖扩展名）
  const rawCheck = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const strippedCheck = stripAmrHeader(buf);
  const strippedRaw = new Uint8Array(strippedCheck.buffer, strippedCheck.byteOffset, strippedCheck.byteLength);
  if (isSilk(rawCheck) || isSilk(strippedRaw)) {
    console.log(`[audio-convert] SILK detected by header: ${filePath} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  const targetRate = 24000;

  // 2. 优先使用 ffmpeg（业界标准做法）
  const hasFfmpeg = await checkFfmpeg();
  if (hasFfmpeg) {
    try {
      console.log(`[audio-convert] ffmpeg: converting ${ext} (${buf.length} bytes) → PCM s16le ${targetRate}Hz`);
      const pcmBuf = await ffmpegToPCM(filePath, targetRate);
      if (pcmBuf.length === 0) {
        console.error(`[audio-convert] ffmpeg produced empty PCM output`);
        return null;
      }
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      console.log(`[audio-convert] ffmpeg: ${ext} → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    } catch (err) {
      console.error(`[audio-convert] ffmpeg conversion failed: ${err instanceof Error ? err.message : String(err)}`);
      // ffmpeg 失败后不 return，继续尝试 WASM fallback
    }
  }

  // 3. WASM fallback（无 ffmpeg 时的降级方案）
  console.log(`[audio-convert] fallback: trying WASM decoders for ${ext}`);

  // 3a. PCM：视为 s16le 24000Hz 单声道
  if (ext === ".pcm") {
    const pcmBuf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
    return silkBuffer.toString("base64");
  }

  // 3b. WAV：手动解析（仅支持标准 PCM WAV）
  if (ext === ".wav" || (buf.length >= 4 && buf.toString("ascii", 0, 4) === "RIFF")) {
    const wavInfo = parseWavFallback(buf);
    if (wavInfo) {
      const { silkBuffer } = await pcmToSilk(wavInfo, targetRate);
      return silkBuffer.toString("base64");
    }
  }

  // 3c. MP3：WASM 解码
  if (ext === ".mp3" || ext === ".mpeg") {
    const pcmBuf = await wasmDecodeMp3ToPCM(buf, targetRate);
    if (pcmBuf) {
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      console.log(`[audio-convert] WASM: MP3 → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    }
  }

  console.error(`[audio-convert] unsupported format: ${ext} (no ffmpeg available). Install ffmpeg for full format support.`);
  return null;
}

/**
 * WAV fallback 解析（无 ffmpeg 时使用）
 * 仅支持标准 PCM WAV (format=1, 16bit)
 */
function parseWavFallback(buf: Buffer): Buffer | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  if (buf.toString("ascii", 12, 16) !== "fmt ") return null;

  const audioFormat = buf.readUInt16LE(20);
  if (audioFormat !== 1) return null;

  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) return null;

  // 找 data chunk
  let offset = 36;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buf.length);
      let pcm = new Uint8Array(buf.buffer, buf.byteOffset + dataStart, dataEnd - dataStart);

      // 多声道混缩
      if (channels > 1) {
        const samplesPerCh = pcm.length / (2 * channels);
        const mono = new Uint8Array(samplesPerCh * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
        for (let i = 0; i < samplesPerCh; i++) {
          let sum = 0;
          for (let ch = 0; ch < channels; ch++) sum += inV.getInt16((i * channels + ch) * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
        }
        pcm = mono;
      }

      // 简单线性插值重采样
      const targetRate = 24000;
      if (sampleRate !== targetRate) {
        const inSamples = pcm.length / 2;
        const outSamples = Math.round(inSamples * targetRate / sampleRate);
        const out = new Uint8Array(outSamples * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(out.buffer, out.byteOffset, out.byteLength);
        for (let i = 0; i < outSamples; i++) {
          const src = i * sampleRate / targetRate;
          const i0 = Math.floor(src);
          const i1 = Math.min(i0 + 1, inSamples - 1);
          const f = src - i0;
          const s0 = inV.getInt16(i0 * 2, true);
          const s1 = inV.getInt16(i1 * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))), true);
        }
        pcm = out;
      }

      return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    offset += 8 + chunkSize;
  }

  return null;
}
