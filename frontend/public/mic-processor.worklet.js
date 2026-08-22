// Roda fora da main thread, num AudioWorkletGlobalScope proprio -- sem acesso
// a closures/refs do React, so o que vier por processorOptions e port.
// Junta as quantums de 128 amostras que o Web Audio entrega em chunks
// maiores (mesmo tamanho do ScriptProcessorNode antigo) antes de mandar
// pra main thread via port.postMessage.
class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkSize = options?.processorOptions?.chunkSize ?? 4096;
    this.buffer = new Float32Array(chunkSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset === this.buffer.length) {
        const chunk = this.buffer.slice(0);
        this.port.postMessage(chunk, [chunk.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
