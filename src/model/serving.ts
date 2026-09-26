// Which models the GPUs are serving, read from the pods that serve them.
//
// An inference server says what it serves on its command line: `vllm serve
// openai/gpt-oss-120b --served-model-name nhn-large --tensor-parallel-size 2`.
// That is in the pod's spec, so the API already knows which model a card is
// holding in its memory -- nothing needs to ask the server. This reads the
// command lines of the servers people run on GPUs in Kubernetes:
//
//   vLLM            `vllm serve <model>`, or --model; --served-model-name,
//                   --tensor-parallel-size / -tp, --pipeline-parallel-size,
//                   --max-model-len, --quantization, --gpu-memory-utilization
//   SGLang          --model-path, --served-model-name, --tp-size
//   TGI             --model-id (or MODEL_ID), --num-shard
//   TensorRT-LLM    `trtllm-serve <model>`, --tp_size
//   llama.cpp       -m / --model, -hf / --hf-repo, --alias
//   NVIDIA NIM      the image (nvcr.io/nim/meta/llama-3.1-8b-instruct), or NIM_MODEL_NAME
//   KServe          --model_id, --model_name (its Hugging Face server)
//   Triton          --model-repository
//   Ollama          pulls its models at run time: named as a server, not a model
//
// A command line may be a shell script (`sh -c "vllm serve …"`), and may use
// `$(MODEL)` to take a value from the container's env; both are followed.
// Only literal env values are read -- one from a Secret or a ConfigMap is
// not in the pod's spec to read.

import { current } from './dcgm.js';
import { isLive, type Container, type Pod } from './kube.js';

export type Engine = 'vLLM' | 'SGLang' | 'TGI' | 'TensorRT-LLM' | 'llama.cpp' | 'NIM' | 'KServe' | 'Triton' | 'Ollama';

export interface Served {
    namespace: string;
    pod: string;
    node: string;
    container: string;
    engine: Engine;
    /** Where the weights come from: a Hugging Face id, a path, an image. '' when the server pulls them at run time. */
    model: string;
    /** The names clients ask for it by ("nhn-large"); the model itself when none is set. */
    names: string[];
    tensorParallel: number;
    pipelineParallel: number;
    maxModelLen: string;
    quantization: string;
    gpuMemoryUtilization: string;
    running: boolean;
}

/** Splits a shell command line into words, the way sh would for the common cases: quotes, escapes. */
export function shellWords(line: string): string[] {
    const words: string[] = [];
    let word = '';
    let has = false;
    let quote: '' | '"' | "'" = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i] as string;
        if (quote) {
            if (c === quote) quote = '';
            else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
            else word += c;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            has = true;
        } else if (c === '\\' && i + 1 < line.length) {
            const next = line[++i] as string;
            if (next !== '\n') {
                word += next;
                has = true;
            }
        } else if (/\s/.test(c) || c === ';' || c === '&' || c === '|') {
            if (has || word) words.push(word);
            word = '';
            has = false;
        } else {
            word += c;
            has = true;
        }
    }
    if (has || word) words.push(word);
    return words;
}

/** A container's command line as words, with a `sh -c` script opened up and env references filled in. */
export function commandWords(container: Container): string[] {
    const env = new Map((container.env ?? []).filter((e) => e.name && e.value !== undefined).map((e) => [e.name as string, e.value as string]));
    const expand = (word: string) =>
        word
            .replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (whole, name: string) => env.get(name) ?? whole)
            .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a: string | undefined, b: string | undefined) => env.get(a ?? b ?? '') ?? whole);
    let words = [...(container.command ?? []), ...(container.args ?? [])];
    // `sh -c "<script>"`, `bash -lc "<script>"`: the script is where the command is.
    const shell = words.findIndex((w, i) => /^-[a-z]*c$/.test(w) && i > 0 && /(^|\/)(ba|z|da)?sh$/.test(words[i - 1] ?? ''));
    if (shell >= 0) words = [...words.slice(0, shell - 1), ...shellWords(words.slice(shell + 1).join(' '))];
    else if (words.length === 1 && /\s/.test(words[0] ?? '')) words = shellWords(words[0] ?? '');
    return words.map(expand).filter((w) => w !== '');
}

