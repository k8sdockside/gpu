// Built by scripts/build.mjs from src/ -- edit the TypeScript there, not this file.
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
  function isPending(pod) {
    return (pod.status?.phase ?? "Pending") === "Pending" && !pod.spec?.nodeName;
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
  function where(namespace, name) {
    return namespace ? `${namespace}/${name}` : name;
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

  // src/model/attention.ts
  function isAcceleratorDaemonSet(ds) {
    const names = [ds.metadata.name, ds.metadata.labels?.["app"] ?? "", ds.metadata.labels?.["app.kubernetes.io/name"] ?? ""].join(" ").toLowerCase();
    return /nvidia|gpu|dcgm|amdgpu|habana|gaudi|neuron|(^|[-\s])dra([-\s]|$)|dra-driver|kubeletplugin|kubelet-plugin|device-plugin/.test(names);
  }
  function acceleratorDaemons(daemonSets) {
    return daemonSets.filter(isAcceleratorDaemonSet).map((ds) => {
      const desired = ds.status?.desiredNumberScheduled ?? 0;
      const ready = ds.status?.numberReady ?? 0;
      const tone = desired === 0 ? "" : ready >= desired ? "ok" : ready === 0 ? "error" : "warn";
      return { namespace: ds.metadata.namespace ?? "", name: ds.metadata.name, desired, ready, tone };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  function drivers(inventory, slices) {
    const out = /* @__PURE__ */ new Map();
    const nodes = /* @__PURE__ */ new Map();
    for (const unit of inventory.units) {
      const name = unit.source === "dra" ? unit.driver : unit.partitions.length ? "nvidia.com/mig-*" : unit.driver;
      const key = `${unit.source}/${name}`;
      const view = out.get(key) ?? { name, kind: unit.source === "dra" ? "DRA driver" : "device plugin", vendor: VENDOR_NAMES[unit.vendor], nodes: 0, devices: 0 };
      view.devices++;
      const seen = nodes.get(key) ?? /* @__PURE__ */ new Set();
      seen.add(unit.node);
      nodes.set(key, seen);
      view.nodes = seen.size;
      out.set(key, view);
    }
    for (const slice of slices) {
      const driver = slice.spec?.driver ?? "";
      if (!driver || !isAcceleratorDriver(driver) || out.has(`dra/${driver}`)) continue;
      out.set(`dra/${driver}`, { name: driver, kind: "DRA driver", vendor: VENDOR_NAMES[driverVendor(driver)], nodes: 0, devices: 0 });
    }
    return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }
  var RANK = { error: 0, warn: 1, info: 2, ok: 3, "": 4 };
  function issues(inventory, workloads, daemons) {
    const out = [];
    for (const pod of workloads.pods) {
      if (!pod.pending) continue;
      const wants = pod.wants.map((w) => w.short).join(", ");
      out.push({
        tone: pod.never ? "error" : "warn",
        title: pod.never ? `${where(pod.namespace, pod.name)} can never start` : `${where(pod.namespace, pod.name)} is waiting for devices`,
        detail: pod.never ? pod.never.replace(/^This can never be scheduled: /, "").replace(/^./, (c) => c.toUpperCase()) : `${pod.reason}${wants ? ` It asks for ${wants}.` : ""}`,
        ref: { kind: PODS, namespace: pod.namespace, name: pod.name }
      });
    }
    for (const node of inventory.nodes) {
      if (!node.name) continue;
      const lost = node.units.filter((u) => u.state === "unhealthy");
      const lostCells = node.units.flatMap((u) => u.partitions).filter((p) => p.state === "unhealthy");
      if (!node.ready) {
        out.push({
          tone: "error",
          title: `${node.name} is not Ready`,
          detail: `Its ${count(node.units.length, "accelerator")} cannot be used until the node is back.`,
          ref: { kind: NODES, name: node.name }
        });
      }
      if (lost.length > 0) {
        const first = lost[0];
        out.push({
          tone: "warn",
          title: `${node.name} has lost ${lost.length === 1 ? "a device" : `${lost.length} devices`}`,
          detail: `${lost.length} of ${node.units.length} ${first?.model || "devices"} cannot be handed out. ${first?.problem ?? ""}`.trim(),
          ref: { kind: NODES, name: node.name }
        });
      } else if (lostCells.length > 0) {
        out.push({
          tone: "warn",
          title: `${node.name} has ${count(lostCells.length, "unhealthy MIG instance")}`,
          detail: "The device plugin reports them unhealthy; they are left out of what the node can give.",
          ref: { kind: NODES, name: node.name }
        });
      }
      const free = node.units.filter((u) => u.state === "free").length;
      if (node.unschedulable && free > 0) {
        out.push({
          tone: "info",
          title: `${node.name} is cordoned`,
          detail: `${count(free, "free accelerator")} on it cannot take new pods until it is uncordoned.`,
          ref: { kind: NODES, name: node.name }
        });
      }
      for (const note of node.notes) out.push({ tone: "info", title: `${node.name} advertises its cards twice`, detail: note, ref: { kind: NODES, name: node.name } });
    }
    for (const claim of workloads.claims) {
      if (claim.state === "allocated" && claim.pods.length === 0) {
        out.push({
          tone: "info",
          title: `${where(claim.namespace, claim.name)} holds devices nobody uses`,
          detail: `${claim.held.map((h) => h.label).join(", ") || "Its devices"} ${claim.held.length === 1 ? "is" : "are"} set aside for it with no pod using ${claim.held.length === 1 ? "it" : "them"}.`,
          ref: { kind: CLAIMS, namespace: claim.namespace, name: claim.name }
        });
      }
      if (claim.state === "pending" && !workloads.pods.some((p) => p.pending && p.namespace === claim.namespace && p.claims.includes(claim.name))) {
        out.push({
          tone: "info",
          title: `${where(claim.namespace, claim.name)} is not allocated`,
          detail: claim.why,
          ref: { kind: CLAIMS, namespace: claim.namespace, name: claim.name }
        });
      }
    }
    for (const daemon of daemons) {
      if (daemon.tone !== "warn" && daemon.tone !== "error") continue;
      out.push({
        tone: daemon.tone,
        title: `${daemon.name} is not ready everywhere`,
        detail: `${daemon.ready} of ${daemon.desired} pods ready. Nodes without it cannot advertise or prepare their devices.`,
        ref: { kind: DAEMONSETS, namespace: daemon.namespace, name: daemon.name }
      });
    }
    return out.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
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
  function requestsOf(spec) {
    return (spec?.devices?.requests ?? []).map(readRequest);
  }
  function readRequest(request) {
    const alternatives = request.firstAvailable ?? [];
    const exact = request.exactly ?? (request.deviceClassName ? request : alternatives[0] ?? {});
    const all = exact.allocationMode === "All";
    return {
      name: request.name ?? "",
      deviceClass: exact.deviceClassName ?? "",
      alternatives: alternatives.slice(request.exactly || request.deviceClassName ? 0 : 1).map((a) => a.deviceClassName ?? "").filter((c) => c !== ""),
      count: all ? Infinity : Math.max(1, exact.count ?? 1),
      adminAccess: exact.adminAccess === true
    };
  }
  function requestedDevices(requests) {
    let count2 = 0;
    let all = false;
    for (const request of requests) {
      if (request.adminAccess) continue;
      if (request.count === Infinity) all = true;
      else count2 += request.count;
    }
    return { count: count2, all };
  }
  function claimState(claim) {
    if (claim.metadata.deletionTimestamp) return "deleting";
    if (!claim.status?.allocation) return "pending";
    if ((claim.status.reservedFor ?? []).length > 0) return "reserved";
    return "allocated";
  }
  function allocatedDevices(claim) {
    return (claim.status?.allocation?.devices?.results ?? []).filter((r) => r.adminAccess !== true && r.device);
  }
  function reservedPods(claim) {
    return (claim.status?.reservedFor ?? []).filter((r) => (r.resource ?? "pods") === "pods" && !r.apiGroup).map((r) => r.name ?? "").filter((n) => n !== "");
  }
  function claimOwnerPod(claim) {
    const owner = (claim.metadata.ownerReferences ?? []).find((o) => o.kind === "Pod" && o.controller);
    return owner?.name ?? "";
  }
  function classDriver(deviceClass) {
    for (const selector of deviceClass?.spec?.selectors ?? []) {
      const match = /device\.driver\s*==\s*["']([^"']+)["']/.exec(selector.cel?.expression ?? "");
      if (match?.[1]) return match[1];
    }
    return "";
  }
  function classDeviceType(deviceClass) {
    for (const selector of deviceClass?.spec?.selectors ?? []) {
      const match = /\.type\s*==\s*["']([^"']+)["']/.exec(selector.cel?.expression ?? "");
      if (match?.[1]) return match[1];
    }
    return "";
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
      const list = (byNode.get(view.name) ?? []).sort((a, b) => Number(a.index) - Number(b.index));
      if (!list.length) continue;
      const taken = /* @__PURE__ */ new Set();
      for (const unit of view.units) {
        if (unit.source !== "dra" || !unit.uuid) continue;
        const gpu = list.find((g) => g.uuid === unit.uuid);
        if (!gpu) continue;
        taken.add(gpu);
        describe(unit, gpu);
      }
      const counted = view.units.filter((u) => u.source === "device-plugin" && u.vendor === "nvidia" && u.partitions.length === 0);
      const cards = list.filter((g) => !taken.has(g) && !g.mig);
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

  // src/model/workloads.ts
  function buildWorkloads(snap, inventory) {
    const classResources = new Set(snap.classes.map((c) => c.spec?.extendedResourceName ?? "").filter((n) => n !== ""));
    const claimsByKey = new Map(snap.claims.map((c) => [`${c.metadata.namespace ?? ""}/${c.metadata.name}`, c]));
    const templatesByKey = new Map(snap.templates.map((t) => [`${t.metadata.namespace ?? ""}/${t.metadata.name}`, t]));
    const classes = new Map(snap.classes.map((c) => [c.metadata.name, c]));
    const limits = capacityLimits(snap.nodes, inventory, classes);
    const heldByClaim = /* @__PURE__ */ new Map();
    for (const claim of snap.claims) heldByClaim.set(`${claim.metadata.namespace ?? ""}/${claim.metadata.name}`, claimHeld(claim, inventory));
    const heldByPod = /* @__PURE__ */ new Map();
    for (const unit of inventory.units) {
      if (unit.source !== "device-plugin") continue;
      const cells = unit.partitions.length ? unit.partitions.map((p) => ({ holders: p.consumers, label: `${p.profile} on ${unit.name}`, partitionId: p.id })) : [{ holders: unit.consumers, label: unit.name, partitionId: "" }];
      for (const cell of cells) {
        for (const c of cell.holders) {
          const key = `${c.namespace}/${c.pod}`;
          heldByPod.set(key, [...heldByPod.get(key) ?? [], { unitId: unit.id, partitionId: cell.partitionId, label: cell.label, node: unit.node, model: unit.model, claim: "", inferred: unit.inferred }]);
        }
      }
    }
    const pods = [];
    for (const pod of snap.pods) {
      if (!isLive(pod)) continue;
      const ns = pod.metadata.namespace ?? "";
      const requests = podDeviceRequests(pod, classResources);
      const claims2 = podClaims(pod);
      if (Object.keys(requests).length === 0 && claims2.length === 0) continue;
      const wants = [];
      for (const [resource, n] of Object.entries(requests)) {
        if (n > 0) wants.push({ text: `${n} × ${resource.replace(CLASS_RESOURCE_PREFIX, "class ")}`, short: `${n} × ${resource.replace(CLASS_RESOURCE_PREFIX, "class ")}`, count: n, all: false });
      }
      const held = [...heldByPod.get(`${ns}/${pod.metadata.name}`) ?? []];
      const names = [];
      let missingClaim = "";
      for (const c of claims2) {
        const claim = c.claim ? claimsByKey.get(`${ns}/${c.claim}`) : void 0;
        const template = c.template ? templatesByKey.get(`${ns}/${c.template}`) : void 0;
        const reqs = requestsOf(claim?.spec ?? template?.spec?.spec);
        const n = requestedDevices(reqs);
        const classesAsked = [...new Set(reqs.map((r) => r.deviceClass).filter((x) => x))].join(", ");
        wants.push({
          text: `${n.all ? "all" : n.count} × ${classesAsked || "device"} (claim ${c.claim || c.entry}${c.template ? ` from template ${c.template}` : ""})`,
          short: `${n.all ? "all" : n.count} × ${classesAsked || "device"}`,
          count: n.count,
          all: n.all
        });
        if (c.claim) names.push(c.claim);
        if (c.claim && !claim && !c.template) missingClaim = c.claim;
        if (!c.claim && c.template && !template) missingClaim = `template ${c.template}`;
        if (claim) held.push(...heldByClaim.get(`${ns}/${claim.metadata.name}`) ?? []);
      }
      const pending = isPending(pod);
      const view = {
        namespace: ns,
        name: pod.metadata.name,
        node: pod.spec?.nodeName ?? "",
        phase: pod.status?.phase ?? "Pending",
        pending,
        created: pod.metadata.creationTimestamp ?? "",
        wants,
        held: dedupe(held),
        claims: names,
        reason: "",
        detail: "",
        never: ""
      };
      if (pending) explain(view, pod, snap.events, requests, claims2.map((c) => requestsOf((c.claim ? claimsByKey.get(`${ns}/${c.claim}`) : void 0)?.spec ?? (c.template ? templatesByKey.get(`${ns}/${c.template}`) : void 0)?.spec?.spec)), limits, missingClaim);
      pods.push(view);
    }
    pods.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name, void 0, { numeric: true }));
    const podsByName = new Map(pods.map((p) => [`${p.namespace}/${p.name}`, p]));
    const claims = snap.claims.map((claim) => {
      const ns = claim.metadata.namespace ?? "";
      const users = reservedPods(claim);
      const owner = claimOwnerPod(claim);
      const naming = pods.filter((p) => p.namespace === ns && p.claims.includes(claim.metadata.name)).map((p) => p.name);
      const view = {
        namespace: ns,
        name: claim.metadata.name,
        state: claimState(claim),
        requests: requestsOf(claim.spec),
        held: heldByClaim.get(`${ns}/${claim.metadata.name}`) ?? [],
        pods: users,
        owner,
        template: templateOf(claim, snap.pods),
        shared: users.length > 1,
        why: "",
        created: claim.metadata.creationTimestamp ?? ""
      };
      view.why = claimWhy(view, [.../* @__PURE__ */ new Set([...naming, ...owner ? [owner] : []])].map((name) => podsByName.get(`${ns}/${name}`)).filter((p) => p !== void 0));
      return view;
    });
    claims.sort((a, b) => stateOrder(a.state) - stateOrder(b.state) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    const templates = snap.templates.map((t) => ({
      namespace: t.metadata.namespace ?? "",
      name: t.metadata.name,
      requests: requestsOf(t.spec?.spec),
      pods: snap.pods.filter((p) => isLive(p) && p.metadata.namespace === t.metadata.namespace && (p.spec?.resourceClaims ?? []).some((c) => c.resourceClaimTemplateName === t.metadata.name)).length
    }));
    const waiting = pods.filter((p) => p.pending);
    return {
      pods,
      claims,
      templates,
      demand: { pods: waiting.length, devices: waiting.reduce((n, p) => n + p.wants.reduce((m, w) => m + w.count, 0), 0), all: waiting.some((p) => p.wants.some((w) => w.all)) }
    };
  }
  function stateOrder(state) {
    return { pending: 0, deleting: 1, allocated: 2, reserved: 3 }[state];
  }
  function dedupe(held) {
    const seen = /* @__PURE__ */ new Set();
    return held.filter((h) => {
      const key = `${h.unitId}/${h.partitionId}/${h.claim}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function claimHeld(claim, inventory) {
    const out = [];
    for (const result of allocatedDevices(claim)) {
      const entry = inventory.byKey.get(deviceKey(result.driver ?? "", result.pool ?? "", result.device ?? ""));
      const unit = entry?.unit;
      out.push({
        unitId: unit?.id ?? "",
        partitionId: entry?.partition?.id ?? "",
        label: entry?.partition ? `${entry.partition.profile || entry.partition.name} on ${unit?.name ?? ""}` : result.device ?? "",
        node: unit?.node ?? "",
        model: unit?.model ?? "",
        claim: claim.metadata.name,
        inferred: false
      });
    }
    return out;
  }
  function templateOf(claim, pods) {
    const owner = claimOwnerPod(claim);
    const entry = claim.metadata.annotations?.["resource.kubernetes.io/pod-claim-name"];
    if (!owner || !entry) return "";
    const pod = pods.find((p) => p.metadata.name === owner && p.metadata.namespace === claim.metadata.namespace);
    return pod?.spec?.resourceClaims?.find((c) => c.name === entry)?.resourceClaimTemplateName ?? "";
  }
  function claimWhy(claim, pods) {
    switch (claim.state) {
      case "deleting":
        return "Being deleted. Its devices go back to the pool once the pods using it are gone.";
      case "reserved":
        return claim.shared ? `Shared by ${count(claim.pods.length, "pod")}: they use the same ${claim.held.length === 1 ? "device" : "devices"} at once.` : `In use by ${claim.pods[0] ?? "a pod"}.`;
      case "allocated":
        return "Devices are set aside for it, but no pod is using it right now.";
      case "pending": {
        const waiting = pods.find((p) => p.pending);
        if (waiting) {
          const why = waiting.never || waiting.reason || "The scheduler has not placed it yet.";
          return `Not allocated: ${waiting.name} is waiting. ${why}`;
        }
        if (pods.length === 0) return "Not allocated, and no pod uses it. Devices are allocated when the first pod using the claim is scheduled.";
        return "Not allocated yet. The scheduler allocates it together with the pod that uses it.";
      }
    }
  }
  function capacityLimits(nodes, inventory, classes) {
    const resources = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      for (const [name, value] of Object.entries(node.status?.allocatable ?? {})) {
        if (!isDeviceResource(name)) continue;
        resources.set(name, Math.max(resources.get(name) ?? 0, quantity(value)));
      }
    }
    const classLimits = /* @__PURE__ */ new Map();
    const extended = /* @__PURE__ */ new Map();
    for (const [name, deviceClass] of classes) {
      if (deviceClass.spec?.extendedResourceName) extended.set(deviceClass.spec.extendedResourceName, name);
      const driver = classDriver(deviceClass);
      if (!driver) continue;
      const type = classDeviceType(deviceClass);
      const perNode = /* @__PURE__ */ new Map();
      for (const unit of inventory.units) {
        if (unit.source !== "dra" || unit.driver !== driver || unit.state === "unhealthy") continue;
        const n = type === "mig" ? unit.partitions.filter((p) => !p.dynamic && p.state !== "unhealthy").length : 1;
        perNode.set(unit.node, (perNode.get(unit.node) ?? 0) + n);
      }
      classLimits.set(name, Math.max(0, ...perNode.values()));
    }
    return { resources, classes: classLimits, extended };
  }
  function explain(view, pod, events, requests, claimRequests, limits, missingClaim) {
    const scheduled = condition(pod.status?.conditions, "PodScheduled");
    const event = events.filter((e) => e.reason === "FailedScheduling" && e.involvedObject?.kind === "Pod" && e.involvedObject.name === pod.metadata.name && e.involvedObject.namespace === pod.metadata.namespace).sort((a, b) => (b.lastTimestamp ?? b.eventTime ?? "").localeCompare(a.lastTimestamp ?? a.eventTime ?? ""))[0];
    const message2 = scheduled?.status === "False" && scheduled.message ? scheduled.message : event?.message ?? "";
    view.detail = message2;
    const nevers = [];
    const judgeClass = (deviceClass, n) => {
      const most = limits.classes.get(deviceClass);
      if (most === void 0) return;
      if (most === 0) nevers.push(`no node has a ${deviceClass} device`);
      else if (n > most) nevers.push(`it asks for ${count(n, `${deviceClass} device`)} and the biggest node has ${most}`);
    };
    for (const [resource, n] of Object.entries(requests)) {
      if (resource.startsWith(CLASS_RESOURCE_PREFIX)) judgeClass(resource.slice(CLASS_RESOURCE_PREFIX.length), n);
      else if (limits.resources.has(resource)) {
        const most = limits.resources.get(resource) ?? 0;
        if (n > most) nevers.push(`it asks for ${n} ${resource} and the biggest node has ${most}`);
      } else if (limits.extended.has(resource)) judgeClass(limits.extended.get(resource) ?? "", n);
      else nevers.push(`no node has any ${resource}`);
    }
    for (const reqs of claimRequests) {
      for (const request of reqs) {
        if (request.adminAccess || request.count === Infinity || request.alternatives.length > 0) continue;
        judgeClass(request.deviceClass, request.count);
      }
    }
    if (missingClaim) {
      view.reason = `It uses ${missingClaim.startsWith("template ") ? "ResourceClaimTemplate " + missingClaim.slice(9) : "ResourceClaim " + missingClaim}, which does not exist.`;
      return;
    }
    if (nevers.length) {
      view.never = `This can never be scheduled: ${nevers.join("; ")}.`;
      view.reason = view.never;
      return;
    }
    view.reason = message2 ? plainReason(message2) : scheduled?.status === "False" ? "The scheduler could not place it yet." : "Waiting for the scheduler.";
  }
  function plainReason(message2) {
    const match = /^\s*0\/(\d+) nodes are available:\s*(.*?)(?:\.\s*preemption:.*)?\.?\s*$/s.exec(message2);
    if (!match) {
      if (/resourceclaim .* not found|not found.*resourceclaim/i.test(message2)) return "A ResourceClaim it uses does not exist yet.";
      return message2.trim();
    }
    const parts = (match[2] ?? "").split(/,\s+(?=\d+\s)/);
    const phrases = [];
    let short = "";
    for (const part of parts) {
      const m = /^(\d+)\s+(.*)$/.exec(part.trim());
      if (!m) continue;
      const n = Number(m[1]);
      const why = (m[2] ?? "").trim();
      const nodes = count(n, "node");
      let phrase;
      const insufficient = /^Insufficient\s+(\S+)/.exec(why);
      if (insufficient) {
        const resource = insufficient[1] ?? "";
        phrase = `${nodes} ${n === 1 ? "does" : "do"} not have enough ${resource} free`;
        if (isDeviceResource(resource)) short = `No node has enough free ${resourceNoun(resource)}s (${resource})`;
      } else if (/cannot allocate all claims/i.test(why)) {
        phrase = `${nodes} ${n === 1 ? "has" : "have"} no free device that matches its claims`;
        short = "No node has a free device that matches its claims";
      } else if (/untolerated taint/i.test(why)) {
        phrase = `${nodes} ${n === 1 ? "is" : "are"} tainted and it does not tolerate that`;
      } else if (/didn't match Pod's node affinity\/selector/i.test(why)) {
        phrase = `${nodes} ${n === 1 ? "does" : "do"} not match its node selector`;
      } else if (/unschedulable/i.test(why)) {
        phrase = `${nodes} ${n === 1 ? "is" : "are"} cordoned`;
      } else if (/resourceclaim.*not found|waiting for .*claim/i.test(why)) {
        phrase = `its claim is not ready (${why})`;
      } else if (/Too many pods/i.test(why)) {
        phrase = `${nodes} ${n === 1 ? "is" : "are"} full of pods`;
      } else {
        phrase = `${nodes}: ${why}`;
      }
      phrases.push([n, phrase]);
    }
    const list = phrases.map(([, p]) => p).join("; ");
    if (short) return `${short}. Of ${count(Number(match[1]), "node")}: ${list}.`;
    return `None of the ${count(Number(match[1]), "node")} can take it: ${list}.`;
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
  function isDataChart(id) {
    return id.startsWith("data-");
  }
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
    const list = [...gpus.values()].sort((a, b) => a.node.localeCompare(b.node) || Number(a.index) - Number(b.index) || a.uuid.localeCompare(b.uuid));
    status.mapping = list.some((g) => g.consumers.length > 0);
    status.unmatched = [...unmatched].sort();
    return { gpus: list, status };
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
  function svgEl(tag, attrs = {}, ...children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    for (const child of children) node.append(child);
    return node;
  }
  function ring(title, slices, options = {}) {
    const total = slices.reduce((n, s) => n + s.count, 0);
    const R = 54;
    const C = 2 * Math.PI * R;
    const drawing = svgEl("svg", { viewBox: "0 0 140 140", class: "ring-svg", "aria-hidden": "true" });
    drawing.append(svgEl("circle", { cx: 70, cy: 70, r: R, class: "ring-track", fill: "none", "stroke-width": 16 }));
    let offset = 0;
    for (const slice of slices) {
      if (slice.count <= 0) continue;
      const fraction = total > 0 ? slice.count / total : 0;
      drawing.append(
        svgEl("circle", {
          cx: 70,
          cy: 70,
          r: R,
          fill: "none",
          "stroke-width": 16,
          class: `ring-arc arc-${slice.tone || "none"}`,
          "stroke-dasharray": `${(fraction * C).toFixed(2)} ${C.toFixed(2)}`,
          "stroke-dashoffset": `${(-offset * C).toFixed(2)}`,
          transform: "rotate(-90 70 70)"
        })
      );
      offset += fraction;
    }
    const legend2 = el("ul", { class: "legend" });
    for (const slice of slices) {
      const row = el(
        "li",
        { class: slice.count === 0 ? "legend-row zero" : "legend-row" },
        el("span", { class: `dot dot-${slice.tone || "none"}` }),
        el("span", { class: "legend-label" }, slice.label),
        el("span", { class: "legend-count" }, String(slice.count))
      );
      if (options.onPick && slice.count > 0) clickable(row, () => options.onPick?.(slice.label));
      legend2.append(row);
    }
    return el(
      "section",
      { class: "ring-card" },
      el("h2", {}, title),
      options.note ? el("p", { class: "note" }, options.note) : null,
      el(
        "div",
        { class: "ring-body" },
        el(
          "div",
          { class: "ring-holder" },
          drawing,
          el("div", { class: "ring-centre" }, el("span", { class: "ring-total" }, String(total)), el("span", { class: "ring-unit" }, options.unit ?? ""))
        ),
        legend2
      )
    );
  }
  function stack(slices, whole = slices.reduce((n, s) => n + s.count, 0), className = "stack") {
    const bar = el("div", { class: className, role: "img", "aria-label": slices.map((s) => `${s.count} ${s.label}`).join(", ") });
    for (const slice of slices) {
      if (slice.count <= 0) continue;
      const piece = el("span", { class: `stack-part fill-${slice.tone || "none"}`, title: `${slice.count} ${slice.label}` });
      piece.style.width = `${percent(slice.count, whole)}%`;
      bar.append(piece);
    }
    return bar;
  }
  function legend(slices, options = {}) {
    const list = el("ul", { class: "swatches" });
    for (const slice of slices) {
      list.append(
        el(
          "li",
          { class: slice.count === 0 && options.counts ? "zero" : "" },
          el("span", { class: `swatch fill-${slice.tone || "none"}`, "aria-hidden": "true" }),
          el("span", {}, slice.label),
          options.counts ? el("strong", {}, String(slice.count)) : null
        )
      );
    }
    return list;
  }
  function pill(text, tone = "", title = "") {
    return el("span", { class: `pill pill-${tone || "none"}`, ...title ? { title } : {} }, text);
  }
  function tile(label, value, note = "", tone = "", extra = null) {
    return el(
      "div",
      { class: `tile tile-${tone || "none"}` },
      el("div", { class: "tile-label" }, label),
      el("div", { class: "tile-value" }, value),
      note ? el("div", { class: "tile-note" }, note) : null,
      extra
    );
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

  // src/ui/charts.ts
  function sparkline(points, width = 220, height = 44, colour = 1) {
    const line = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "spark", preserveAspectRatio: "none", "aria-hidden": "true" });
    if (points.length < 2) return line;
    const first = points[0]?.t ?? 0;
    const last = points[points.length - 1]?.t ?? 1;
    const top = Math.max(...points.map((p) => p.v), 0);
    const span = Math.max(1, last - first);
    const xy = points.map((p) => [(p.t - first) / span * width, height - 2 - (top > 0 ? p.v / top * (height - 6) : 0)]);
    const path = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    line.append(
      svgEl("polygon", { points: `0,${height} ${path} ${width},${height}`, class: `spark-fill chart-fill-${colour}` }),
      svgEl("polyline", { points: path, fill: "none", class: `spark-line chart-line-${colour}`, "stroke-width": 1.6, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" })
    );
    return line;
  }
  function formatValue(unit, value) {
    if (!Number.isFinite(value)) return "—";
    switch (unit) {
      case "percent":
        return `${(value * 100).toFixed(0)}%`;
      case "bytes": {
        const units = ["B", "KiB", "MiB", "GiB", "TiB"];
        let size = value;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) {
          size /= 1024;
          index++;
        }
        return `${size.toFixed(size < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
      }
      case "count":
        return value.toFixed(0);
      default:
        return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
    }
  }
  async function chartsBlock() {
    let panel;
    try {
      panel = await k8sdockside.charts({ minutes: 180 });
    } catch {
      return null;
    }
    if (!panel.attached) return null;
    panel = { ...panel, charts: panel.charts.filter((chart) => !isDataChart(chart.id)) };
    const title = "From DCGM, the last three hours";
    if (!panel.source.available) {
      return block(
        title,
        "",
        el(
          "p",
          { class: "faint", style: "margin:0" },
          panel.source.error || "No Prometheus was found in this cluster, so there is no utilisation to show. Everything above comes from the Kubernetes API and does not need one."
        )
      );
    }
    const drawn = panel.charts.filter((chart) => chart.series.some((s) => s.points.length > 1));
    if (drawn.length === 0) {
      return block(
        title,
        "",
        el(
          "p",
          { class: "faint", style: "margin:0" },
          `Prometheus (${panel.source.describe}) has no DCGM metrics. NVIDIA's dcgm-exporter publishes them — the GPU Operator installs it — and run-ai's fake-gpu-operator simulates them on a cluster with no GPUs.`
        )
      );
    }
    const cards = el("div", { class: "charts" });
    for (const chart of panel.charts) {
      const series = chart.series.filter((s) => s.points.length > 0);
      const total = series.length === 1 ? series[0] : void 0;
      const last = total?.points[total.points.length - 1];
      const card = el(
        "div",
        { class: "chart", title: chart.description },
        el("div", { class: "chart-head" }, el("span", { class: "chart-label" }, chart.label), el("span", { class: "chart-value" }, last ? formatValue(chart.unit, last.v) : ""))
      );
      if (series.length === 0) {
        card.append(el("p", { class: "faint chart-empty" }, chart.error || "No data in this window."));
      } else if (total) {
        card.append(sparkline(total.points));
      } else {
        const shown = [...series].sort((a, b) => (b.points[b.points.length - 1]?.v ?? 0) - (a.points[a.points.length - 1]?.v ?? 0)).slice(0, 4);
        shown.forEach((s, i) => {
          const tail = s.points[s.points.length - 1];
          card.append(el("div", { class: "chart-series" }, el("span", { class: `dot chart-dot-${i + 1}` }), el("span", { class: "chart-series-name" }, s.name), el("span", { class: "chart-series-value" }, tail ? formatValue(chart.unit, tail.v) : "—")));
          card.append(sparkline(s.points, 220, 22, i + 1));
        });
        if (series.length > shown.length) card.append(el("p", { class: "faint chart-more" }, `and ${series.length - shown.length} more`));
      }
      cards.append(card);
    }
    return block(title, "Utilisation and memory from NVIDIA’s DCGM exporter, through the cluster’s Prometheus.", cards);
  }

  // src/ui/grid.ts
  var STATE_WORDS = {
    free: "Free",
    allocated: "In use",
    shared: "Shared",
    partial: "Partly in use",
    unhealthy: "Unhealthy"
  };

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

  // src/pages/overview.ts
  var REFRESH = 15e3;
  start("page", async (ctx) => {
    replace(byId("head"), heading("GPU & Accelerators", `Every accelerator in ${ctx.contextName}, and who is using it.`));
    const body = byId("body");
    const failure = el("p", { class: "refresh-failure" });
    const charts = chartsBlock();
    const read = dcgmReader();
    const stop = every(
      REFRESH,
      async () => {
        const snap = await loadSnapshot();
        const { inventory } = await inventoryWithDcgm(snap, read);
        const work = buildWorkloads(snap, inventory);
        const daemons = acceleratorDaemons(snap.daemonSets);
        failure.textContent = "";
        document.getElementById("first")?.remove();
        if (inventory.units.length === 0 && work.pods.length === 0) {
          replace(body, failure, empty(ctx, servesDra(snap)), await charts);
          return;
        }
        replace(
          body,
          failure,
          tiles(inventory, work),
          fleet(inventory),
          el("div", { class: "split" }, models(inventory.byModel), vendors(inventory)),
          attention(issues(inventory, work, daemons)),
          driverBlock(drivers(inventory, snap.slices), daemons, servesDra(snap)),
          await charts,
          links(ctx)
        );
      },
      (err) => {
        failure.textContent = message(err);
      }
    );
    addEventListener("pagehide", stop);
  });
  function tiles(inv, work) {
    const t = inv.totals;
    const nodes = inv.nodes.filter((n) => n.name).length;
    const waiting = work.demand;
    return el(
      "div",
      { class: "tiles" },
      tile("Accelerators", String(t.total), `on ${count(nodes, "node")}${t.partitions ? ` · ${count(t.partitions, "MIG instance")}` : ""}`, "accent"),
      tile("In use", String(t.inUse), t.total ? `${percent(t.inUse, t.total).toFixed(0)}% of the fleet${t.shared ? ` · ${t.shared} shared` : ""}` : "nothing to use", "info"),
      tile("Free", String(t.free), t.unhealthy ? `and ${t.unhealthy} more that are unhealthy` : "ready for the next pod", "ok"),
      tile(
        "Waiting for",
        waiting.all ? `${waiting.devices}+` : String(waiting.devices),
        waiting.pods ? `${count(waiting.pods, "pod")} pending` : "no pod is waiting",
        waiting.pods ? "warn" : "none"
      )
    );
  }
  function fleet(inv) {
    const t = inv.totals;
    const slices = [
      { label: STATE_WORDS.allocated, count: inv.units.filter((u) => u.state === "allocated").length, tone: "state-allocated" },
      { label: STATE_WORDS.partial, count: inv.units.filter((u) => u.state === "partial").length, tone: "state-partial" },
      { label: STATE_WORDS.shared, count: t.shared, tone: "state-shared" },
      { label: STATE_WORDS.free, count: t.free, tone: "state-free" },
      { label: STATE_WORDS.unhealthy, count: t.unhealthy, tone: "state-unhealthy" }
    ];
    const open = button("Open the inventory", () => void k8sdockside.openView("inventory"), { class: "primary" });
    return el(
      "section",
      { class: "block fleet" },
      el("div", { class: "fleet-head" }, el("h2", {}, "The fleet"), el("span", { class: "spacer" }), open),
      stack(slices, t.total, "stack big"),
      legend(slices.filter((s) => s.count > 0 || s.tone === "state-free"), { counts: true })
    );
  }
  function models(byModel) {
    const list = el("ul", { class: "models" });
    for (const t of byModel) {
      const row = el(
        "li",
        { class: "model" },
        el("span", { class: "model-count" }, `${t.total}×`),
        el("div", { class: "model-body" }, el("div", { class: "model-name" }, t.label, t.memory && !/\d+\s?GB/i.test(t.label) ? el("span", { class: "faint" }, ` ${memory(t.memory)}`) : null), stack(modelSlices(t), t.total, "stack thin")),
        el("span", { class: "model-free" }, el("strong", {}, String(t.free)), " free")
      );
      row.title = `${t.inUse} in use, ${t.free} free${t.unhealthy ? `, ${t.unhealthy} unhealthy` : ""}`;
      clickable(row, () => {
        remember("inventory.group", "model");
        void k8sdockside.openView("inventory");
      });
      list.append(row);
    }
    return block("By model", "Each row opens the inventory, grouped by model.", list);
  }
  function modelSlices(t) {
    return [
      { label: "in use", count: t.inUse, tone: "state-allocated" },
      { label: "free", count: t.free, tone: "state-free" },
      { label: "unhealthy", count: t.unhealthy, tone: "state-unhealthy" }
    ];
  }
  function vendors(inv) {
    const tones = ["chart-1", "chart-3", "chart-7", "chart-4", "chart-5", "chart-2", "chart-6", "chart-8"];
    return ring(
      "By vendor",
      inv.byVendor.map((t, i) => ({ label: t.label, count: t.total, tone: tones[i % tones.length] ?? "" })),
      { unit: "devices", onPick: () => void k8sdockside.openView("inventory") }
    );
  }
  function attention(problems) {
    if (problems.length === 0) {
      return block("Needs attention", "", nothing("Nothing. No pod is waiting for a device, no device is lost, and every driver is ready."));
    }
    const list = el("ul", { class: "issues" });
    for (const issue of problems.slice(0, 20)) {
      const row = el(
        "li",
        { class: `issue issue-${issue.tone || "none"}` },
        el("span", { class: `dot dot-${issue.tone || "none"}` }),
        el("div", { class: "issue-text" }, el("div", { class: "issue-title" }, issue.title), el("div", { class: "issue-detail" }, issue.detail))
      );
      clickable(row, () => void k8sdockside.open(issue.ref));
      list.append(row);
    }
    return block("Needs attention", problems.length > 20 ? `The worst 20 of ${problems.length}. Each row opens the object.` : "Worst first. Each row opens the object it is about.", list);
  }
  function driverBlock(list, daemons, dra) {
    const rows = el("ul", { class: "drivers" });
    for (const d of list) {
      rows.append(
        el(
          "li",
          { class: "driver" },
          pill(d.kind === "DRA driver" ? "DRA" : "device plugin", d.kind === "DRA driver" ? "dra" : "dp"),
          el("span", { class: "mono driver-name" }, d.name),
          el("span", { class: "faint" }, d.vendor),
          el("span", { class: "spacer" }),
          el("span", { class: "driver-count" }, d.devices ? `${count(d.devices, "device")} on ${count(d.nodes, "node")}` : "publishes no devices")
        )
      );
    }
    const pods = el("ul", { class: "drivers" });
    for (const d of daemons) {
      pods.append(
        el(
          "li",
          { class: "driver" },
          el("span", { class: `dot dot-${d.tone || "none"}` }),
          openName(d.name, { kind: DAEMONSETS, namespace: d.namespace, name: d.name }, "link-name mono"),
          el("span", { class: "faint" }, d.namespace),
          el("span", { class: "spacer" }),
          el("span", { class: "driver-count" }, `${d.ready} of ${d.desired} ready`)
        )
      );
    }
    return block(
      "Drivers & device plugins",
      dra ? "How the accelerators are advertised, and the daemonsets that do it." : "This cluster does not serve resource.k8s.io, so only device plugins are read.",
      list.length ? rows : nothing("Nothing advertises an accelerator."),
      daemons.length ? el("h3", {}, "Their pods") : null,
      daemons.length ? pods : null
    );
  }
  function empty(ctx, dra) {
    return el(
      "div",
      {},
      el(
        "div",
        { class: "banner" },
        el("h2", {}, `No accelerators in ${ctx.contextName}`),
        el(
          "p",
          { class: "note" },
          "No node advertises a GPU or other device through a device plugin (nvidia.com/gpu, amd.com/gpu …)" + (dra ? ", and no DRA driver publishes one in a ResourceSlice." : ", and this cluster does not serve Dynamic Resource Allocation (resource.k8s.io).") + " This page fills in as soon as one does."
        ),
        el(
          "p",
          { class: "note", style: "margin-bottom:0" },
          "No GPU to try it with? The plugin’s repository has a dev/ folder: a kind cluster with the DRA example driver’s simulated GPUs, and a KWOK fleet of fake H100 nodes."
        )
      ),
      el(
        "div",
        { class: "links" },
        button("Dynamic Resource Allocation", () => void k8sdockside.openUrl("https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/")),
        button("Device plugins", () => void k8sdockside.openUrl("https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/")),
        button("Testing without a GPU", () => void k8sdockside.openUrl("https://github.com/k8sdockside/gpu/tree/main/dev"))
      )
    );
  }
  function links(ctx) {
    const list = ctx.plugin?.links ?? [];
    if (!list.length) return null;
    return el("div", { class: "links foot" }, ...list.map((link) => button(link.label, () => void k8sdockside.openUrl(link.url))));
  }
})();
