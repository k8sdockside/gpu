#!/usr/bin/env bash
# A kind cluster with simulated GPUs, through Dynamic Resource Allocation.
#
# Installs kubernetes-sigs/dra-example-driver, which publishes 8 fake GPUs
# (driver gpu.example.com) on the kind worker in a ResourceSlice, exactly as
# a real DRA driver would, and hands them out to ResourceClaims. Then applies
# dev/manifests/dra-workloads.yaml: a one-GPU pod, a two-GPU pod, a claim two
# pods share, and a pod that asks for more than there is.
#
#   dev/kind-dra.sh            create (or reuse) the cluster and install everything
#   dev/kind-dra.sh delete     delete the cluster
#
# Needs docker (or podman), kind, kubectl, helm and git. It follows the
# driver's own README (kind + its Helm chart), with two differences: it uses
# the driver image the project publishes on registry.k8s.io instead of
# building one, and it installs the chart from a checkout of the release tag.
#
# kind adds a context named kind-$CLUSTER to your kubeconfig and makes it the
# current one; every command below names that context explicitly, so nothing
# here touches any other cluster.

set -euo pipefail

CLUSTER="${CLUSTER:-gpu-dra}"
# DRA is GA (resource.k8s.io/v1) from Kubernetes 1.34. The driver's own demo
# uses this node image at v0.5.0.
NODE_IMAGE="${NODE_IMAGE:-kindest/node:v1.37.0}"
DRIVER_REF="${DRIVER_REF:-v0.5.0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/.cache"
CTX="kind-$CLUSTER"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "needs $1 on the PATH" >&2; exit 1; }; }

if [[ "${1:-}" == "delete" ]]; then
    kind delete cluster --name "$CLUSTER"
    exit 0
fi

for tool in kind kubectl helm git; do need "$tool"; done

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    say "kind cluster $CLUSTER is already there; reusing it"
else
    say "creating kind cluster $CLUSTER ($NODE_IMAGE)"
    # CDI on in containerd, as the driver's demo config does; one worker for the GPUs.
    kind create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --wait 2m --config - <<'KIND'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri"]
    enable_cdi = true
nodes:
- role: control-plane
- role: worker
KIND
fi

say "fetching dra-example-driver $DRIVER_REF (for its Helm chart)"
mkdir -p "$CACHE"
if [[ ! -d "$CACHE/dra-example-driver-$DRIVER_REF" ]]; then
    git clone --quiet --depth 1 --branch "$DRIVER_REF" https://github.com/kubernetes-sigs/dra-example-driver.git "$CACHE/dra-example-driver-$DRIVER_REF"
fi

say "installing the driver (image registry.k8s.io/dra-example-driver/dra-example-driver:$DRIVER_REF)"
helm --kube-context "$CTX" upgrade -i --create-namespace --namespace dra-example-driver \
    dra-example-driver "$CACHE/dra-example-driver-$DRIVER_REF/deployments/helm/dra-example-driver" \
    --set image.tag="$DRIVER_REF" --wait --timeout 5m

say "waiting for the driver to publish its devices"
for _ in $(seq 1 60); do
    if [[ -n "$(kubectl --context "$CTX" get resourceslices -o name 2>/dev/null)" ]]; then break; fi
    sleep 2
done
kubectl --context "$CTX" get resourceslices

say "applying the sample workloads"
kubectl --context "$CTX" apply -f "$HERE/manifests/dra-workloads.yaml"
kubectl --context "$CTX" -n dra-demo wait --for=condition=Ready pod/single-gpu-pod pod/two-gpu-pod pod/shared-a pod/shared-b --timeout 3m || true

kubectl --context "$CTX" -n dra-demo get pods,resourceclaims
cat <<DONE

Done. In K8s Dockside, open the context "$CTX" and the GPU & Accelerators
plugin: 8 simulated GPUs on $CLUSTER-worker, 4 of them in use (one shared by
two pods), and too-many-gpus-pod waiting for 16.

Add a fleet of fake H100 nodes to the same cluster:  dev/kwok-fleet.sh
Delete it all:                                      dev/kind-dra.sh delete
DONE
