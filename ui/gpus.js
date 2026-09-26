// Built by k8sdockside-plugin from src/ -- edit the TypeScript there, not this file.
"use strict";
(() => {
  // src/model/kube.ts
  var NODES = "nodes";
  var PODS = "pods";
  var DAEMONSETS = "daemonsets";
  var EVENTS = "events";
  var SLICES = "resourceslices";
  var CLAIMS = "resourceclaims";
  var TEMPLATES = "resourceclaimtemplates";
  var CLASSES = "deviceclasses";
  function emptySnapshot() {
    return { nodes: [], pods: [], slices: [], claims: [], templates: [], classes: [], daemonSets: [], events: [], missing: {} };
  }
  function condition(conditions, type) {
    return (conditions ?? []).find((c) => c.type === type);
  }
  function isLive(pod) {
    const phase = pod.status?.phase ?? "";
    return phase !== "Succeeded" && phase !== "Failed";
  }

  // src/model/units.ts
  function memory(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const gib = bytes / 1024 ** 3;
    if (gib >= 10) return `${Math.round(gib)} GiB`;
    if (gib >= 1) return `${(Math.round(gib * 10) / 10).toString()} GiB`;
    return `${Math.round(bytes / 1024 ** 2)} MiB`;
  }
  function percent(part, whole) {
    if (!(whole > 0)) return 0;
    return Math.max(0, Math.min(100, part / whole * 100));
  }
  function quantity(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (!value) return 0;
    const match = /^\s*([0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([EPTGMk]i?|m)?\s*$/.exec(value);
    if (!match) return 0;
    const n = Number(match[1]);
    if (!Number.isFinite(n)) return 0;
    const suffix = match[2] ?? "";
    const binary = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
    const decimal = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, m: 1e-3 };
    return n * (binary[suffix] ?? decimal[suffix] ?? 1);
  }
  function count(n, noun, plural = `${noun}s`) {
    return `${n} ${n === 1 ? noun : plural}`;
  }

  // src/model/vendors.ts
  var VENDOR_NAMES = {
    nvidia: "NVIDIA",
    amd: "AMD",
    intel: "Intel",
    habana: "Intel Gaudi",
    aws: "AWS Neuron",
    google: "Google TPU",
    example: "Simulated (example driver)",
    other: "Other"
  };
  var DEVICE_RESOURCES = [
    [/^nvidia\.com\/gpu(\.shared)?$/, "nvidia"],
    [/^nvidia\.com\/mig-\d+(c\.\d+)?g\.\d+gb(\+[a-z]+)?$/, "nvidia"],
    [/^amd\.com\/gpu$/, "amd"],
    [/^gpu\.intel\.com\/(i915|xe)$/, "intel"],
    [/^habana\.ai\/gaudi$/, "habana"],
    [/^aws\.amazon\.com\/neuron(device)?$/, "aws"],
    [/^google\.com\/tpu$/, "google"]
  ];
  function isDeviceResource(name) {
    return DEVICE_RESOURCES.some(([pattern]) => pattern.test(name));
  }
  function resourceVendor(name) {
    return DEVICE_RESOURCES.find(([pattern]) => pattern.test(name))?.[1];
  }
  function driverVendor(driver) {
    const name = driver.toLowerCase();
    if (name === "gpu.example.com" || name.endsWith(".example.com")) return "example";
    if (/(^|\.)nvidia\.com$/.test(name)) return "nvidia";
    if (/(^|\.)amd\.com$/.test(name)) return "amd";
    if (/(^|\.)habana\.ai$/.test(name)) return "habana";
    if (/(^|\.)intel\.com$/.test(name)) return "intel";
    if (/(^|\.)(amazon|aws)\.com$/.test(name)) return "aws";
    if (/(^|\.)google\.com$/.test(name)) return "google";
    return "other";
  }
  function isAcceleratorDriver(driver) {
    return !/^compute-domain\./.test(driver);
  }
  function parseMigProfile(text) {
    const match = /^(?:mig-)?(?:(\d+)c\.)?(\d+)g\.(\d+)gb(\+[a-z]+)?$/i.exec(text.trim());
    if (!match) return void 0;
    const slices = Number(match[2]);
    const gigabytes = Number(match[3]);
    if (!(slices > 0)) return void 0;
    return { name: text.replace(/^mig-/, ""), slices, gigabytes };
  }
  function migResourceProfile(resource) {
    const match = /^nvidia\.com\/mig-(.+)$/.exec(resource);
    return match ? parseMigProfile(match[1] ?? "") : void 0;
  }
  function migSlicesFor(product) {
    return /\bA30\b/i.test(product.replace(/[-_]/g, " ")) ? 4 : 7;
  }
  function friendlyModel(raw) {
    let name = raw.trim();
    if (!name) return "";
    name = name.replace(/-SHARED$/, "").replace(/[_-]+/g, " ");
    name = name.replace(/^(NVIDIA|AMD|Intel\(R\)|Intel)\s+/i, "");
    return name.replace(/\s+/g, " ").trim();
  }
  function nodeCard(labels) {
    const l = labels ?? {};
    const num = (key) => {
      const n = Number(l[key]);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const joined = (...keys) => {
      const parts = keys.map((key) => l[key]).filter((v) => v !== void 0 && v !== "");
      return parts.length === keys.length ? parts.join(".") : "";
    };
    const product = l["nvidia.com/gpu.product"] ?? l["amd.com/gpu.product-name"] ?? l["beta.amd.com/gpu.product-name"] ?? "";
    const mib = num("nvidia.com/gpu.memory");
    const amdVram = l["amd.com/gpu.vram"] ?? l["beta.amd.com/gpu.vram"] ?? "";
    return {
      product,
      memory: mib > 0 ? mib * 1024 ** 2 : amdVram ? vram(amdVram) : 0,
      count: num("nvidia.com/gpu.count"),
      replicas: Math.max(1, num("nvidia.com/gpu.replicas")),
      sharing: l["nvidia.com/gpu.sharing-strategy"] ?? "",
      driverVersion: l["nvidia.com/cuda.driver-version.full"] ?? (joined("nvidia.com/cuda.driver.major", "nvidia.com/cuda.driver.minor", "nvidia.com/cuda.driver.rev") || l["amd.com/gpu.driver-version"] || ""),
      cudaVersion: l["nvidia.com/cuda.runtime-version.full"] ?? joined("nvidia.com/cuda.runtime.major", "nvidia.com/cuda.runtime.minor"),
      migStrategy: l["nvidia.com/mig.strategy"] ?? ""
    };
  }
  function vram(text) {
    const match = /^(\d+(?:\.\d+)?)\s*([GMT])i?B?$/i.exec(text.trim());
    if (!match) return 0;
    const n = Number(match[1]);
    const unit = (match[2] ?? "G").toUpperCase();
    return n * (unit === "T" ? 1024 ** 4 : unit === "M" ? 1024 ** 2 : 1024 ** 3);
  }
  function resourceNoun(resource) {
    const mig = migResourceProfile(resource);
    if (mig) return `MIG ${mig.name}`;
    if (resource === "habana.ai/gaudi") return "Gaudi";
    if (resource.startsWith("aws.amazon.com/")) return "Neuron device";
    if (resource === "google.com/tpu") return "TPU";
    return "GPU";
  }

  // src/model/requests.ts
  var CLASS_RESOURCE_PREFIX = "deviceclass.resource.kubernetes.io/";
  function isAcceleratorRequest(name, classResources = /* @__PURE__ */ new Set()) {
    return isDeviceResource(name) || name.startsWith(CLASS_RESOURCE_PREFIX) || classResources.has(name);
  }
  function podDeviceRequests(pod, classResources = /* @__PURE__ */ new Set()) {
    const running = {};
    const add = (into, container) => {
      for (const [name, amount] of Object.entries(wanted(container))) {
        if (isAcceleratorRequest(name, classResources)) into[name] = (into[name] ?? 0) + amount;
      }
    };
    for (const container of pod.spec?.containers ?? []) add(running, container);
    const inits = pod.spec?.initContainers ?? [];
    for (const container of inits) if (container.restartPolicy === "Always") add(running, container);
    const out = { ...running };
    for (const container of inits) {
      if (container.restartPolicy === "Always") continue;
      const alone = {};
      add(alone, container);
      for (const [name, amount] of Object.entries(alone)) out[name] = Math.max(out[name] ?? 0, amount);
    }
    return out;
  }
  function wanted(container) {
    const out = {};
    for (const [name, value] of Object.entries(container.resources?.requests ?? {})) out[name] = quantity(value);
    for (const [name, value] of Object.entries(container.resources?.limits ?? {})) out[name] = quantity(value);
    return out;
  }
  function podClaims(pod) {
    const statuses = new Map((pod.status?.resourceClaimStatuses ?? []).map((s) => [s.name ?? "", s.resourceClaimName ?? ""]));
    const out = (pod.spec?.resourceClaims ?? []).map((c) => ({
      entry: c.name ?? "",
      claim: c.resourceClaimName ?? statuses.get(c.name ?? "") ?? "",
      template: c.resourceClaimTemplateName ?? ""
    }));
    const extended = pod.status?.extendedResourceClaimStatus?.resourceClaimName;
    if (extended) out.push({ entry: "(extended resource)", claim: extended, template: "" });
    return out;
  }

  // src/model/dcgm.ts
  var DCGM_CHARTS = {
    /** The identity charts: every label DCGM writes, one series per card (and per pod on it). */
    memoryUsed: "data-dcgm-memory-used",
    util: "data-dcgm-util",
    memoryFree: "data-dcgm-memory-free",
    temperature: "data-dcgm-temperature",
    power: "data-dcgm-power",
    nvlink: "data-dcgm-nvlink"
  };
  function noDcgm(error = "") {
    return { gpus: [], status: { prometheus: false, found: false, mapping: false, describe: "", error, unmatched: [] } };
  }
  function parseLabels(name) {
    const out = {};
    const starts = [];
    const pattern = /(?:^|, )([A-Za-z_][A-Za-z0-9_]*)=/g;
    for (let match = pattern.exec(name); match; match = pattern.exec(name)) {
      starts.push({ key: match[1] ?? "", at: match.index, from: match.index + match[0].length });
    }
    starts.forEach((start2, i) => {
      const next = starts[i + 1];
      out[start2.key] = name.slice(start2.from, next ? next.at : name.length);
    });
    return out;
  }
  function current(chart) {
    if (!chart) return [];
    const series = chart.series.filter((s) => s.points.length > 0);
    const lastOf = (s) => s.points[s.points.length - 1];
    const newest = Math.max(...series.map((s) => lastOf(s).t), 0);
    const spacing = Math.max(
      15,
      ...series.map((s) => {
        const n = s.points.length;
        return n > 1 ? s.points[n - 1].t - s.points[n - 2].t : 0;
      })
    );
    const cutoff = newest - Math.max(60, 3 * spacing);
    return series.filter((s) => lastOf(s).t >= cutoff).map((s) => ({ labels: parseLabels(s.name), value: lastOf(s).v }));
  }
  function hostOf(labels) {
    return labels["Hostname"] ?? labels["kubernetes_node"] ?? labels["node"] ?? "";
  }
  function nodeMatcher(nodes, hosts, gpuNodes) {
    const names = nodes.map((n) => n.metadata.name);
    const short = (name) => name.toLowerCase().split(".")[0] ?? "";
    const distinct = [...new Set(hosts)];
    return (host) => {
      if (names.includes(host)) return host;
      const lower = names.find((n) => n.toLowerCase() === host.toLowerCase());
      if (lower) return lower;
      const same = names.filter((n) => short(n) === short(host));
      if (same.length === 1 && same[0]) return same[0];
      if (distinct.length === 1 && gpuNodes.length === 1 && gpuNodes[0]) return gpuNodes[0];
      return "";
    };
  }
  function asksForDevices(pod) {
    return Object.keys(podDeviceRequests(pod)).length > 0 || podClaims(pod).length > 0;
  }
  function readDcgm(panel, nodes, pods, gpuNodes = []) {
    if (!panel) return noDcgm();
    const status = { prometheus: panel.source.available, found: false, mapping: false, describe: panel.source.describe, error: panel.source.error, unmatched: [] };
    if (!panel.source.available) return { gpus: [], status };
    const byId2 = new Map(panel.charts.map((c) => [c.id, c]));
    const used = current(byId2.get(DCGM_CHARTS.memoryUsed));
    const util = current(byId2.get(DCGM_CHARTS.util));
    const identity = [...used, ...util];
    if (identity.length === 0) return { gpus: [], status };
    status.found = true;
    const matchNode = nodeMatcher(nodes, identity.map((s) => hostOf(s.labels)), gpuNodes);
    const livePods = new Map(pods.filter(isLive).map((p) => [`${p.metadata.namespace ?? ""}/${p.metadata.name}`, p]));
    const unmatched = /* @__PURE__ */ new Set();
    const gpus = /* @__PURE__ */ new Map();
    const keyOf = (labels) => `${hostOf(labels)}/${labels["UUID"] ?? labels["gpu"] ?? ""}`;
    const gpuFor = (labels) => {
      const key = keyOf(labels);
      let gpu = gpus.get(key);
      if (!gpu) {
        const host = hostOf(labels);
        const node = matchNode(host);
        if (!node && host) unmatched.add(host);
        gpu = {
          node: node || host,
          index: labels["gpu"] ?? "",
          uuid: labels["UUID"] ?? "",
          pciBus: labels["pci_bus_id"] ?? "",
          model: labels["modelName"] ?? "",
          device: labels["device"] ?? "",
          driverVersion: labels["DCGM_FI_DRIVER_VERSION"] ?? "",
          mig: false,
          consumers: []
        };
        gpus.set(key, gpu);
      }
      return gpu;
    };
    for (const { labels } of identity) {
      const gpu = gpuFor(labels);
      if (labels["GPU_I_ID"] !== void 0 && labels["GPU_I_ID"] !== "") gpu.mig = true;
      const consumer = consumerOf(labels, gpu.node, livePods);
      if (consumer && !gpu.consumers.some((c) => c.namespace === consumer.namespace && c.pod === consumer.pod)) gpu.consumers.push(consumer);
    }
    const each = (samples, apply) => {
      for (const { labels, value } of samples) {
        const gpu = gpus.get(keyOf(labels));
        if (gpu) apply(gpu, value, labels);
      }
    };
    const mib = 1024 ** 2;
    const perCard = /* @__PURE__ */ new Set();
    each(used, (gpu, v, labels) => {
      const key = `${gpu.node}/${gpu.uuid}/${labels["GPU_I_ID"] ?? ""}`;
      if (perCard.has(key)) return;
      perCard.add(key);
      gpu.memoryUsed = (gpu.memoryUsed ?? 0) + v * mib;
    });
    each(util, (gpu, v) => gpu.util = Math.max(gpu.util ?? 0, v / 100));
    each(current(byId2.get(DCGM_CHARTS.memoryFree)), (gpu, v) => gpu.memoryFree = (gpu.memoryFree ?? 0) + v * mib);
    each(current(byId2.get(DCGM_CHARTS.temperature)), (gpu, v) => gpu.temperature = v);
    each(current(byId2.get(DCGM_CHARTS.power)), (gpu, v) => gpu.power = v);
    each(current(byId2.get(DCGM_CHARTS.nvlink)), (gpu, v) => gpu.nvlink = v);
    const list2 = [...gpus.values()].sort((a, b) => a.node.localeCompare(b.node) || Number(a.index) - Number(b.index) || a.uuid.localeCompare(b.uuid));
    status.mapping = list2.some((g) => g.consumers.length > 0);
    status.unmatched = [...unmatched].sort();
    return { gpus: list2, status };
  }
  function consumerOf(labels, node, pods) {
    const candidates = [
      [labels["exported_namespace"] ?? "", labels["exported_pod"] ?? "", labels["exported_container"] ?? ""],
      [labels["namespace"] ?? "", labels["pod"] ?? "", labels["container"] ?? ""]
    ];
    for (const [namespace, name, container] of candidates) {
      if (!namespace || !name) continue;
      const pod = pods.get(`${namespace}/${name}`);
      if (!pod) continue;
      if (node && pod.spec?.nodeName && pod.spec.nodeName !== node) continue;
      if (!asksForDevices(pod)) continue;
      return { namespace, pod: name, container };
    }
    return void 0;
  }
  function shortUuid(uuid) {
    const match = /^((?:GPU|MIG)-)?([0-9a-f]{8})/i.exec(uuid);
    return match ? `${match[1] ?? ""}${match[2]}` : uuid.slice(0, 12);
  }

  // src/model/visible.ts
  var VISIBLE_ENV = ["NVIDIA_VISIBLE_DEVICES", "CUDA_VISIBLE_DEVICES"];
  function parseVisible(value) {
    const text = value.trim();
    if (!text || /^(none|void|NoDevFiles)$/i.test(text)) return void 0;
    if (/^all$/i.test(text)) return { all: true, devices: [] };
    const devices = text.split(",").map((d) => d.trim()).filter((d) => /^\d+$/.test(d) || /^(GPU|MIG)-[0-9a-f-]+$/i.test(d));
    return devices.length ? { all: false, devices } : void 0;
  }
  function asksScheduler(pod) {
    return Object.keys(podDeviceRequests(pod)).length > 0 || podClaims(pod).length > 0;
  }
  function visibleDevices(pod) {
    if (asksScheduler(pod)) return void 0;
    for (const container of pod.spec?.containers ?? []) {
      for (const name of VISIBLE_ENV) {
        const value = container.env?.find((e) => e.name === name)?.value;
        if (value === void 0) continue;
        const parsed = parseVisible(value);
        if (parsed) return { ...parsed, env: name, container: container.name ?? "" };
      }
    }
    return void 0;
  }
  function nvidiaRuntime(pod) {
    return /nvidia/i.test(pod.spec?.runtimeClassName ?? "");
  }

  // src/model/dra.ts
  function deviceKey(driver, pool, device) {
    return `${driver}/${pool}/${device}`;
  }
  function attributeText(attribute) {
    if (!attribute) return "";
    if (attribute.string !== void 0) return attribute.string;
    if (attribute.version !== void 0) return attribute.version;
    if (attribute.int !== void 0) return String(attribute.int);
    if (attribute.bool !== void 0) return attribute.bool ? "true" : "false";
    return "";
  }
  function shortName(name, driver) {
    const prefix = `${driver}/`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }
  function sliceDevices(slices) {
    const newest = /* @__PURE__ */ new Map();
    for (const slice of slices) {
      const key = poolKey(slice);
      const generation = slice.spec?.pool?.generation ?? 0;
      newest.set(key, Math.max(newest.get(key) ?? -Infinity, generation));
    }
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const slice of slices) {
      const spec = slice.spec ?? {};
      if ((spec.pool?.generation ?? 0) !== newest.get(poolKey(slice))) continue;
      const driver = spec.driver ?? "";
      const pool = spec.pool?.name ?? "";
      for (const device of spec.devices ?? []) {
        const name = device.name ?? "";
        const key = deviceKey(driver, pool, name);
        if (!name || seen.has(key)) continue;
        seen.add(key);
        out.push(readDevice(device, driver, pool, spec.nodeName ?? "", slice.metadata.name));
      }
    }
    return out.sort(
      (a, b) => a.node.localeCompare(b.node) || a.driver.localeCompare(b.driver) || a.pool.localeCompare(b.pool) || a.name.localeCompare(b.name, void 0, { numeric: true })
    );
  }
  function poolKey(slice) {
    return `${slice.spec?.driver ?? ""}/${slice.spec?.pool?.name ?? ""}`;
  }
  function readDevice(device, driver, pool, sliceNode, slice) {
    const fields = device.basic ?? device;
    const attributes = {};
    for (const [name, value] of Object.entries(fields.attributes ?? {})) attributes[shortName(name, driver)] = attributeText(value);
    const capacity = {};
    for (const [name, value] of Object.entries(fields.capacity ?? {})) {
      if (value?.value !== void 0) capacity[shortName(name, driver)] = String(value.value);
    }
    const taint = (fields.taints ?? []).find((t) => t.effect === "NoSchedule" || t.effect === "NoExecute");
    return {
      driver,
      pool,
      name: device.name ?? "",
      node: sliceNode || fields.nodeName || "",
      slice,
      attributes,
      capacity,
      counterSets: (fields.consumesCounters ?? []).map((c) => c.counterSet ?? "").filter((s) => s !== ""),
      tainted: taint ? `${taint.key ?? ""}${taint.value ? `=${taint.value}` : ""}:${taint.effect ?? ""}` : "",
      multiple: fields.allowMultipleAllocations === true
    };
  }
  function deviceMemory(device) {
    return quantity(device.capacity["memory"] ?? device.capacity["memorySize"] ?? "");
  }
  function deviceModel(device) {
    for (const key of ["productName", "model", "product", "productname", "deviceName", "marketingName", "family"]) {
      const value = device.attributes[key];
      if (value) return value;
    }
    return "";
  }
  function allocatedDevices(claim) {
    return (claim.status?.allocation?.devices?.results ?? []).filter((r) => r.adminAccess !== true && r.device);
  }
  function reservedPods(claim) {
    return (claim.status?.reservedFor ?? []).filter((r) => (r.resource ?? "pods") === "pods" && !r.apiGroup).map((r) => r.name ?? "").filter((n) => n !== "");
  }

  // src/model/inventory.ts
  function buildInventory(snap, dcgm = []) {
    const nodesByName = new Map(snap.nodes.map((node) => [node.metadata.name, node]));
    const devices = sliceDevices(snap.slices).filter((d) => isAcceleratorDriver(d.driver));
    const byKey = /* @__PURE__ */ new Map();
    const draUnits = unitsFromDevices(devices, byKey);
    applyClaims(snap.claims, byKey);
    for (const unit of draUnits) settle(unit);
    const views = /* @__PURE__ */ new Map();
    const view = (name) => {
      let v = views.get(name);
      if (!v) {
        const node = nodesByName.get(name);
        v = {
          name,
          ready: node ? condition(node.status?.conditions, "Ready")?.status === "True" : name === "",
          unschedulable: node?.spec?.unschedulable === true,
          card: nodeCard(node?.metadata.labels),
          units: [],
          notes: []
        };
        views.set(name, v);
      }
      return v;
    };
    draUnits.sort((a, b) => a.node.localeCompare(b.node) || a.driver.localeCompare(b.driver) || a.label.localeCompare(b.label, void 0, { numeric: true }) || a.name.localeCompare(b.name, void 0, { numeric: true }));
    for (const unit of draUnits) view(unit.node).units.push(unit);
    const podsByNode = /* @__PURE__ */ new Map();
    for (const pod of snap.pods) {
      const name = pod.spec?.nodeName;
      if (!name || !isLive(pod)) continue;
      podsByNode.set(name, [...podsByNode.get(name) ?? [], pod]);
    }
    for (const node of snap.nodes) {
      const draVendors = new Set((views.get(node.metadata.name)?.units ?? []).map((u) => u.vendor));
      const units2 = unitsFromNode(node, podsByNode.get(node.metadata.name) ?? [], draVendors, (note) => view(node.metadata.name).notes.push(note));
      if (units2.length) view(node.metadata.name).units.push(...units2);
    }
    if (dcgm.length) applyDcgm([...views.values()], dcgm);
    applyVisible([...views.values()], snap.pods);
    const nodes = [...views.values()].filter((v) => v.units.length > 0).sort((a, b) => a.name === "" ? 1 : b.name === "" ? -1 : a.name.localeCompare(b.name, void 0, { numeric: true }));
    const units = nodes.flatMap((n) => n.units);
    return { nodes, units, totals: totals(units), byModel: tally(units, (u) => modelKey(u)), byVendor: tally(units, (u) => [u.vendor, VENDOR_NAMES[u.vendor]]), byKey };
  }
  function blankUnit(partial) {
    return {
      label: "",
      model: "",
      memory: 0,
      driverVersion: "",
      cudaVersion: "",
      state: "free",
      consumers: [],
      claims: [],
      partitions: [],
      slices: 0,
      slots: 1,
      sharing: "",
      inferred: false,
      problem: "",
      uuid: "",
      pciBus: "",
      ...partial
    };
  }
  function indexLabel(name) {
    const match = /(\d+)$/.exec(name);
    return match?.[1] ?? name.slice(0, 3);
  }
  function unitFromDevice(device) {
    return blankUnit({
      id: `dra/${deviceKey(device.driver, device.pool, device.name)}`,
      node: device.node,
      source: "dra",
      vendor: driverVendor(device.driver),
      driver: device.driver,
      name: device.name,
      label: device.attributes["index"] ?? indexLabel(device.name),
      model: friendlyModel(deviceModel(device)),
      memory: deviceMemory(device),
      driverVersion: device.attributes["driverVersion"] ?? "",
      cudaVersion: device.attributes["cudaDriverVersion"] ?? "",
      device,
      uuid: device.attributes["uuid"] ?? "",
      pciBus: device.attributes["pcieBusID"] ?? device.attributes["pciBusID"] ?? device.attributes["pciAddress"] ?? "",
      problem: device.tainted ? `The driver has tainted this device (${device.tainted}): the scheduler will not hand it out.` : ""
    });
  }
  function partitionFrom(device, dynamic = false) {
    const profile = device.attributes["profile"] ?? /-mig-([0-9a-z]+?)-\d+-\d+$/.exec(device.name)?.[1] ?? "";
    const parsed = parseMigProfile(profile) ?? parseMigProfile(profile.replace(/^(\d+g)(\d+gb)$/, "$1.$2"));
    return {
      id: `dra/${deviceKey(device.driver, device.pool, device.name)}`,
      name: device.name,
      profile: parsed?.name ?? profile,
      slices: parsed?.slices ?? 1,
      memory: deviceMemory(device),
      state: device.tainted ? "unhealthy" : "free",
      consumers: [],
      claims: [],
      device,
      ...dynamic ? { dynamic } : {}
    };
  }
  function unitsFromDevices(devices, byKey) {
    const units = [];
    const byUuid = /* @__PURE__ */ new Map();
    const byCounterSet = /* @__PURE__ */ new Map();
    const carved = /* @__PURE__ */ new Set();
    const groupKey = (d, set) => `${d.driver}/${d.pool}/${set}`;
    const children = [];
    const counterGroups = /* @__PURE__ */ new Map();
    for (const device of devices) {
      if (device.attributes["parentUUID"] || device.attributes["type"] === "mig") {
        children.push(device);
        continue;
      }
      const set = device.counterSets[0];
      if (set) counterGroups.set(groupKey(device, set), [...counterGroups.get(groupKey(device, set)) ?? [], device]);
      else addUnit(unitFromDevice(device));
    }
    for (const [key, group] of counterGroups) {
      const whole = group.find((d) => d.attributes["type"] === "gpu") ?? [...group].sort((a, b) => deviceMemory(b) - deviceMemory(a) || a.name.length - b.name.length)[0];
      if (!whole) continue;
      const unit = addUnit(unitFromDevice(whole));
      byCounterSet.set(key, unit);
      for (const other of group) {
        if (other === whole) continue;
        byKey.set(deviceKey(other.driver, other.pool, other.name), { unit, partition: partitionFrom(other, true) });
        carved.add(unit);
      }
    }
    for (const device of children) {
      const parentUuid = device.attributes["parentUUID"] ?? "";
      let parent = parentUuid ? byUuid.get(`${device.node}/${device.driver}/${parentUuid}`) : void 0;
      if (!parent && device.counterSets[0]) parent = byCounterSet.get(groupKey(device, device.counterSets[0]));
      if (!parent) {
        const minor = /^gpu-(\d+)-mig-/.exec(device.name)?.[1];
        const name = minor !== void 0 ? `gpu-${minor}` : parentUuid ? `GPU ${parentUuid.slice(0, 12)}` : device.name;
        parent = addUnit(
          blankUnit({
            id: `dra/${device.driver}/${device.pool}/${parentUuid || name}`,
            node: device.node,
            source: "dra",
            vendor: driverVendor(device.driver),
            driver: device.driver,
            name,
            label: minor ?? indexLabel(name),
            model: friendlyModel(deviceModel(device)),
            driverVersion: device.attributes["driverVersion"] ?? "",
            cudaVersion: device.attributes["cudaDriverVersion"] ?? ""
          }),
          parentUuid
        );
      }
      if (device.counterSets.length > 0) {
        byKey.set(deviceKey(device.driver, device.pool, device.name), { unit: parent, partition: partitionFrom(device, true) });
        carved.add(parent);
      } else {
        const partition = partitionFrom(device);
        parent.partitions.push(partition);
        byKey.set(deviceKey(device.driver, device.pool, device.name), { unit: parent, partition });
      }
    }
    for (const unit of units) {
      if (unit.partitions.length > 0 || carved.has(unit)) unit.slices = migSlicesFor(unit.model);
      unit.partitions.sort((a, b) => a.name.localeCompare(b.name, void 0, { numeric: true }));
    }
    return units;
    function addUnit(unit, uuid = unit.device?.attributes["uuid"] ?? "") {
      units.push(unit);
      if (unit.device) byKey.set(deviceKey(unit.device.driver, unit.device.pool, unit.device.name), { unit });
      if (uuid) byUuid.set(`${unit.node}/${unit.driver}/${uuid}`, unit);
      return unit;
    }
  }
  function applyClaims(claims, byKey) {
    for (const claim of claims) {
      const ref = { namespace: claim.metadata.namespace ?? "", name: claim.metadata.name };
      const pods = reservedPods(claim);
      for (const result of allocatedDevices(claim)) {
        const entry = byKey.get(deviceKey(result.driver ?? "", result.pool ?? "", result.device ?? ""));
        if (!entry) continue;
        let target = entry.unit;
        if (entry.partition) {
          let partition = entry.unit.partitions.find((p) => p.id === entry.partition?.id);
          if (!partition) {
            partition = entry.partition;
            entry.unit.partitions.push(partition);
          }
          target = partition;
        }
        if (!target.claims.some((c) => c.namespace === ref.namespace && c.name === ref.name)) target.claims.push(ref);
        for (const pod of pods) {
          if (!target.consumers.some((c) => c.namespace === ref.namespace && c.pod === pod)) target.consumers.push({ namespace: ref.namespace, pod, claim: ref.name });
        }
      }
    }
  }
  function holdState(claims, consumers, unhealthy) {
    if (claims.length > 1 || new Set(consumers.map((c) => `${c.namespace}/${c.pod}`)).size > 1) return "shared";
    if (claims.length === 1 || consumers.length === 1) return "allocated";
    return unhealthy ? "unhealthy" : "free";
  }
  function settle(unit) {
    for (const partition of unit.partitions) {
      partition.state = holdState(partition.claims, partition.consumers, partition.state === "unhealthy" || Boolean(partition.device?.tainted));
    }
    const own = holdState(unit.claims, unit.consumers, Boolean(unit.device?.tainted));
    const used = unit.partitions.filter((p) => p.state === "allocated" || p.state === "shared");
    if (own !== "free" && own !== "unhealthy") {
      unit.state = own;
    } else if (used.length > 0) {
      for (const p of used) {
        for (const c of p.consumers) if (!unit.consumers.some((u) => u.namespace === c.namespace && u.pod === c.pod)) unit.consumers.push(c);
        for (const c of p.claims) if (!unit.claims.some((u) => u.namespace === c.namespace && u.name === c.name)) unit.claims.push(c);
      }
      unit.state = used.length === unit.partitions.length && used.every((p) => p.state === "allocated") && sum(unit.partitions.map((p) => p.slices)) >= unit.slices ? "allocated" : "partial";
    } else {
      unit.state = own;
    }
  }
  function sum(values) {
    return values.reduce((n, v) => n + v, 0);
  }
  function unitsFromNode(node, pods, draVendors, note) {
    const name = node.metadata.name;
    const capacity = node.status?.capacity ?? {};
    const allocatable = node.status?.allocatable ?? {};
    const card = nodeCard(node.metadata.labels);
    let resources = Object.keys(capacity).filter((r) => isDeviceResource(r) && quantity(capacity[r]) > 0);
    if (resources.includes("aws.amazon.com/neurondevice")) resources = resources.filter((r) => r !== "aws.amazon.com/neuron");
    const skipped = resources.filter((r) => draVendors.has(resourceVendor(r) ?? "other"));
    if (skipped.length) {
      note(`${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} also advertised by a device plugin here. The same cards are published through DRA, so they are counted once, from DRA.`);
      resources = resources.filter((r) => !skipped.includes(r));
    }
    const requests = pods.map((pod) => ({ pod, wants: podDeviceRequests(pod) })).sort((a, b) => (a.pod.metadata.creationTimestamp ?? "").localeCompare(b.pod.metadata.creationTimestamp ?? "") || a.pod.metadata.name.localeCompare(b.pod.metadata.name));
    const units = [];
    const whole = resources.filter((r) => !migResourceProfile(r) && !isSingleMig(r, card)).sort();
    const mig = resources.filter((r) => migResourceProfile(r) || isSingleMig(r, card)).sort();
    for (const resource of whole) {
      const made = wholeUnits(name, resource, quantity(capacity[resource]), quantity(allocatable[resource] ?? capacity[resource]), card);
      place(
        made,
        requests.map(({ pod, wants }) => ({ pod, n: wants[resource] ?? 0 }))
      );
      units.push(...made);
    }
    if (mig.length) units.push(...migUnits(name, mig, capacity, allocatable, card, requests));
    units.forEach((unit, index) => unit.label = String(index));
    return units;
  }
  function isSingleMig(resource, card) {
    return resource === "nvidia.com/gpu" && card.migStrategy === "single" && /-MIG-/i.test(card.product);
  }
  function dpUnit(node, resource, index, card, vendor = resourceVendor(resource) ?? "other") {
    return blankUnit({
      id: `dp/${node}/${resource}/${index}`,
      node,
      source: "device-plugin",
      vendor,
      driver: resource,
      name: `${resource} #${index}`,
      model: friendlyModel(card.product.replace(/-MIG-.*$/i, "")) || `${VENDOR_NAMES[vendor]} ${resourceNoun(resource)}`,
      memory: card.memory,
      driverVersion: card.driverVersion,
      cudaVersion: card.cudaVersion,
      inferred: true
    });
  }
  function wholeUnits(node, resource, capacity, allocatable, card) {
    const nvidia = resource.startsWith("nvidia.com/");
    const replicas = nvidia && card.replicas > 1 ? card.replicas : 1;
    const physical = Math.ceil(capacity / replicas);
    const lost = Math.min(physical, Math.ceil(Math.max(0, capacity - allocatable) / replicas));
    const units = [];
    for (let i = 0; i < physical; i++) {
      const unit = dpUnit(node, resource, i, card);
      unit.slots = replicas;
      unit.sharing = replicas > 1 ? card.sharing || "time-slicing" : "";
      if (i >= physical - lost) {
        unit.state = "unhealthy";
        unit.problem = `The device plugin reports ${capacity - allocatable} of ${capacity} ${resource} unhealthy: the node has ${allocatable} to give out.`;
      }
      units.push(unit);
    }
    return units;
  }
  function place(units, wants) {
    const healthy = units.filter((u) => u.state !== "unhealthy");
    const used = /* @__PURE__ */ new Map();
    for (const { pod, n } of wants) {
      for (let k = 0; k < n; k++) {
        const target = [...healthy].filter((u) => (used.get(u) ?? 0) < u.slots).sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0];
        if (!target) break;
        used.set(target, (used.get(target) ?? 0) + 1);
        const consumer = { namespace: pod.metadata.namespace ?? "", pod: pod.metadata.name, claim: "" };
        if (!target.consumers.some((c) => c.namespace === consumer.namespace && c.pod === consumer.pod)) target.consumers.push(consumer);
      }
    }
    for (const unit of healthy) unit.state = holdState([], unit.consumers, false);
  }
  function migUnits(node, resources, capacity, allocatable, card, requests) {
    const perCard = migSlicesFor(card.product);
    const instances = [];
    for (const resource of resources) {
      const profile = migResourceProfile(resource) ?? parseMigProfile(/-MIG-(.+)$/i.exec(card.product)?.[1] ?? "");
      const have = quantity(capacity[resource]);
      const usable = quantity(allocatable[resource] ?? capacity[resource]);
      for (let i = 0; i < have; i++) instances.push({ resource, profile: profile?.name ?? resource, slices: Math.min(perCard, profile?.slices ?? 1), lost: i >= usable });
    }
    instances.sort((a, b) => b.slices - a.slices || a.profile.localeCompare(b.profile));
    const units = [];
    const free = /* @__PURE__ */ new Map();
    for (const instance of instances) {
      let unit = units.find((u) => (free.get(u) ?? 0) >= instance.slices);
      if (!unit) {
        unit = dpUnit(node, "nvidia.com/mig", units.length, card, "nvidia");
        unit.name = `MIG GPU #${units.length}`;
        unit.slices = perCard;
        units.push(unit);
        free.set(unit, perCard);
      }
      free.set(unit, (free.get(unit) ?? 0) - instance.slices);
      unit.partitions.push({
        id: `${unit.id}/${unit.partitions.length}`,
        name: instance.resource,
        profile: instance.profile,
        slices: instance.slices,
        memory: (parseMigProfile(instance.profile)?.gigabytes ?? 0) * 1e9,
        state: instance.lost ? "unhealthy" : "free",
        consumers: [],
        claims: []
      });
    }
    for (const resource of resources) {
      const cells = units.flatMap((u) => u.partitions).filter((p) => p.name === resource && p.state !== "unhealthy");
      let next = 0;
      for (const { pod, wants } of requests) {
        for (let k = 0; k < (wants[resource] ?? 0) && next < cells.length; k++, next++) {
          const cell = cells[next];
          if (cell) cell.consumers.push({ namespace: pod.metadata.namespace ?? "", pod: pod.metadata.name, claim: "" });
        }
      }
    }
    for (const unit of units) {
      for (const p of unit.partitions) {
        if (p.state !== "unhealthy") p.state = holdState([], p.consumers, false);
      }
      settle(unit);
      if (unit.partitions.every((p) => p.state === "unhealthy")) unit.state = "unhealthy";
      const lost = unit.partitions.filter((p) => p.state === "unhealthy").length;
      if (lost) unit.problem = `The device plugin reports ${lost} MIG instance${lost === 1 ? "" : "s"} here unhealthy.`;
    }
    return units;
  }
  function applyDcgm(views, gpus) {
    const byNode = /* @__PURE__ */ new Map();
    for (const gpu of gpus) byNode.set(gpu.node, [...byNode.get(gpu.node) ?? [], gpu]);
    for (const view of views) {
      const list2 = (byNode.get(view.name) ?? []).sort((a, b) => Number(a.index) - Number(b.index));
      if (!list2.length) continue;
      const taken = /* @__PURE__ */ new Set();
      for (const unit of view.units) {
        if (unit.source !== "dra" || !unit.uuid) continue;
        const gpu = list2.find((g) => g.uuid === unit.uuid);
        if (!gpu) continue;
        taken.add(gpu);
        describe(unit, gpu);
      }
      const counted = view.units.filter((u) => u.source === "device-plugin" && u.vendor === "nvidia" && u.partitions.length === 0);
      const cards = list2.filter((g) => !taken.has(g) && !g.mig);
      if (!counted.length || !cards.length) continue;
      if (cards.length !== counted.length) {
        view.notes.push(`DCGM reports ${cards.length} ${cards.length === 1 ? "GPU" : "GPUs"} here and the device plugin advertises ${counted.length}: ${cards.length > counted.length ? "some cards are not handed out" : "some cards are not reported"}, so which card is which is matched in order.`);
      }
      const mapped = cards.some((g) => g.consumers.length > 0);
      counted.forEach((unit, i) => {
        const gpu = cards[i];
        if (!gpu) return;
        describe(unit, gpu);
        unit.label = gpu.index || unit.label;
        unit.name = gpu.index ? `GPU ${gpu.index}` : unit.name;
        if (!mapped) return;
        unit.consumers = gpu.consumers.map((c) => ({ namespace: c.namespace, pod: c.pod, claim: "" }));
        unit.inferred = false;
        if (unit.consumers.length) unit.state = holdState([], unit.consumers, false);
        else if (unit.state !== "unhealthy") unit.state = "free";
      });
    }
  }
  function describe(unit, gpu) {
    unit.uuid ||= gpu.uuid;
    unit.pciBus ||= gpu.pciBus;
    unit.model ||= friendlyModel(gpu.model);
    const total = (gpu.memoryUsed ?? 0) + (gpu.memoryFree ?? 0);
    if (!unit.memory && total > 0) unit.memory = total;
    unit.live = {
      util: gpu.util,
      memoryUsed: gpu.memoryUsed,
      memoryTotal: total > 0 ? total : unit.memory || void 0,
      temperature: gpu.temperature,
      power: gpu.power,
      nvlink: gpu.nvlink
    };
  }
  function applyVisible(views, pods) {
    const byNode = new Map(views.map((v) => [v.name, v]));
    for (const pod of pods) {
      const node = pod.spec?.nodeName;
      if (!node || !isLive(pod)) continue;
      const view = byNode.get(node);
      const visible = view ? visibleDevices(pod) : void 0;
      if (!view || !visible) continue;
      const wanted2 = visible.devices.map((d) => d.toLowerCase());
      const targets = visible.all ? view.units : view.units.filter((u) => wanted2.includes(u.label.toLowerCase()) || u.uuid !== "" && wanted2.includes(u.uuid.toLowerCase()));
      for (const unit of targets) {
        const consumer = { namespace: pod.metadata.namespace ?? "", pod: pod.metadata.name, claim: "", via: visible.env };
        if (unit.consumers.some((c) => c.namespace === consumer.namespace && c.pod === consumer.pod)) continue;
        unit.consumers.push(consumer);
        if (unit.partitions.length === 0) unit.state = holdState(unit.claims, unit.consumers, false);
        if (unit.consumers.every((c) => c.via)) unit.inferred = false;
      }
    }
  }
  function isInUse(unit) {
    return unit.state === "allocated" || unit.state === "shared" || unit.state === "partial";
  }
  function totals(units) {
    const partitions = units.flatMap((u) => u.partitions);
    return {
      total: units.length,
      inUse: units.filter(isInUse).length,
      free: units.filter((u) => u.state === "free").length,
      unhealthy: units.filter((u) => u.state === "unhealthy").length,
      shared: units.filter((u) => u.state === "shared").length,
      partitions: partitions.length,
      partitionsInUse: partitions.filter((p) => p.state === "allocated" || p.state === "shared").length
    };
  }
  function modelKey(unit) {
    const label = unit.model || (unit.source === "dra" ? `${unit.driver} device` : `${VENDOR_NAMES[unit.vendor]} ${resourceNoun(unit.driver)}`);
    return [`${unit.vendor}/${label}`, label];
  }
  function tally(units, by) {
    const out = /* @__PURE__ */ new Map();
    for (const unit of units) {
      const [key, label] = by(unit);
      let t = out.get(key);
      if (!t) {
        t = { key, label, vendor: unit.vendor, total: 0, inUse: 0, free: 0, unhealthy: 0, memory: unit.memory };
        out.set(key, t);
      }
      t.total++;
      if (isInUse(unit)) t.inUse++;
      else if (unit.state === "free") t.free++;
      else if (unit.state === "unhealthy") t.unhealthy++;
      if (!t.memory && unit.memory) t.memory = unit.memory;
    }
    return [...out.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  }

  // src/model/serving.ts
  function shellWords(line) {
    const words = [];
    let word = "";
    let has = false;
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote) quote = "";
        else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
        else word += c;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        has = true;
      } else if (c === "\\" && i + 1 < line.length) {
        const next = line[++i];
        if (next !== "\n") {
          word += next;
          has = true;
        }
      } else if (/\s/.test(c) || c === ";" || c === "&" || c === "|") {
        if (has || word) words.push(word);
        word = "";
        has = false;
      } else {
        word += c;
        has = true;
      }
    }
    if (has || word) words.push(word);
    return words;
  }
  function commandWords(container) {
    const env = new Map((container.env ?? []).filter((e) => e.name && e.value !== void 0).map((e) => [e.name, e.value]));
    const expand = (word) => word.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (whole, name) => env.get(name) ?? whole).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => env.get(a ?? b ?? "") ?? whole);
    let words = [...container.command ?? [], ...container.args ?? []];
    const shell = words.findIndex((w, i) => /^-[a-z]*c$/.test(w) && i > 0 && /(^|\/)(ba|z|da)?sh$/.test(words[i - 1] ?? ""));
    if (shell >= 0) words = [...words.slice(0, shell - 1), ...shellWords(words.slice(shell + 1).join(" "))];
    else if (words.length === 1 && /\s/.test(words[0] ?? "")) words = shellWords(words[0] ?? "");
    return words.map(expand).filter((w) => w !== "");
  }
  function flag(words, names, many = false) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      for (const name of names) {
        if (word === name) {
          for (let j = i + 1; j < words.length && !words[j].startsWith("-"); j++) {
            out.push(words[j]);
            if (!many) break;
          }
        } else if (word.startsWith(`${name}=`)) {
          out.push(word.slice(name.length + 1));
        }
      }
    }
    return out;
  }
  function first(words, names) {
    return flag(words, names)[0] ?? "";
  }
  function positionalAfter(words, word) {
    const at = words.findIndex((w) => word.test(w));
    if (at < 0) return "";
    const next = words[at + 1];
    return next && !next.startsWith("-") ? next : "";
  }
  function envValue(container, ...names) {
    for (const name of names) {
      const value = container.env?.find((e) => e.name === name)?.value;
      if (value) return value;
    }
    return "";
  }
  function base(word) {
    return word.split("/").pop() ?? word;
  }
  function engineOf(container, words = commandWords(container)) {
    const image = (container.image ?? "").toLowerCase();
    const has = (pattern) => words.some((w) => pattern.test(w));
    const commands = words.map(base);
    if (/nvcr\.io\/nim\//.test(image)) return "NIM";
    if (/sglang/.test(image) || has(/^sglang(\.launch_server)?$/)) return "SGLang";
    if (commands.includes("trtllm-serve")) return "TensorRT-LLM";
    if (/vllm/.test(image) || commands.includes("vllm") || has(/^vllm\.entrypoints/)) return "vLLM";
    if (/text-generation-inference/.test(image) || commands.includes("text-generation-launcher")) return "TGI";
    if (/llama[.-]?cpp/.test(image) || commands.includes("llama-server")) return "llama.cpp";
    if (/huggingfaceserver/.test(image) || has(/^huggingfaceserver$/)) return "KServe";
    if (/tritonserver/.test(image) || commands.includes("tritonserver")) return "Triton";
    if (/(^|\/)ollama(:|$)/.test(image) || /\/ollama\//.test(image)) return "Ollama";
    return void 0;
  }
  function servedBy(container) {
    const words = commandWords(container);
    const engine = engineOf(container, words);
    if (!engine) return void 0;
    const int = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    };
    let model = "";
    let names = [];
    let tp = 1;
    let pp = 1;
    switch (engine) {
      case "vLLM":
        model = positionalAfter(words, /^serve$/) || first(words, ["--model"]) || envValue(container, "MODEL", "MODEL_NAME", "MODEL_ID");
        names = flag(words, ["--served-model-name"], true);
        tp = int(first(words, ["--tensor-parallel-size", "-tp"]));
        pp = int(first(words, ["--pipeline-parallel-size", "-pp"]));
        break;
      case "SGLang":
        model = first(words, ["--model-path", "--model"]) || envValue(container, "MODEL", "MODEL_ID");
        names = flag(words, ["--served-model-name"], true);
        tp = int(first(words, ["--tp-size", "--tp", "--tensor-parallel-size"]));
        pp = int(first(words, ["--pp-size", "--pp"]));
        break;
      case "TGI":
        model = first(words, ["--model-id"]) || envValue(container, "MODEL_ID");
        tp = int(first(words, ["--num-shard"]) || envValue(container, "NUM_SHARD"));
        break;
      case "TensorRT-LLM":
        model = positionalAfter(words, /(^|\/)trtllm-serve$/) || first(words, ["--model"]);
        tp = int(first(words, ["--tp_size", "--tp-size"]));
        pp = int(first(words, ["--pp_size", "--pp-size"]));
        break;
      case "llama.cpp":
        model = first(words, ["-hf", "--hf-repo", "-m", "--model"]) || envValue(container, "LLAMA_ARG_HF_REPO", "LLAMA_ARG_MODEL");
        names = flag(words, ["-a", "--alias"]);
        break;
      case "NIM": {
        const image = (container.image ?? "").replace(/^nvcr\.io\/nim\//, "").replace(/[:@].*$/, "");
        model = envValue(container, "NIM_MODEL_NAME") || image;
        names = [envValue(container, "NIM_SERVED_MODEL_NAME")].filter(Boolean);
        tp = int(envValue(container, "NIM_TENSOR_PARALLEL_SIZE"));
        break;
      }
      case "KServe":
        model = first(words, ["--model_id", "--model-id"]) || first(words, ["--model_dir", "--model-dir"]);
        names = flag(words, ["--model_name", "--model-name"]);
        tp = int(first(words, ["--tensor-parallel-size", "--tensor_parallel_size"]));
        break;
      case "Triton":
        model = first(words, ["--model-repository", "--model-store"]);
        break;
      case "Ollama":
        model = "";
        break;
    }
    return {
      container: container.name ?? "",
      engine,
      model,
      names: names.length ? names : model ? [base(model)] : [],
      tensorParallel: tp,
      pipelineParallel: pp,
      maxModelLen: first(words, ["--max-model-len", "--context-length", "--max-total-tokens", "-c", "--ctx-size"]),
      quantization: first(words, ["--quantization", "-q", "--dtype-weights"]),
      gpuMemoryUtilization: first(words, ["--gpu-memory-utilization", "--mem-fraction-static"])
    };
  }
  function servedModels(pods) {
    const out = [];
    for (const pod of pods) {
      if (!isLive(pod)) continue;
      for (const container of pod.spec?.containers ?? []) {
        const served = servedBy(container);
        if (!served) continue;
        out.push({
          ...served,
          namespace: pod.metadata.namespace ?? "",
          pod: pod.metadata.name,
          node: pod.spec?.nodeName ?? "",
          running: (pod.status?.phase ?? "") === "Running"
        });
      }
    }
    return out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.pod.localeCompare(b.pod));
  }
  function shortName2(served) {
    return served.names[0] ?? (served.model ? base(served.model) : served.engine);
  }
  var VLLM_CHARTS = {
    running: "data-vllm-running",
    waiting: "data-vllm-waiting",
    kvCache: "data-vllm-kv-cache",
    tokens: "data-vllm-tokens"
  };
  function readServerLoad(panel) {
    const out = /* @__PURE__ */ new Map();
    if (!panel?.source.available) return out;
    const byId2 = new Map(panel.charts.map((c) => [c.id, c]));
    const put = (id, field) => {
      for (const { labels, value } of current(byId2.get(id))) {
        const namespace = labels["namespace"] ?? labels["exported_namespace"] ?? "";
        const pod = labels["pod"] ?? labels["exported_pod"] ?? "";
        if (!namespace || !pod) continue;
        const key = `${namespace}/${pod}`;
        const load = out.get(key) ?? {};
        load[field] = (load[field] ?? 0) + value;
        out.set(key, load);
      }
    };
    put(VLLM_CHARTS.running, "running");
    put(VLLM_CHARTS.waiting, "waiting");
    put(VLLM_CHARTS.kvCache, "kvCache");
    put(VLLM_CHARTS.tokens, "tokensPerSecond");
    return out;
  }

  // src/model/topology.ts
  var TOPOLOGY_KEY = "topology";
  function ordered(a, b, kind) {
    return Number(a) <= Number(b) ? { a, b, kind } : { a: b, b: a, kind };
  }
  function parseTopology(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, " ").trim());
    const links = /* @__PURE__ */ new Map();
    const add = (a, b, kind) => {
      if (a === b) return;
      const link = ordered(a, b, kind);
      links.set(`${link.a}-${link.b}`, link);
    };
    let sawMatrix = false;
    for (const line of lines) {
      const pair = /^GPU\s*(\d+)\s*(?:<->|<=>|↔|-|—|,)\s*GPU\s*(\d+)\s*[:=]?\s*(NV\d+|NVLink|NVSwitch)?/i.exec(line);
      if (pair && pair[1] !== void 0 && pair[2] !== void 0) add(pair[1], pair[2], (pair[3] ?? "NVLink").toUpperCase().replace("NVLINK", "NVLink").replace("NVSWITCH", "NVSwitch"));
    }
    const header = lines.find((l) => l.split(/\s+/).includes("GPU0") && !l.split(/\s+/).includes("X") && !/<->|↔/.test(l));
    if (header) {
      const columns = header.split(/\s+/).filter((c) => c !== "");
      const first2 = columns.indexOf("GPU0");
      const names = columns.slice(first2);
      for (const line of lines) {
        const row = /^GPU(\d+)\s+(.*)$/.exec(line);
        if (!row || row[1] === void 0) continue;
        const cells = (row[2] ?? "").split(/\s+/);
        sawMatrix = true;
        names.forEach((column, i) => {
          const other = /^GPU(\d+)$/.exec(column)?.[1];
          const cell = cells[i] ?? "";
          if (other !== void 0 && /^NV\d+$/i.test(cell)) add(row[1], other, cell.toUpperCase());
        });
      }
    }
    const list2 = [...links.values()].sort((x, y) => Number(x.a) - Number(y.a) || Number(x.b) - Number(y.b));
    return list2.length > 0 || sawMatrix ? list2 : null;
  }
  function linkLines(links) {
    return links.map((l) => `GPU ${l.a} <-> GPU ${l.b}: ${l.kind}`);
  }
  function productWiring(model) {
    const name = model.replace(/[_-]+/g, " ").replace(/^NVIDIA\s+/i, "").trim();
    const has = (pattern) => pattern.test(name);
    if (has(/\bG[BH]\d{3}\b/i) || has(/\bNVL\s?\d{2,}\b/i)) return { fabric: "nvswitch", kind: "NVLink", product: name };
    if (has(/\bH100\b.*\bNVL\b/i)) return { fabric: "pairs", kind: "NV12", product: name };
    if (has(/\bH200\b.*\bNVL\b/i) || has(/\bNVL\b/i)) return { fabric: "pairs", kind: "NVLink", product: name };
    if (has(/\bSXM\d?\b/i) || has(/\b(H100|H800)\b.*\bHBM3\b/i) || has(/\b(H200|H20|B200|B300|B100)\b/i)) return { fabric: "nvswitch", kind: "NVSwitch", product: name };
    if (has(/\b(L4|L40S?|L20|T4|A10G?|A2|A16|T1000|RTX\s?(A?\d{4}|PRO)|Tesla\s?T4)\b/i)) return { fabric: "none", kind: "", product: name };
    return { fabric: "unknown", kind: "", product: name };
  }
  function nodeTopology(model, indexes, labels = {}, pasted) {
    const clique = labels["nvidia.com/gpu.clique"] ?? "";
    const cliqueNote = clique ? ` Its GPUs are in the multi-node NVLink domain ${clique}, with every other node GFD labels with the same clique.` : "";
    const sorted = [...new Set(indexes)].sort((a, b) => Number(a) - Number(b));
    if (pasted) {
      return {
        fabric: "links",
        links: pasted,
        source: "pasted",
        sentence: pasted.length ? `${pasted.length} NVLink ${pasted.length === 1 ? "connection" : "connections"}, as nvidia-smi on the machine reported them.${cliqueNote}` : `No NVLink between these GPUs, as nvidia-smi on the machine reported it.${cliqueNote}`,
        clique
      };
    }
    if (sorted.length < 2) {
      return { fabric: "none", links: [], source: "none", sentence: sorted.length ? `One GPU: nothing to link it to.${cliqueNote}` : "", clique };
    }
    const wiring = productWiring(model);
    const product = wiring.product || "this model";
    switch (wiring.fabric) {
      case "pairs": {
        const links = [];
        for (let i = 0; i + 1 < sorted.length; i += 2) links.push(ordered(sorted[i], sorted[i + 1], wiring.kind));
        return {
          fabric: "pairs",
          links,
          source: "model",
          sentence: `${product} cards are sold in pairs joined by NVLink bridges. Which cards are paired is read from their order (${links.map((l) => `${l.a}–${l.b}`).join(", ")}); paste nvidia-smi topo -m to confirm it.${cliqueNote}`,
          clique
        };
      }
      case "nvswitch": {
        const links = [];
        for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) links.push(ordered(sorted[i], sorted[j], wiring.kind));
        return {
          fabric: "nvswitch",
          links,
          source: "model",
          sentence: `${product} is an SXM part: on an HGX board NVSwitch joins every GPU to every other at full NVLink bandwidth. Read from the model, not the machine; paste nvidia-smi topo -m to confirm it.${cliqueNote}`,
          clique
        };
      }
      case "none":
        return { fabric: "none", links: [], source: "model", sentence: `${product} has no NVLink: its GPUs talk over PCIe.${cliqueNote}`, clique };
      default:
        return {
          fabric: "unknown",
          links: [],
          source: "none",
          sentence: `Nothing in the cluster says how these GPUs are linked. Paste nvidia-smi topo -m from the machine to draw its NVLinks.${cliqueNote}`,
          clique
        };
    }
  }
  function linkGroups(indexes, links) {
    const parent = new Map(indexes.map((i) => [i, i]));
    const find = (x) => {
      let root = x;
      while (parent.get(root) !== root && parent.get(root) !== void 0) root = parent.get(root);
      parent.set(x, root);
      return root;
    };
    for (const link of links) {
      if (!parent.has(link.a) || !parent.has(link.b)) continue;
      const [ra, rb] = [find(link.a), find(link.b)];
      if (ra !== rb) parent.set(Number(ra) < Number(rb) ? rb : ra, Number(ra) < Number(rb) ? ra : rb);
    }
    const groups = /* @__PURE__ */ new Map();
    for (const index of indexes) groups.set(find(index), [...groups.get(find(index)) ?? [], index]);
    return [...groups.values()].map((g) => g.sort((a, b) => Number(a) - Number(b))).sort((a, b) => Number(a[0]) - Number(b[0]));
  }

  // src/ui/dom.ts
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === void 0 || value === false) continue;
      if (name === "class") node.className = String(value);
      else if (name === "text") node.textContent = String(value);
      else node.setAttribute(name, String(value));
    }
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      node.append(child);
    }
    return node;
  }
  function button(label, onClick, attrs = {}) {
    const node = el("button", { type: "button", ...attrs }, label);
    node.addEventListener("click", onClick);
    return node;
  }
  function replace(parent, ...children) {
    parent.replaceChildren();
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      parent.append(child);
    }
  }
  function byId(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node;
  }

  // src/ui/parts.ts
  function pill(text, tone = "", title = "") {
    return el("span", { class: `pill pill-${tone || "none"}`, ...title ? { title } : {} }, text);
  }
  function block(title, note, ...children) {
    return el("section", { class: "block" }, el("h2", {}, title), note ? el("p", { class: "note" }, note) : null, ...children.filter((c) => c !== null));
  }
  function nothing(message2) {
    return el("p", { class: "empty" }, message2);
  }
  function heading(title, note) {
    return el(
      "header",
      { class: "page-head" },
      el("img", { class: "mark", src: "logo.svg", alt: "", width: 28, height: 28 }),
      el("div", {}, el("h1", {}, title), note ? el("p", { class: "note" }, note) : null)
    );
  }
  function clickable(node, onPick) {
    node.classList.add("pick");
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.addEventListener("click", onPick);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onPick();
      }
    });
    return node;
  }
  function openName(label, ref, className = "link-name") {
    const node = el("button", { type: "button", class: className, title: `Open ${label}` }, label);
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      void k8sdockside.open(ref);
    });
    return node;
  }

  // src/ui/grid.ts
  var STATE_WORDS = {
    free: "Free",
    allocated: "In use",
    shared: "Shared",
    partial: "Partly in use",
    unhealthy: "Unhealthy"
  };
  function modelsLine(units) {
    const counts = /* @__PURE__ */ new Map();
    for (const unit of units) {
      const name = [unit.model || VENDOR_NAMES[unit.vendor], memory(unit.memory) && !/\d+\s?GB/i.test(unit.model) ? memory(unit.memory) : ""].filter(Boolean).join(" ");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, n]) => `${n} × ${name}`).join(" · ");
  }
  function usePill(units) {
    const used = units.filter(isInUse).length;
    const bad = units.filter((u) => u.state === "unhealthy").length;
    const tone = bad ? "warn" : used === units.length ? "info" : used === 0 ? "ok" : "";
    return pill(`${used} of ${units.length} in use${bad ? ` · ${bad} unhealthy` : ""}`, tone);
  }
  function sourcePills(units) {
    const out = [];
    if (units.some((u) => u.source === "dra")) out.push(pill("DRA", "dra", "Published by a DRA driver in ResourceSlices"));
    if (units.some((u) => u.source === "device-plugin")) out.push(pill("device plugin", "dp", "Advertised by a device plugin as an extended resource"));
    if (units.some((u) => u.live)) out.push(pill("DCGM", "dp", "NVIDIA’s DCGM exporter, through Prometheus: which card is which, who has it, and how busy it is"));
    return out;
  }

  // src/ui/page.ts
  function fail(host, err) {
    replace(host, el("div", { class: "failure" }, el("strong", {}, "That did not work. "), el("span", {}, message(err))));
  }
  function message(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function start(hostId, body) {
    const run = async () => {
      const host = document.getElementById(hostId);
      try {
        const ctx = await k8sdockside.ready();
        await body(ctx);
      } catch (err) {
        if (host) fail(host, err);
      }
    };
    void run();
  }
  function every(ms, body, onError) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        await body();
      } catch (err) {
        onError(err);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), ms);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
  async function remembered(key, fallback) {
    try {
      const value = await k8sdockside.storage?.get(key);
      return value === null || value === void 0 ? fallback : value;
    } catch {
      return fallback;
    }
  }
  function remember(key, value) {
    void k8sdockside.storage?.set(key, value)?.catch(() => void 0);
  }

  // src/ui/load.ts
  var KINDS = [
    ["nodes", NODES],
    ["pods", PODS],
    ["slices", SLICES],
    ["claims", CLAIMS],
    ["templates", TEMPLATES],
    ["classes", CLASSES],
    ["daemonSets", DAEMONSETS],
    ["events", EVENTS]
  ];
  async function loadSnapshot(options = {}) {
    const snap = emptySnapshot();
    const lists = snap;
    await Promise.all(
      KINDS.filter(([field]) => field === "events" ? options.events !== false : field === "daemonSets" ? options.daemonSets !== false : true).map(async ([field, kind]) => {
        try {
          lists[field] = await k8sdockside.list({ kind });
        } catch (err) {
          snap.missing[kind] = message(err);
        }
      })
    );
    if (snap.missing[NODES]) throw new Error(`could not read the cluster's nodes: ${snap.missing[NODES]}`);
    return snap;
  }
  function servesDra(snap) {
    return !snap.missing[SLICES];
  }
  function dcgmReader(minutes = 10, every2 = 45e3) {
    let panel = null;
    let asked = 0;
    let failure = "";
    return async (snap, gpuNodes = []) => {
      if (!panel || Date.now() - asked >= every2) {
        asked = Date.now();
        try {
          panel = await k8sdockside.charts({ minutes });
          failure = "";
        } catch (err) {
          failure = message(err);
        }
      }
      return { dcgm: panel ? readDcgm(panel, snap.nodes, snap.pods, gpuNodes) : noDcgm(failure), panel };
    };
  }
  async function inventoryWithDcgm(snap, read) {
    const plain = buildInventory(snap);
    const metrics = await read(
      snap,
      plain.nodes.map((n) => n.name).filter((n) => n !== "")
    );
    return { ...metrics, inventory: metrics.dcgm.gpus.length ? buildInventory(snap, metrics.dcgm.gpus) : plain };
  }

  // src/pages/gpus.ts
  var REFRESH = 15e3;
  start("page", async (ctx) => {
    replace(byId("head"), heading("GPUs", `Every GPU in ${ctx.contextName}, from every source that describes it, in one picture.`));
    const body = byId("body");
    const failure = el("p", { class: "refresh-failure" });
    let pasted = await remembered(TOPOLOGY_KEY, {});
    if (!pasted || typeof pasted !== "object") pasted = {};
    let picture = null;
    const editors = /* @__PURE__ */ new Map();
    const setPasted = (node, links) => {
      const next = { ...pasted };
      if (links) next[node] = links;
      else delete next[node];
      pasted = next;
      remember(TOPOLOGY_KEY, next);
      if (picture) picture = { ...picture, boards: boards(picture.snap, picture.inventory, picture.served, pasted) };
      draw();
    };
    const editor = (node) => {
      let host = editors.get(node);
      if (!host) {
        host = topologyEditor(node, () => pasted[node] !== void 0, setPasted);
        editors.set(node, host);
      }
      host.dispatchEvent(new Event("refresh"));
      return host;
    };
    const draw = () => {
      if (!picture) return;
      const p = picture;
      const units = p.inventory.units;
      if (units.length === 0) {
        replace(body, failure, sourcesBlock(p), nothing("No GPUs here: no node advertises one through a device plugin, no DRA driver publishes one, and DCGM reports none."));
        return;
      }
      replace(
        body,
        failure,
        summaryLine(p),
        ...p.boards.map((board) => boardCard(board, p.load)),
        modelsBlock(p),
        inventoryBlock(p),
        topologyBlock(p, editor),
        sourcesBlock(p),
        textBlock(p)
      );
    };
    const read = dcgmReader();
    const stop = every(
      REFRESH,
      async () => {
        const snap = await loadSnapshot({ events: false });
        const { inventory, dcgm, panel } = await inventoryWithDcgm(snap, read);
        const served = servedModels(snap.pods);
        picture = { snap, inventory, dcgm, served, load: readServerLoad(panel), boards: boards(snap, inventory, served, pasted) };
        failure.textContent = "";
        document.getElementById("first")?.remove();
        draw();
      },
      (err) => {
        failure.textContent = message(err);
      }
    );
    addEventListener("pagehide", stop);
  });
  function boards(snap, inventory, served, pasted) {
    const nodes = new Map(snap.nodes.map((n) => [n.metadata.name, n]));
    return inventory.nodes.map((view) => {
      const cards = view.units.map((unit) => ({ unit, served: served.filter((s) => unit.consumers.some((c) => c.namespace === s.namespace && c.pod === s.pod)) }));
      const node = nodes.get(view.name);
      const model = view.card.product || view.units.find((u) => u.model)?.model || "";
      const topology = nodeTopology(
        model,
        view.units.map((u) => u.label),
        node?.metadata.labels ?? {},
        pasted[view.name]
      );
      return { view, cards, topology, notes: boardNotes(view, snap.pods.filter((p) => isLive(p) && p.spec?.nodeName === view.name), served) };
    });
  }
  function boardNotes(view, pods, served) {
    const notes = [];
    const counted = view.units.every((u) => u.source === "device-plugin" && !u.live) && !view.card.product;
    if (counted && view.units.length) {
      notes.push(
        `Only the device plugin describes these cards: it says there are ${view.units.length}, not what they are. GPU feature discovery (node labels) or NVIDIA’s DCGM exporter in Prometheus would name the model, its memory, the driver and each card’s UUID.`
      );
    }
    const byEnv = pods.filter((p) => visibleDevices(p));
    if (byEnv.length) {
      const vars = [...new Set(byEnv.map((p) => visibleDevices(p)?.env ?? ""))].join(" or ");
      notes.push(
        `${list(byEnv.map((p) => p.metadata.name))} ${byEnv.length === 1 ? "picks its GPU" : "pick their GPUs"} with ${vars} instead of asking the scheduler for one. The cards are drawn as in use, but the scheduler still counts them free and may give them to another pod that asks for nvidia.com/gpu.`
      );
    }
    const unmatched = byEnv.filter((p) => !view.units.some((u) => u.consumers.some((c) => c.namespace === p.metadata.namespace && c.pod === p.metadata.name)));
    for (const pod of unmatched) {
      const visible = visibleDevices(pod);
      notes.push(
        `${pod.metadata.name} names ${visible?.devices.join(", ")} in ${visible?.env}, and no card here is known by that name: the device plugin numbers its cards but does not say their UUIDs. DCGM or a DRA driver would, or name the card by its index.`
      );
    }
    const unknown = served.filter((s) => s.node === view.name).map((s) => pods.find((p) => p.metadata.namespace === s.namespace && p.metadata.name === s.pod)).filter((p) => p !== void 0 && !asksScheduler(p) && !visibleDevices(p));
    if (unknown.length) {
      const one = unknown.length === 1;
      const runtime = unknown.some(nvidiaRuntime) ? ` ${one ? "It runs" : "They run"} with NVIDIA’s runtime class, which hands out GPUs outside the scheduler, so` : " So";
      notes.push(
        `${list(unknown.map((p) => p.metadata.name))} ${one ? "serves a model here but asks" : "serve models here but ask"} the scheduler for no GPU and ${one ? "names" : "name"} none in NVIDIA_VISIBLE_DEVICES or CUDA_VISIBLE_DEVICES.${runtime} which card ${one ? "it uses" : "each uses"} is not in the pod’s spec. Set NVIDIA_VISIBLE_DEVICES on the pod — or better, ask for nvidia.com/gpu — and it is drawn on its card.`
      );
    }
    return notes;
  }
  function list(names) {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  function gpuName(unit, many) {
    return `${many && unit.node ? `${unit.node} / ` : ""}${unit.label}`;
  }
  function allocation(card) {
    if (card.served.length) return [...new Set(card.served.map(shortName2))].join(", ");
    if (card.unit.consumers.length) return card.unit.consumers.map((c) => c.pod).join(", ");
    if (card.unit.claims.length) return `claim ${card.unit.claims.map((c) => c.name).join(", ")}`;
    return card.unit.state === "unhealthy" ? "unhealthy" : "free";
  }
  function summaryLine(p) {
    const t = p.inventory.totals;
    const machines = p.boards.filter((b) => b.view.name).length;
    const models = new Set(p.served.map(shortName2)).size;
    return el(
      "p",
      { class: "summary" },
      `${count(t.total, "GPU")} on ${count(machines, "machine")}, ${t.inUse} in use`,
      models ? `, serving ${count(models, "model")}` : "",
      "."
    );
  }
  function boardCard(board, load) {
    const { view, topology } = board;
    const byLabel = new Map(board.cards.map((c) => [c.unit.label, c]));
    const groups = linkGroups(
      board.cards.map((c) => c.unit.label),
      topology.links
    );
    const row = el("div", { class: "board-row" });
    for (const group of groups) {
      const cards = group.map((label) => byLabel.get(label)).filter((c) => c !== void 0);
      if (cards.length === 1 && cards[0]) {
        row.append(gpuCard(cards[0], load));
        continue;
      }
      const kinds = [...new Set(topology.links.filter((l) => group.includes(l.a) && group.includes(l.b)).map((l) => l.kind))];
      const frame = el(
        "div",
        { class: `nvl-group${topology.source === "model" ? " guessed" : ""}`, title: topology.sentence },
        el("span", { class: "nvl-tag" }, `NVLink${kinds.length ? ` · ${kinds.join(", ")}` : ""}${topology.source === "model" ? " (from the model)" : ""}`)
      );
      const inner = el("div", { class: "nvl-cards" });
      cards.forEach((card, i) => {
        if (i > 0 && topology.fabric !== "nvswitch") inner.append(el("span", { class: "nvl-bridge", "aria-hidden": "true" }));
        inner.append(gpuCard(card, load));
      });
      frame.append(inner);
      if (topology.fabric === "nvswitch") frame.append(el("div", { class: "nvl-switch" }, "NVSwitch — every GPU to every other"));
      row.append(frame);
    }
    const name = view.name ? openName(view.name, { kind: NODES, name: view.name }, "link-name node-name") : el("span", { class: "node-name" }, "Not tied to a node");
    return el(
      "article",
      { class: "board" },
      el(
        "div",
        { class: "node-head" },
        name,
        !view.ready && view.name ? pill("NotReady", "error") : null,
        view.unschedulable ? pill("cordoned", "warn") : null,
        el("span", { class: "spacer" }),
        usePill(view.units)
      ),
      el("div", { class: "node-sub" }, el("span", {}, modelsLine(view.units)), ...sourcePills(view.units), versions(view)),
      row,
      ...board.notes.map((note) => el("p", { class: "board-note" }, note)),
      topology.sentence ? el("p", { class: "hint" }, topology.sentence) : null,
      ...view.notes.map((note) => el("p", { class: "hint" }, note))
    );
  }
  function versions(view) {
    const driver = [...new Set(view.units.map((u) => u.driverVersion).filter(Boolean))];
    const cuda = [...new Set(view.units.map((u) => u.cudaVersion).filter(Boolean))];
    return driver.length ? el("span", { class: "faint" }, `driver ${driver.join(", ")}${cuda.length ? ` · CUDA ${cuda.join(", ")}` : ""}`) : null;
  }
  function gpuCard(card, load) {
    const { unit } = card;
    const live = unit.live;
    const node = el(
      "div",
      { class: `gpu-card card-${unit.state}`, "data-unit": unit.id },
      el(
        "div",
        { class: "card-top" },
        el("span", { class: `swatch fill-state-${unit.state}`, "aria-hidden": "true" }),
        el("span", { class: "card-index" }, /^\d+$/.test(unit.label) ? `GPU ${unit.label}` : unit.name),
        el("span", { class: "spacer" }),
        el("span", { class: "card-state" }, STATE_WORDS[unit.state])
      ),
      el("div", { class: "card-model" }, unit.model || VENDOR_NAMES[unit.vendor], unit.memory && !/\d+\s?GB/i.test(unit.model) ? el("span", { class: "faint" }, ` · ${memory(unit.memory)}`) : null),
      unit.uuid || unit.pciBus ? el("div", { class: "card-ids mono" }, unit.uuid ? el("span", { title: unit.uuid }, shortUuid(unit.uuid)) : null, unit.pciBus ? el("span", { title: "PCI bus" }, unit.pciBus.replace(/^0000/, "")) : null) : null
    );
    if (live) {
      const total = live.memoryTotal ?? unit.memory;
      if (live.memoryUsed !== void 0 && total) {
        const bar = el("div", { class: "meter", role: "img", "aria-label": `${memory(live.memoryUsed) || "0"} of ${memory(total)} in use` });
        const fill = el("span", { class: "meter-fill" });
        fill.style.width = `${percent(live.memoryUsed, total)}%`;
        bar.append(fill);
        node.append(el("div", { class: "card-meter" }, el("span", { class: "meter-label" }, `${memory(live.memoryUsed) || "0"} / ${memory(total)}`), bar));
      }
      const numbers = [
        live.util !== void 0 ? `${Math.round(live.util * 100)}% busy` : "",
        live.temperature !== void 0 ? `${Math.round(live.temperature)} °C` : "",
        live.power !== void 0 ? `${Math.round(live.power)} W` : "",
        live.nvlink ? `NVLink ${rate(live.nvlink)}` : ""
      ].filter(Boolean);
      if (numbers.length) node.append(el("div", { class: "card-numbers" }, numbers.join(" · ")));
    }
    const work = el("div", { class: "card-work" });
    if (card.served.length) {
      for (const s of card.served) {
        const l = load.get(`${s.namespace}/${s.pod}`);
        work.append(
          el(
            "div",
            { class: "served" },
            el("div", { class: "served-head" }, el("strong", { class: "served-name" }, shortName2(s)), pill(s.engine, "info"), s.tensorParallel > 1 ? pill(`TP ${s.tensorParallel}`, "", "Tensor parallel: the model is split across this many GPUs") : null),
            s.model && s.model !== shortName2(s) ? el("div", { class: "served-model mono", title: s.model }, s.model) : null,
            l ? el("div", { class: "served-load faint" }, loadLine(l)) : null,
            el("div", { class: "served-pod" }, openName(`${s.namespace}/${s.pod}`, { kind: PODS, namespace: s.namespace, name: s.pod }, "link-name small")),
            viaLine(unit, s.namespace, s.pod)
          )
        );
      }
    } else if (unit.consumers.length) {
      for (const c of unit.consumers) work.append(el("div", { class: "served-pod" }, openName(`${c.namespace}/${c.pod}`, { kind: PODS, namespace: c.namespace, name: c.pod }, "link-name small"), viaLine(unit, c.namespace, c.pod)));
    } else {
      work.append(el("span", { class: "faint" }, unit.claims.length ? `held by claim ${unit.claims.map((c) => c.name).join(", ")}` : unit.state === "unhealthy" ? "cannot be handed out" : "nothing on it"));
    }
    if (unit.inferred && unit.consumers.some((c) => !c.via)) work.append(el("div", { class: "card-guess" }, "placed by count: the device plugin does not say which card"));
    if (unit.problem) work.append(el("div", { class: "card-problem" }, unit.problem));
    node.append(work);
    clickable(node, () => {
      remember("inventory.pin", unit.id);
      void k8sdockside.openView("inventory");
    });
    node.title = "Open the inventory on this GPU";
    return node;
  }
  function viaLine(unit, namespace, pod) {
    const via = unit.consumers.find((c) => c.namespace === namespace && c.pod === pod)?.via;
    return via ? el("div", { class: "card-guess", title: "The scheduler does not know this pod has the card" }, `via ${via}, not the scheduler`) : null;
  }
  function mappingSource(unit, served) {
    const c = unit.consumers.find((x) => x.namespace === served.namespace && x.pod === served.pod);
    if (c?.via) return `the pod’s ${c.via}`;
    if (c?.claim) return "its ResourceClaim";
    if (unit.inferred) return "the device plugin’s count (marked ~)";
    return "DCGM’s pod mapping";
  }
  function rate(bytes) {
    const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
    let n = bytes;
    let i = 0;
    while (n >= 1e3 && i < units.length - 1) {
      n /= 1e3;
      i++;
    }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }
  function loadLine(l) {
    return [
      l.running !== void 0 ? `${Math.round(l.running)} running` : "",
      l.waiting ? `${Math.round(l.waiting)} waiting` : "",
      l.kvCache !== void 0 ? `KV cache ${Math.round(l.kvCache * 100)}%` : "",
      l.tokensPerSecond !== void 0 ? `${Math.round(l.tokensPerSecond)} tok/s` : ""
    ].filter(Boolean).join(" · ");
  }
  function table(head, rows) {
    return el(
      "div",
      { class: "table-wrap" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...head.map((h) => el("th", {}, h)))),
        el("tbody", {}, ...rows.map((cells) => el("tr", {}, ...cells.map((c) => el("td", {}, c)))))
      )
    );
  }
  function allCards(p) {
    return p.boards.flatMap((b) => b.cards);
  }
  function modelsBlock(p) {
    if (p.served.length === 0) {
      return block(
        "Models on the GPUs",
        "",
        nothing("No inference server among the pods. vLLM, SGLang, TGI, TensorRT-LLM, llama.cpp, NIM, KServe, Triton and Ollama are recognised by their image and command line.")
      );
    }
    const many = p.boards.length > 1;
    const rows = [];
    const placed = /* @__PURE__ */ new Set();
    for (const card of allCards(p)) {
      for (const s of card.served) {
        placed.add(s);
        rows.push(modelRow(gpuName(card.unit, many), s, card.unit.inferred, p.load));
      }
    }
    for (const s of p.served) {
      if (!placed.has(s)) rows.push(modelRow(s.running ? "—" : "waiting", s, false, p.load));
    }
    const hasLoad = p.served.some((s) => p.load.has(`${s.namespace}/${s.pod}`));
    const head = ["GPU", "Short name", "Source model", "Engine", "Namespace", "Pod", ...hasLoad ? ["Now"] : []];
    const sources = [...new Set(allCards(p).flatMap((c) => c.served.map((s) => mappingSource(c.unit, s))))];
    const unplaced = p.served.some((s) => !placed.has(s) && s.running);
    const note = [
      "The model is read from each server’s command line.",
      sources.length ? ` Which GPU it is on, from ${list(sources)}.` : "",
      unplaced ? " A — is a server whose card cannot be read from the cluster; the notes under its machine say why." : ""
    ].join("");
    return block(
      "Models on the GPUs",
      note,
      table(
        head,
        rows.map((r) => hasLoad ? r : r.slice(0, 6))
      )
    );
  }
  function modelRow(gpu, s, inferred, load) {
    const l = load.get(`${s.namespace}/${s.pod}`);
    return [
      el("span", { class: "mono" }, inferred ? `~${gpu}` : gpu),
      el("strong", {}, shortName2(s)),
      el("span", { class: "mono" }, s.model || "(pulled at run time)"),
      [s.engine, s.tensorParallel > 1 ? `TP ${s.tensorParallel}` : "", s.pipelineParallel > 1 ? `PP ${s.pipelineParallel}` : ""].filter(Boolean).join(" · "),
      s.namespace,
      openName(s.pod, { kind: PODS, namespace: s.namespace, name: s.pod }),
      l ? loadLine(l) : ""
    ];
  }
  function inventoryBlock(p) {
    const many = p.boards.length > 1;
    const rows = allCards(p).map((card) => [
      el("span", { class: "mono" }, gpuName(card.unit, many)),
      card.unit.model ? `${card.unit.vendor === "nvidia" && !/^NVIDIA\b/i.test(card.unit.model) ? "NVIDIA " : ""}${card.unit.model}` : VENDOR_NAMES[card.unit.vendor],
      el("span", { class: "mono" }, card.unit.uuid || "—"),
      el("span", { class: "mono" }, card.unit.pciBus || "—"),
      el("span", { class: isInUse(card.unit) ? "" : "faint" }, `${card.unit.inferred && card.unit.consumers.length ? "~" : ""}${allocation(card)}`)
    ]);
    const missing = allCards(p).some((c) => !c.unit.uuid);
    return block(
      "GPU inventory",
      missing ? "UUIDs and PCI addresses come from DCGM or a DRA driver; a card neither describes is counted from its node, and has none to show." : "Every card with its UUID and PCI address, and what is allocated on it.",
      table(["GPU", "Model", "UUID", "PCI bus", "Allocation"], rows)
    );
  }
  function topologyBlock(p, editor) {
    const many = p.boards.length > 1;
    const sections = p.boards.filter((b) => b.view.name && b.cards.length > 1).map(
      (b) => el(
        "div",
        { class: "topo" },
        many ? el("h3", {}, b.view.name) : null,
        b.topology.links.length ? el("ul", { class: "topo-links mono" }, ...linkLines(b.topology.links).map((line) => el("li", {}, line))) : el("p", { class: "faint", style: "margin:0 0 6px" }, b.topology.fabric === "none" ? "No NVLink." : "Not known."),
        el("p", { class: "hint" }, sourceWords(b.topology)),
        editor(b.view.name)
      )
    );
    if (sections.length === 0) return block("NVLink connections", "", nothing("No machine has more than one GPU, so there is nothing to link."));
    return block("NVLink connections", "Which GPUs share an NVLink: what nvidia-smi on the machine says when it has been pasted here, else what the model is built as.", ...sections);
  }
  function sourceWords(t) {
    switch (t.source) {
      case "pasted":
        return "From nvidia-smi topo -m, pasted here and kept for this cluster.";
      case "model":
        return "From the model, not the machine.";
      default:
        return t.fabric === "none" ? "" : "Nothing in the cluster says; paste nvidia-smi topo -m to draw them.";
    }
  }
  function topologyEditor(node, saved, onSave) {
    const area = el("textarea", { rows: 7, spellcheck: "false", placeholder: "nvidia-smi topo -m\n\n        GPU0    GPU1    GPU2    GPU3\nGPU0     X      NV12    SYS     SYS\n…\n\nor lines like  GPU 0 <-> GPU 1: NV12", "aria-label": `nvidia-smi topo -m for ${node}` });
    const status = el("span", { class: "faint" });
    const forget = button("Forget it", () => {
      onSave(node, void 0);
      status.textContent = "Forgotten: back to what the model says.";
    });
    const save = button(
      "Use this",
      () => {
        const links = parseTopology(area.value);
        if (!links) {
          status.textContent = "No GPU matrix or GPU <-> GPU lines in that.";
          return;
        }
        onSave(node, links);
        area.value = "";
        status.textContent = `Kept: ${count(links.length, "NVLink")}.`;
      },
      { class: "primary" }
    );
    const box = el(
      "details",
      { class: "topo-edit" },
      el("summary", {}, `Paste nvidia-smi topo -m from ${node}`),
      area,
      el("div", { class: "topo-buttons" }, save, forget, status),
      k8sdockside.storage ? null : el("p", { class: "hint" }, "This version of the app cannot keep it: it is used until the page is closed.")
    );
    box.addEventListener("refresh", () => {
      forget.hidden = !saved();
    });
    return box;
  }
  function sourcesBlock(p) {
    const units = p.inventory.units;
    const dp = units.filter((u) => u.source === "device-plugin");
    const dra = units.filter((u) => u.source === "dra");
    const gfd = p.snap.nodes.filter((n) => n.metadata.labels?.["nvidia.com/gpu.product"] || n.metadata.labels?.["nvidia.com/gpu.present"] === "true");
    const status = p.dcgm.status;
    const engines = [...new Set(p.served.map((s) => s.engine))];
    const pastedBoards = p.boards.filter((b) => b.topology.source === "pasted").length;
    const modelBoards = p.boards.filter((b) => b.topology.source === "model" && b.topology.links.length).length;
    const envPods = p.snap.pods.filter((pod) => isLive(pod) && visibleDevices(pod));
    const dpResources = [...new Set(dp.map((u) => u.driver === "nvidia.com/mig" ? "nvidia.com/mig-*" : u.driver))];
    const rows = [
      {
        name: "Device plugin",
        tone: dp.length ? "ok" : "none",
        gives: "how many GPUs each node has, and how many each pod asked for",
        finding: dp.length ? `${count(dp.length, "card")} as ${dpResources.join(", ")} on ${count(new Set(dp.map((u) => u.node)).size, "node")}.` : "No node advertises a GPU as an extended resource."
      },
      {
        name: "Dynamic Resource Allocation",
        tone: dra.length ? "ok" : "none",
        gives: "exactly which device each claim holds, with its UUID and attributes",
        finding: !servesDra(p.snap) ? "This cluster does not serve resource.k8s.io." : dra.length ? `${count(dra.length, "device")} from ${[...new Set(dra.map((u) => u.driver))].join(", ")}.` : "Served, but no DRA driver publishes a GPU."
      },
      {
        name: "GPU feature discovery",
        tone: gfd.length ? "ok" : "none",
        gives: "the model, its memory, the driver and CUDA versions, as node labels",
        finding: gfd.length ? `${count(gfd.length, "node")} labelled: ${[...new Set(gfd.map((n) => n.metadata.labels?.["nvidia.com/gpu.product"] ?? "").filter(Boolean))].join(", ") || "no product named"}.` : "No node carries nvidia.com/gpu.* labels."
      },
      {
        name: "DCGM exporter, in Prometheus",
        tone: status.found ? status.mapping || units.every((u) => !u.consumers.length) ? "ok" : "warn" : "none",
        gives: "each card’s index, UUID and PCI bus, the pod holding it, and how busy and full it is",
        finding: dcgmFinding(p.dcgm, p.inventory)
      },
      {
        name: "Inference servers",
        tone: p.served.length ? "ok" : "none",
        gives: "which model each GPU has loaded, from the server’s command line",
        finding: p.served.length ? `${count(p.served.length, "server")} (${engines.join(", ")}) serving ${count(new Set(p.served.map(shortName2)).size, "model")}.` : "None of the pods is a server this page recognises."
      },
      {
        name: "Pod env",
        tone: envPods.length ? "ok" : "none",
        gives: "the cards a pod picks with NVIDIA_VISIBLE_DEVICES or CUDA_VISIBLE_DEVICES, outside the scheduler",
        finding: envPods.length ? `${count(envPods.length, "pod")} ${envPods.length === 1 ? "names its" : "name their"} GPUs this way.` : "No pod names its GPUs in its env."
      },
      {
        name: "NVLink topology",
        tone: pastedBoards ? "ok" : modelBoards ? "warn" : "none",
        gives: "which GPUs share an NVLink",
        finding: pastedBoards ? `Pasted from nvidia-smi for ${count(pastedBoards, "machine")}${modelBoards ? `; ${count(modelBoards, "machine")} from the model` : ""}.` : modelBoards ? `Read from the model for ${count(modelBoards, "machine")}: nothing in the cluster says. Paste nvidia-smi topo -m to confirm it.` : "Nothing in the cluster says, and the model does not settle it."
      }
    ];
    const list2 = el("ul", { class: "sources" });
    for (const row of rows) {
      list2.append(
        el(
          "li",
          { class: `source source-${row.tone}` },
          el("span", { class: `dot dot-${row.tone === "none" ? "none" : row.tone}` }),
          el("div", {}, el("div", { class: "source-name" }, row.name, el("span", { class: "faint" }, ` — ${row.gives}`)), el("div", { class: "source-finding" }, row.finding))
        )
      );
    }
    return block("Where this comes from", "No one source knows everything about a GPU in Kubernetes. What each one said here:", list2);
  }
  function dcgmFinding(dcgm, inventory) {
    const s = dcgm.status;
    if (!s.prometheus) return s.error || "No Prometheus was found, so which card each pod has is counted rather than read.";
    if (!s.found) return `Prometheus (${s.describe}) has no DCGM metrics. NVIDIA’s dcgm-exporter publishes them; the GPU Operator installs it.`;
    const unmatched = s.unmatched.length ? ` Hosts matching no node: ${s.unmatched.join(", ")}.` : "";
    const mapped = s.mapping ? "with pod mapping, so which pod has which card is read, not counted." : inventory.units.some((u) => u.consumers.length) ? "without pod mapping: turn on DCGM_EXPORTER_KUBERNETES in the exporter to see which pod has which card." : "and no pod is on them.";
    return `${count(dcgm.gpus.length, "card")} on ${count(new Set(dcgm.gpus.map((g) => g.node)).size, "host")} through ${s.describe}, ${mapped}${unmatched}`;
  }
  function asText(p) {
    const out = [];
    const many = p.boards.length > 1;
    for (const board of p.boards) {
      if (many) out.push(`== ${board.view.name || "not tied to a node"} ==`, "");
      const rows = [];
      for (const card of board.cards) for (const s of card.served) rows.push([`${card.unit.inferred ? "~" : ""}${card.unit.label}`, shortName2(s), s.model, s.namespace, s.pod]);
      if (rows.length) {
        const head = ["GPU", "SHORT NAME", "SOURCE MODEL", "NAMESPACE", "POD"];
        const least = [5, 18, 42, 24, 3];
        const widths = head.map((h, i) => i === head.length - 1 ? 3 : Math.max(least[i] ?? 0, h.length, ...rows.map((r) => (r[i] ?? "").length)));
        const line = (cells) => cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
        out.push(line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line), "");
      }
      out.push("GPU inventory");
      for (const card of board.cards) {
        const u = card.unit;
        const model = u.model ? `${u.vendor === "nvidia" && !/^NVIDIA\b/i.test(u.model) ? "NVIDIA " : ""}${u.model}` : VENDOR_NAMES[u.vendor];
        out.push(`GPU ${u.label}: ${[model, u.uuid, u.pciBus].filter(Boolean).join(" | ")} | allocation: ${allocation(card)}`);
      }
      if (board.topology.links.length) out.push("", "NVLink connections", ...linkLines(board.topology.links));
      out.push("");
    }
    return out.join("\n").trimEnd() + "\n";
  }
  function textBlock(p) {
    const pre = el("pre", { class: "as-text" }, asText(p));
    return el("details", { class: "block text-block" }, el("summary", {}, "As text"), el("p", { class: "note" }, "All of the above as plain text, to copy into a ticket or a chat."), pre);
  }
})();