/** The values of a flag: `--x v`, `--x=v`; several values for a flag that takes a list. */
function flag(words: string[], names: string[], many = false): string[] {
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i] as string;
        for (const name of names) {
            if (word === name) {
                for (let j = i + 1; j < words.length && !(words[j] as string).startsWith('-'); j++) {
                    out.push(words[j] as string);
                    if (!many) break;
                }
            } else if (word.startsWith(`${name}=`)) {
                out.push(word.slice(name.length + 1));
            }
        }
    }
    return out;
}

function first(words: string[], names: string[]): string {
    return flag(words, names)[0] ?? '';
}

/** The first word after `word` that is not a flag: `vllm serve <model>`. */
function positionalAfter(words: string[], word: RegExp): string {
    const at = words.findIndex((w) => word.test(w));
    if (at < 0) return '';
    const next = words[at + 1];
    return next && !next.startsWith('-') ? next : '';
}

function envValue(container: Container, ...names: string[]): string {
    for (const name of names) {
        const value = container.env?.find((e) => e.name === name)?.value;
        if (value) return value;
    }
    return '';
}

function base(word: string): string {
    return word.split('/').pop() ?? word;
}

/** Which server a container is, from its image and its command line. */
export function engineOf(container: Container, words: string[] = commandWords(container)): Engine | undefined {
    const image = (container.image ?? '').toLowerCase();
    const has = (pattern: RegExp) => words.some((w) => pattern.test(w));
    const commands = words.map(base);
    if (/nvcr\.io\/nim\//.test(image)) return 'NIM';
    if (/sglang/.test(image) || has(/^sglang(\.launch_server)?$/)) return 'SGLang';
    if (commands.includes('trtllm-serve')) return 'TensorRT-LLM';
    if (/vllm/.test(image) || commands.includes('vllm') || has(/^vllm\.entrypoints/)) return 'vLLM';
    if (/text-generation-inference/.test(image) || commands.includes('text-generation-launcher')) return 'TGI';
    if (/llama[.-]?cpp/.test(image) || commands.includes('llama-server')) return 'llama.cpp';
    if (/huggingfaceserver/.test(image) || has(/^huggingfaceserver$/)) return 'KServe';
    if (/tritonserver/.test(image) || commands.includes('tritonserver')) return 'Triton';
    if (/(^|\/)ollama(:|$)/.test(image) || /\/ollama\//.test(image)) return 'Ollama';
    return undefined;
}

/** What a container serves, when it is an inference server. */
export function servedBy(container: Container): Omit<Served, 'namespace' | 'pod' | 'node' | 'running'> | undefined {
    const words = commandWords(container);
    const engine = engineOf(container, words);
    if (!engine) return undefined;
    const int = (value: string) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    };
    let model = '';
    let names: string[] = [];
    let tp = 1;
    let pp = 1;
    switch (engine) {
        case 'vLLM':
            model = positionalAfter(words, /^serve$/) || first(words, ['--model']) || envValue(container, 'MODEL', 'MODEL_NAME', 'MODEL_ID');
            names = flag(words, ['--served-model-name'], true);
            tp = int(first(words, ['--tensor-parallel-size', '-tp']));
            pp = int(first(words, ['--pipeline-parallel-size', '-pp']));
            break;
        case 'SGLang':
            model = first(words, ['--model-path', '--model']) || envValue(container, 'MODEL', 'MODEL_ID');
            names = flag(words, ['--served-model-name'], true);
            tp = int(first(words, ['--tp-size', '--tp', '--tensor-parallel-size']));
            pp = int(first(words, ['--pp-size', '--pp']));
            break;
        case 'TGI':
            model = first(words, ['--model-id']) || envValue(container, 'MODEL_ID');
            tp = int(first(words, ['--num-shard']) || envValue(container, 'NUM_SHARD'));
            break;
        case 'TensorRT-LLM':
            model = positionalAfter(words, /(^|\/)trtllm-serve$/) || first(words, ['--model']);
            tp = int(first(words, ['--tp_size', '--tp-size']));
            pp = int(first(words, ['--pp_size', '--pp-size']));
            break;
        case 'llama.cpp':
            model = first(words, ['-hf', '--hf-repo', '-m', '--model']) || envValue(container, 'LLAMA_ARG_HF_REPO', 'LLAMA_ARG_MODEL');
            names = flag(words, ['-a', '--alias']);
            break;
        case 'NIM': {
            const image = (container.image ?? '').replace(/^nvcr\.io\/nim\//, '').replace(/[:@].*$/, '');
            model = envValue(container, 'NIM_MODEL_NAME') || image;
            names = [envValue(container, 'NIM_SERVED_MODEL_NAME')].filter(Boolean);
            tp = int(envValue(container, 'NIM_TENSOR_PARALLEL_SIZE'));
            break;
        }
        case 'KServe':
            model = first(words, ['--model_id', '--model-id']) || first(words, ['--model_dir', '--model-dir']);
            names = flag(words, ['--model_name', '--model-name']);
            tp = int(first(words, ['--tensor-parallel-size', '--tensor_parallel_size']));
            break;
        case 'Triton':
            model = first(words, ['--model-repository', '--model-store']);
            break;
        case 'Ollama':
            model = '';
            break;
    }
    return {
        container: container.name ?? '',
        engine,
        model,
        names: names.length ? names : model ? [base(model)] : [],
        tensorParallel: tp,
        pipelineParallel: pp,
        maxModelLen: first(words, ['--max-model-len', '--context-length', '--max-total-tokens', '-c', '--ctx-size']),
        quantization: first(words, ['--quantization', '-q', '--dtype-weights']),
        gpuMemoryUtilization: first(words, ['--gpu-memory-utilization', '--mem-fraction-static']),
    };
}

/** Every inference server among the live pods, one per container that is one. */
export function servedModels(pods: Pod[]): Served[] {
    const out: Served[] = [];
    for (const pod of pods) {
        if (!isLive(pod)) continue;
        for (const container of pod.spec?.containers ?? []) {
            const served = servedBy(container);
            if (!served) continue;
            out.push({
                ...served,
                namespace: pod.metadata.namespace ?? '',
                pod: pod.metadata.name,
                node: pod.spec?.nodeName ?? '',
                running: (pod.status?.phase ?? '') === 'Running',
            });
        }
    }
    return out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.pod.localeCompare(b.pod));
}

/** The short name a model is asked for by: the first served name, or the model's last path segment. */
export function shortName(served: Served): string {
    return served.names[0] ?? (served.model ? base(served.model) : served.engine);
}

// ----- how busy the servers are ----------------------------------------------------------

/** The `data-` charts vLLM's own /metrics feed, when Prometheus scrapes it. Kept in step with plugin.json. */
export const VLLM_CHARTS = {
    running: 'data-vllm-running',
    waiting: 'data-vllm-waiting',
    kvCache: 'data-vllm-kv-cache',
    tokens: 'data-vllm-tokens',
} as const;

export interface ServerLoad {
    running?: number;
    waiting?: number;
    /** 0-1. */
    kvCache?: number;
    tokensPerSecond?: number;
}

/**
 * What each vLLM server reports about itself, by `namespace/pod`. Prometheus
 * labels a scraped pod's series with its own namespace and pod, which is
 * what ties a number to the pod whose command line named the model.
 */
export function readServerLoad(panel: K8sDockside.ChartsPanel | null): Map<string, ServerLoad> {
    const out = new Map<string, ServerLoad>();
    if (!panel?.source.available) return out;
    const byId = new Map(panel.charts.map((c) => [c.id, c]));
    const put = (id: string, field: keyof ServerLoad) => {
        for (const { labels, value } of current(byId.get(id))) {
            const namespace = labels['namespace'] ?? labels['exported_namespace'] ?? '';
            const pod = labels['pod'] ?? labels['exported_pod'] ?? '';
            if (!namespace || !pod) continue;
            const key = `${namespace}/${pod}`;
            const load = out.get(key) ?? {};
            load[field] = (load[field] ?? 0) + value;
            out.set(key, load);
        }
    };
    put(VLLM_CHARTS.running, 'running');
    put(VLLM_CHARTS.waiting, 'waiting');
    put(VLLM_CHARTS.kvCache, 'kvCache');
    put(VLLM_CHARTS.tokens, 'tokensPerSecond');
    return out;
}
