import type { MonitorSequenceSpec, MonitorVideoLayer } from "./composition";

const GPU_BUFFER_USAGE_COPY_DST = 0x8;
const GPU_BUFFER_USAGE_UNIFORM = 0x40;

type GpuObjects = {
  context: any;
  device: any;
  pipeline: any;
  sampler: any;
  presentationFormat: string;
};

export interface RenderVideoLayer {
  spec: MonitorVideoLayer;
  frame: VideoFrame;
}

const UNIFORM_FLOATS = 16;

function containScale(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): [number, number] {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return [1, 1];
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  if (sourceAspect > targetAspect) {
    return [1, targetAspect / sourceAspect];
  }
  return [sourceAspect / targetAspect, 1];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(value: string): { r: number; g: number; b: number; a: number } {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(input)) {
    return {
      r: parseInt(input[1] + input[1], 16) / 255,
      g: parseInt(input[2] + input[2], 16) / 255,
      b: parseInt(input[3] + input[3], 16) / 255,
      a: 1,
    };
  }
  if (/^#[0-9a-f]{6}$/.test(input)) {
    return {
      r: parseInt(input.slice(1, 3), 16) / 255,
      g: parseInt(input.slice(3, 5), 16) / 255,
      b: parseInt(input.slice(5, 7), 16) / 255,
      a: 1,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function resolveCropPixels(value: number, dimension: number): number {
  if (value <= 0) return 0;
  if (value < 1) return value * dimension;
  return value;
}

function describeErrorLike(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(value ?? "Errore sconosciuto");
}

function isDetachedVideoFrameError(value: unknown): boolean {
  const message = describeErrorLike(value).toLowerCase();
  return message.includes("back resource");
}

function releaseRenderLayerFrames(layers: RenderVideoLayer[]): void {
  for (const layer of layers) {
    try {
      layer.frame.close();
    } catch {
      // Ignore already-released frames.
    }
  }
}

function layerUniforms(sequence: MonitorSequenceSpec, layer: RenderVideoLayer): Float32Array {
  const frameWidth = Math.max(1, layer.frame.displayWidth || layer.frame.codedWidth || layer.spec.sourceWidth);
  const frameHeight = Math.max(1, layer.frame.displayHeight || layer.frame.codedHeight || layer.spec.sourceHeight);
  const crop = layer.spec.transform.crop;
  const cropLeft = clamp(resolveCropPixels(crop.left, frameWidth), 0, frameWidth - 1);
  const cropRight = clamp(resolveCropPixels(crop.right, frameWidth), 0, frameWidth - cropLeft - 1);
  const cropTop = clamp(resolveCropPixels(crop.top, frameHeight), 0, frameHeight - 1);
  const cropBottom = clamp(resolveCropPixels(crop.bottom, frameHeight), 0, frameHeight - cropTop - 1);
  const visibleWidth = Math.max(1, frameWidth - cropLeft - cropRight);
  const visibleHeight = Math.max(1, frameHeight - cropTop - cropBottom);
  const [baseScaleX, baseScaleY] = containScale(
    visibleWidth,
    visibleHeight,
    sequence.width,
    sequence.height,
  );
  const userScale = Math.max(0.001, layer.spec.transform.scale || 1);
  const translateX = (2 * (layer.spec.transform.x || 0)) / sequence.width;
  const translateY = (-2 * (layer.spec.transform.y || 0)) / sequence.height;
  const radians = (layer.spec.transform.rotation || 0) * (Math.PI / 180);

  return new Float32Array([
    baseScaleX * userScale,
    baseScaleY * userScale,
    translateX,
    translateY,
    cropLeft / frameWidth,
    cropTop / frameHeight,
    visibleWidth / frameWidth,
    visibleHeight / frameHeight,
    Math.cos(radians),
    Math.sin(radians),
    clamp(layer.spec.transform.opacity ?? 1, 0, 1),
    0,
    0,
    0,
    0,
    0,
  ]);
}

export class MonitorWebGpuRenderer {
  private gpuObjects: GpuObjects | null = null;
  private uncapturedErrorHandler: ((event: any) => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError?: (error: Error) => void,
  ) {}

  async initialize(sequence: MonitorSequenceSpec): Promise<void> {
    const gpu = (navigator as Navigator & {
      gpu?: {
        requestAdapter: () => Promise<any>;
        getPreferredCanvasFormat: () => string;
      };
    }).gpu;
    if (!gpu) {
      throw new Error("WebGPU non disponibile");
    }
    const context = this.canvas.getContext("webgpu") as any;
    if (!context) {
      throw new Error("GPUCanvasContext non disponibile");
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      throw new Error("GPU adapter non disponibile");
    }
    const device = await adapter.requestDevice();
    const presentationFormat = gpu.getPreferredCanvasFormat();
    this.uncapturedErrorHandler = (event: any) => {
      const error = new Error(describeErrorLike(event?.error ?? "Errore WebGPU non gestito"));
      this.onError?.(error);
    };
    device.addEventListener?.("uncapturederror", this.uncapturedErrorHandler);
    device.lost?.then?.((info: any) => {
      this.onError?.(new Error(`Device WebGPU perso: ${info?.message ?? "motivo sconosciuto"}`));
    });
    context.configure({
      device,
      format: presentationFormat,
      alphaMode: "opaque",
    });
    const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: device.createShaderModule({
          code: `
            struct LayerUniforms {
              scale: vec2f,
              translate: vec2f,
              uv_origin: vec2f,
              uv_scale: vec2f,
              rotation: vec2f,
              opacity: f32,
              _pad0: f32,
              _pad1: vec2f,
            };
            struct VertexOut {
              @builtin(position) position: vec4f,
              @location(0) uv: vec2f,
              @location(1) opacity: f32,
            };
            @group(0) @binding(0) var<uniform> uniforms: LayerUniforms;

            @vertex
            fn main(@builtin(vertex_index) index: u32) -> VertexOut {
              var quad = array<vec2f, 6>(
                vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
              );
              var uv = array<vec2f, 6>(
                vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
                vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
              );
              let scaled = quad[index] * uniforms.scale;
              let rotated = vec2f(
                scaled.x * uniforms.rotation.x - scaled.y * uniforms.rotation.y,
                scaled.x * uniforms.rotation.y + scaled.y * uniforms.rotation.x
              );
              var out: VertexOut;
              out.position = vec4f(rotated + uniforms.translate, 0.0, 1.0);
              out.uv = uniforms.uv_origin + (uv[index] * uniforms.uv_scale);
              out.opacity = uniforms.opacity;
              return out;
            }
          `,
        }),
        entryPoint: "main",
      },
      fragment: {
        module: device.createShaderModule({
          code: `
            @group(0) @binding(1) var frameSampler: sampler;
            @group(0) @binding(2) var frameTexture: texture_external;

            @fragment
            fn main(
              @location(0) uv: vec2f,
              @location(1) opacity: f32,
            ) -> @location(0) vec4f {
              let color = textureSampleBaseClampToEdge(frameTexture, frameSampler, uv);
              return vec4f(color.rgb, color.a * opacity);
            }
          `,
        }),
        entryPoint: "main",
        targets: [{
          format: presentationFormat,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.canvas.width = sequence.width;
    this.canvas.height = sequence.height;
    this.gpuObjects = {
      context,
      device,
      pipeline,
      sampler,
      presentationFormat,
    };
  }

  resize(sequence: MonitorSequenceSpec): void {
    if (!this.gpuObjects) return;
    this.canvas.width = sequence.width;
    this.canvas.height = sequence.height;
    this.gpuObjects.context.configure({
      device: this.gpuObjects.device,
      format: this.gpuObjects.presentationFormat,
      alphaMode: "opaque",
    });
  }

  render(sequence: MonitorSequenceSpec, layers: RenderVideoLayer[]): void {
    if (!this.gpuObjects) {
      releaseRenderLayerFrames(layers);
      return;
    }
    const background = parseHexColor(sequence.background);
    const { device, context, pipeline, sampler } = this.gpuObjects;
    let released = false;
    const releaseLayers = () => {
      if (released) return;
      released = true;
      releaseRenderLayerFrames(layers);
    };
    try {
      device.pushErrorScope?.("validation");
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: background,
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      for (const layer of layers) {
        try {
          const uniformBuffer = device.createBuffer({
            size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
          });
          device.queue.writeBuffer(
            uniformBuffer,
            0,
            layerUniforms(sequence, layer),
          );
          const externalTexture = device.importExternalTexture({
            source: layer.frame,
          });
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: externalTexture },
            ],
          });
          pass.setBindGroup(0, bindGroup);
          pass.draw(6);
        } catch (error) {
          if (isDetachedVideoFrameError(error)) continue;
          this.onError?.(new Error(describeErrorLike(error)));
        }
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (typeof device.queue.onSubmittedWorkDone === "function") {
        void device.queue.onSubmittedWorkDone().finally(releaseLayers);
      } else {
        requestAnimationFrame(releaseLayers);
      }
      void device.popErrorScope?.().then((error: unknown) => {
        if (!error) return;
        this.onError?.(new Error(describeErrorLike(error)));
      });
    } catch (error) {
      releaseLayers();
      this.onError?.(new Error(describeErrorLike(error)));
    }
  }

  destroy(): void {
    if (this.gpuObjects?.device && this.uncapturedErrorHandler) {
      this.gpuObjects.device.removeEventListener?.("uncapturederror", this.uncapturedErrorHandler);
    }
    this.uncapturedErrorHandler = null;
    this.gpuObjects = null;
  }
}
