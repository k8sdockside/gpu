// Built by scripts/build.mjs from src/ -- edit the TypeScript there, not this file.
"use strict";
(() => {
  // src/model/units.ts
  function memory(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const gib = bytes / 1024 ** 3;
    if (gib >= 10) return `${Math.round(gib)} GiB`;
    if (gib >= 1) return `${(Math.round(gib * 10) / 10).toString()} GiB`;
    return `${Math.round(bytes / 1024 ** 2)} MiB`;
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

  // src/model/inventory.ts
  function buildInventory(snap) {
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
      const cells2 = units.flatMap((u) => u.partitions).filter((p) => p.name === resource && p.state !== "unhealthy");
      let next = 0;
      for (const { pod, wants } of requests) {
        for (let k = 0; k < (wants[resource] ?? 0) && next < cells2.length; k++, next++) {
          const cell = cells2[next];
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
  function facts(pairs) {
    const list = el("dl", { class: "facts" });
    for (const [term, value] of pairs) {
      list.append(el("dt", {}, term), el("dd", {}, typeof value === "string" ? value || "—" : value));
    }
    return list;
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
  var STATE_TONES = { free: "ok", allocated: "info", shared: "shared", partial: "info", unhealthy: "error" };
  function stateLegend(units, counts = false) {
    const slices = ["free", "allocated", "shared", "partial", "unhealthy"].map((state) => ({ label: STATE_WORDS[state], count: units.filter((u) => u.state === state).length, tone: `state-${state}` })).filter((s) => !counts || s.count > 0 || s.tone === "state-free" || s.tone === "state-allocated");
    return legend(slices, { counts });
  }
  function unitTitle(unit) {
    const lines = [`${unit.name} — ${[unit.model, memory(unit.memory)].filter(Boolean).join(", ") || VENDOR_NAMES[unit.vendor]}`, STATE_WORDS[unit.state]];
    if (unit.consumers.length) lines.push(`Used by ${unit.consumers.map((c) => c.pod).join(", ")}`);
    else if (unit.claims.length) lines.push(`Held by claim ${unit.claims.map((c) => c.name).join(", ")}`);
    if (unit.partitions.length) lines.push(`${unit.partitions.length} partitions: ${unit.partitions.map((p) => `${p.profile} ${p.state === "free" ? "free" : p.state === "unhealthy" ? "unhealthy" : "in use"}`).join(", ")}`);
    if (unit.slots > 1) lines.push(`${unit.sharing || "Shared"}: ${Math.min(unit.consumers.length, unit.slots)} of ${unit.slots} slots taken`);
    if (unit.problem) lines.push(unit.problem);
    return lines.join("\n");
  }
  function square(unit, options = {}) {
    const classes = ["gpu", `gpu-${unit.state}`];
    if (unit.partitions.length) classes.push("gpu-cut");
    if (unit.slots > 1) classes.push("gpu-sliced");
    if (options.selected === unit.id) classes.push("selected");
    const node = el("button", { type: "button", class: classes.join(" "), title: unitTitle(unit), "aria-label": unitTitle(unit).replace(/\n/g, ". "), "data-unit": unit.id });
    if (unit.partitions.length) node.append(cells(unit));
    node.append(el("span", { class: "gpu-label" }, unit.label));
    if (unit.slots > 1) {
      const marks = el("span", { class: "gpu-slots", "aria-hidden": "true" });
      const taken = Math.min(unit.consumers.length, unit.slots);
      for (let i = 0; i < unit.slots; i++) marks.append(el("span", { class: i < taken ? "slot taken" : "slot" }));
      node.append(marks);
    }
    node.addEventListener("click", () => options.onPick?.(unit));
    node.addEventListener("mouseenter", () => options.onHover?.(unit));
    node.addEventListener("mouseleave", () => options.onHover?.(null));
    node.addEventListener("focus", () => options.onHover?.(unit));
    return node;
  }
  function cells(unit) {
    const row = el("span", { class: "gpu-cells", "aria-hidden": "true" });
    let used = 0;
    for (const partition of unit.partitions) {
      const cell = el("span", { class: `cell cell-${partition.state}` });
      cell.style.flexGrow = String(partition.slices);
      row.append(cell);
      used += partition.slices;
    }
    const rest = Math.max(0, unit.slices - used);
    if (rest > 0) {
      const gap = el("span", { class: "cell cell-uncut" });
      gap.style.flexGrow = String(rest);
      row.append(gap);
    }
    return row;
  }
  function grid(units, options = {}) {
    return el("div", { class: options.compact ? "gpu-grid compact" : "gpu-grid", role: "group" }, ...units.map((unit) => square(unit, options)));
  }
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
    return out;
  }
  function nodeCard2(view, options = {}) {
    const name = view.name ? openName(view.name, { kind: NODES, name: view.name }, "link-name node-name") : el("span", { class: "node-name" }, "Not tied to a node");
    const flags = [
      !view.ready && view.name ? pill("NotReady", "error", "Its devices cannot be used until the node is Ready") : null,
      view.unschedulable ? pill("cordoned", "warn", "New pods will not be scheduled here") : null
    ];
    const versions = [...new Set(view.units.map((u) => u.driverVersion).filter(Boolean))];
    const cuda = [...new Set(view.units.map((u) => u.cudaVersion).filter(Boolean))];
    return el(
      "article",
      { class: "node-card" },
      el("div", { class: "node-head" }, name, ...flags, el("span", { class: "spacer" }), usePill(view.units)),
      el(
        "div",
        { class: "node-sub" },
        el("span", {}, modelsLine(view.units)),
        ...sourcePills(view.units),
        versions.length ? el("span", { class: "faint" }, `driver ${versions.join(", ")}${cuda.length ? ` · CUDA ${cuda.join(", ")}` : ""}`) : null
      ),
      grid(view.units, options)
    );
  }
  function consumerRow(c) {
    return el(
      "li",
      { class: "who" },
      openName(c.pod, { kind: PODS, namespace: c.namespace, name: c.pod }),
      el("span", { class: "faint" }, c.namespace),
      c.claim ? el("span", { class: "via" }, "via ", openName(c.claim, { kind: CLAIMS, namespace: c.namespace, name: c.claim }, "link-name small")) : el("span", { class: "via" }, "via device plugin")
    );
  }
  function partitionRow(p) {
    return el(
      "li",
      { class: "part" },
      el("span", { class: `swatch fill-state-${p.state}`, "aria-hidden": "true" }),
      el("span", { class: "mono" }, p.profile || p.name),
      el("span", { class: "faint" }, memory(p.memory)),
      el("span", { class: "spacer" }),
      p.consumers.length ? el("span", {}, ...p.consumers.map((c, i) => el("span", {}, i ? ", " : "", openName(c.pod, { kind: PODS, namespace: c.namespace, name: c.pod }, "link-name small")))) : el("span", { class: "faint" }, p.claims.length ? `claim ${p.claims.map((c) => c.name).join(", ")}` : STATE_WORDS[p.state].toLowerCase())
    );
  }
  function inspector(unit, empty = "Point at a device to see what it is and who is using it. Click one to keep it here.") {
    if (!unit) return el("div", { class: "inspector empty-inspector" }, el("p", { class: "faint" }, empty));
    const head = el(
      "div",
      { class: "inspector-head" },
      el("span", { class: `swatch big fill-state-${unit.state}`, "aria-hidden": "true" }),
      el("div", {}, el("div", { class: "inspector-name" }, unit.name), el("div", { class: "faint" }, unit.model || VENDOR_NAMES[unit.vendor])),
      el("span", { class: "spacer" }),
      pill(STATE_WORDS[unit.state], STATE_TONES[unit.state])
    );
    const rows = [
      ["Node", unit.node ? openName(unit.node, { kind: NODES, name: unit.node }) : "not tied to a node"],
      ["Vendor", VENDOR_NAMES[unit.vendor]],
      ["Memory", memory(unit.memory)],
      [unit.source === "dra" ? "DRA driver" : "Resource", el("span", { class: "mono" }, unit.driver)]
    ];
    if (unit.driverVersion) rows.push(["Driver version", unit.driverVersion]);
    if (unit.cudaVersion) rows.push(["CUDA", unit.cudaVersion]);
    if (unit.slots > 1) rows.push(["Sharing", `${unit.sharing || "shared"}, ${unit.slots} slots — ${Math.min(unit.consumers.length, unit.slots)} taken`]);
    if (unit.device) rows.push(["ResourceSlice", openName(unit.device.slice, { kind: SLICES, name: unit.device.slice }, "link-name small")]);
    const who = unit.consumers.length ? el("ul", { class: "whos" }, ...unit.consumers.map(consumerRow)) : unit.claims.length ? el("p", { class: "note" }, "Held by ", ...unit.claims.map((c, i) => el("span", {}, i ? ", " : "", openName(c.name, { kind: CLAIMS, namespace: c.namespace, name: c.name }))), ", which no pod is using right now.") : el("p", { class: "faint", style: "margin:0" }, unit.state === "unhealthy" ? "Nobody — it cannot be handed out." : "Nobody. It is free.");
    const attributes = unit.device ? Object.entries(unit.device.attributes).sort(([a], [b]) => a.localeCompare(b)) : [];
    const capacity = unit.device ? Object.entries(unit.device.capacity).sort(([a], [b]) => a.localeCompare(b)) : [];
    return el(
      "div",
      { class: "inspector" },
      head,
      unit.problem ? el("p", { class: "problem" }, unit.problem) : null,
      facts(rows),
      el("h3", {}, unit.consumers.length > 1 ? `Used by ${count(unit.consumers.length, "pod")}` : "Used by"),
      who,
      unit.inferred && unit.consumers.length ? el("p", { class: "hint" }, "The device plugin says how many GPUs a pod got, not which ones. Pods are drawn on the cards in order.") : null,
      unit.partitions.length ? el("div", {}, el("h3", {}, `${count(unit.partitions.length, "partition")} of ${unit.slices} slices`), el("ul", { class: "parts" }, ...unit.partitions.map(partitionRow))) : null,
      attributes.length ? el("div", {}, el("h3", {}, "Attributes"), el("ul", { class: "params" }, ...attributes.map(([k, v]) => param(k, v)))) : null,
      capacity.length ? el("div", {}, el("h3", {}, "Capacity"), el("ul", { class: "params" }, ...capacity.map(([k, v]) => param(k, v)))) : null
    );
  }
  function param(name, value) {
    return el("li", { class: "param" }, el("span", { class: "param-name mono" }, name), el("span", { class: "param-value mono" }, value));
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

  // src/pages/inventory.ts
  var GROUPS = [
    ["node", "Node"],
    ["model", "Model"],
    ["driver", "Driver"]
  ];
  var REFRESH = 1e4;
  start("page", async (ctx) => {
    replace(byId("head"), heading("Inventory", `Every accelerator in ${ctx.contextName}, on the machine it is in.`));
    const body = byId("body");
    const bar = byId("bar");
    const failure = el("p", { class: "refresh-failure" });
    let group = await remembered("inventory.group", "node");
    if (!GROUPS.some(([g]) => g === group)) group = "node";
    let filter = "";
    let pinned = await remembered("inventory.pin", "");
    if (pinned) void k8sdockside.storage?.remove("inventory.pin")?.catch(() => void 0);
    let hovered = null;
    let inventory = null;
    const side = el("aside", { class: "side" });
    const main = el("div", { class: "groups" });
    const summary = el("p", { class: "summary" });
    const legendHost = el("div", { class: "legend-host" });
    const showInspector = () => {
      const unit = hovered ?? inventory?.units.find((u) => u.id === pinned);
      replace(side, inspector(unit));
    };
    const options = {
      onPick: (unit) => {
        pinned = pinned === unit.id ? "" : unit.id;
        hovered = null;
        for (const node of main.querySelectorAll(".gpu.selected")) node.classList.remove("selected");
        if (pinned) main.querySelector(`[data-unit="${CSS.escape(pinned)}"]`)?.classList.add("selected");
        showInspector();
      },
      onHover: (unit) => {
        hovered = unit;
        showInspector();
      }
    };
    const segmented = el("div", { class: "segmented", role: "group", "aria-label": "Group by" });
    const drawButtons = () => {
      replace(
        segmented,
        el("span", { class: "segmented-label" }, "Group by"),
        ...GROUPS.map(([g, label]) => {
          const b = el("button", { type: "button", class: g === group ? "on" : "", "aria-pressed": g === group ? "true" : "false" }, label);
          b.addEventListener("click", () => {
            group = g;
            remember("inventory.group", g);
            drawButtons();
            draw();
          });
          return b;
        })
      );
    };
    drawButtons();
    const search = el("input", { type: "search", placeholder: "Filter by node, model, driver or pod", "aria-label": "Filter" });
    search.addEventListener("input", () => {
      filter = search.value.trim().toLowerCase();
      draw();
    });
    replace(bar, segmented, search, el("span", { class: "spacer" }), legendHost);
    const draw = () => {
      if (!inventory) return;
      const units = inventory.units.filter((u) => matches(u, filter));
      replace(legendHost, stateLegend(inventory.units));
      summary.textContent = summaryLine(inventory, units);
      if (inventory.units.length === 0) {
        replace(main, nothing("No accelerators here: no node advertises one through a device plugin, and no DRA driver publishes one."));
      } else if (units.length === 0) {
        replace(main, nothing(`Nothing matches “${filter}”.`));
      } else if (group === "node") {
        const shown = new Set(units);
        replace(main, el("div", { class: "node-cards" }, ...inventory.nodes.filter((n) => n.units.some((u) => shown.has(u))).map((n) => nodeCard2({ ...n, units: n.units.filter((u) => shown.has(u)) }, { ...options, selected: pinned }))));
      } else {
        replace(main, ...grouped(units, group, { ...options, selected: pinned }));
      }
      showInspector();
    };
    replace(body, failure, summary, el("div", { class: "inventory" }, main, side));
    const stop = every(
      REFRESH,
      async () => {
        const snap = await loadSnapshot({ events: false, daemonSets: false });
        inventory = buildInventory(snap);
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
  function matches(unit, filter) {
    if (!filter) return true;
    const words = [unit.node, unit.model, unit.name, unit.driver, VENDOR_NAMES[unit.vendor], ...unit.consumers.map((c) => `${c.namespace}/${c.pod}`), ...unit.claims.map((c) => c.name)];
    return words.some((w) => w.toLowerCase().includes(filter));
  }
  function summaryLine(inv, shown) {
    const nodes = new Set(shown.map((u) => u.node)).size;
    const used = shown.filter((u) => u.state === "allocated" || u.state === "shared" || u.state === "partial").length;
    const lead = shown.length === inv.units.length ? "" : `Showing ${shown.length} of ${inv.units.length}: `;
    return `${lead}${count(shown.length, "accelerator")} on ${count(nodes, "node")}, ${used} in use.`;
  }
  function grouped(units, by, options) {
    const groups = /* @__PURE__ */ new Map();
    for (const unit of units) {
      const key = by === "model" ? unit.model || `${VENDOR_NAMES[unit.vendor]} (no model reported)` : `${unit.source === "dra" ? "DRA" : "device plugin"} · ${unit.driver === "nvidia.com/mig" ? "nvidia.com/mig-*" : unit.driver}`;
      groups.set(key, [...groups.get(key) ?? [], unit]);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([label, members]) => {
      const byNode = /* @__PURE__ */ new Map();
      for (const unit of members) byNode.set(unit.node, [...byNode.get(unit.node) ?? [], unit]);
      return el(
        "article",
        { class: "group-card" },
        el("div", { class: "node-head" }, el("span", { class: "group-name" }, label), ...by === "model" ? sourcePills(members) : [], el("span", { class: "spacer" }), usePill(members)),
        el(
          "div",
          { class: "group-rows" },
          ...[...byNode.entries()].map(
            ([node, list]) => el("div", { class: "group-row" }, el("div", { class: "row-node" }, node ? openName(node, { kind: NODES, name: node }) : el("span", { class: "faint" }, "no node")), grid(list, options))
          )
        )
      );
    });
  }
})();
