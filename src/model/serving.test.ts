import { describe, expect, it } from 'vitest';
import { nvlPods } from '../fixtures.js';
import { commandWords, servedBy, servedModels, shellWords, shortName } from './serving.js';

describe('reading a command line', () => {
    it('splits a shell line the way sh would', () => {
        expect(shellWords(`exec vllm serve "Qwen/Qwen3 8B" --x='a b' c\\ d`)).toEqual(['exec', 'vllm', 'serve', 'Qwen/Qwen3 8B', '--x=a b', 'c d']);
    });

    it('opens a sh -c script and fills in $(VAR) from the env', () => {
        expect(commandWords({ command: ['/bin/sh', '-c'], args: ['vllm serve "$(MODEL)" --tp ${TP}'], env: [{ name: 'MODEL', value: 'a/b' }, { name: 'TP', value: '2' }] })).toEqual(['vllm', 'serve', 'a/b', '--tp', '2']);
    });
});

describe('which model a server serves', () => {
    it('reads the three vLLM command lines people write', () => {
        const served = servedModels(nvlPods);
        expect(served.map((s) => [shortName(s), s.model, s.tensorParallel])).toEqual([
            ['nhn-large', 'openai/gpt-oss-120b', 1],
            ['nhn-medium', 'ornith-ai/Ornith-1.5-35B-A3B-FP8', 2],
            ['nhn-coder', 'Qwen/Qwen3.8-27B-FP8', 1],
        ]);
        expect(served.every((s) => s.engine === 'vLLM')).toBe(true);
        expect(served[0]?.maxModelLen).toBe('131072');
        expect(served[1]?.quantization).toBe('fp8');
    });

    it('names a model by its last path segment when no served name is given', () => {
        expect(shortName({ ...servedBy({ image: 'vllm/vllm-openai', args: ['--model', 'meta-llama/Llama-3.1-8B'] })!, namespace: '', pod: '', node: '', running: true })).toBe('Llama-3.1-8B');
    });

    it('reads SGLang, TGI, llama.cpp, NIM and TensorRT-LLM', () => {
        expect(servedBy({ image: 'lmsysorg/sglang:latest', command: ['python3', '-m', 'sglang.launch_server'], args: ['--model-path', 'deepseek-ai/DeepSeek-V3', '--tp', '8'] })).toMatchObject({ engine: 'SGLang', model: 'deepseek-ai/DeepSeek-V3', tensorParallel: 8 });
        expect(servedBy({ image: 'ghcr.io/huggingface/text-generation-inference:3.0', env: [{ name: 'MODEL_ID', value: 'mistralai/Mistral-7B' }], args: ['--num-shard', '2'] })).toMatchObject({ engine: 'TGI', model: 'mistralai/Mistral-7B', tensorParallel: 2 });
        expect(servedBy({ image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', args: ['-hf', 'ggml-org/gemma-3-4b-it-GGUF', '--alias', 'gemma'] })).toMatchObject({ engine: 'llama.cpp', model: 'ggml-org/gemma-3-4b-it-GGUF', names: ['gemma'] });
        expect(servedBy({ image: 'nvcr.io/nim/meta/llama-3.1-8b-instruct:1.8.0' })).toMatchObject({ engine: 'NIM', model: 'meta/llama-3.1-8b-instruct' });
        expect(servedBy({ image: 'nvcr.io/nvidia/tensorrt-llm/release:1.0', command: ['trtllm-serve', 'Qwen/Qwen3-32B', '--tp_size', '4'] })).toMatchObject({ engine: 'TensorRT-LLM', model: 'Qwen/Qwen3-32B', tensorParallel: 4 });
    });

    it('says an Ollama server pulls its models at run time, and ignores what is not a server', () => {
        expect(servedBy({ image: 'ollama/ollama:0.12' })).toMatchObject({ engine: 'Ollama', model: '', names: [] });
        expect(servedBy({ image: 'nginx:1.29' })).toBeUndefined();
    });
});
