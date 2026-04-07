#!/usr/bin/env bash
# Provision a dedicated RAM-test VM on GCE (Option 1: predefined highmem).
#
# Machine: n2-highmem-32 → 256 GiB RAM, 32 vCPUs (cap concurrency in NodeODM if you want ~8–16 effective cores).
# Defaults match .github/workflows deploy-* (project tools-471222, zone us-central1-a).
#
# This script does NOT call GCP unless you export ALLOW_PROVISION=1 (avoids accidental creates).
#
# Enables Shielded VM (Secure Boot, vTPM, integrity monitoring) for constraints/compute.requireShieldedVm.
# New VMs get scripts/super-vm-startup.sh (Docker + gcloud). Already created the VM? Run once:
#   ./scripts/bootstrap-super-vm-packages.sh
#
# Before first run: align optional settings with staging/prod, e.g.
#   gcloud compute instances describe nodeodm-asc-vm-staging \
#     --project=tools-471222 --zone=us-central1-a \
#     --format='yaml(networkInterfaces,serviceAccounts,tags)'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTUP_SCRIPT="${SCRIPT_DIR}/super-vm-startup.sh"

PROJECT_ID="${PROJECT_ID:-tools-471222}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-nodeodm-asc-vm-super}"
MACHINE_TYPE="${MACHINE_TYPE:-n2-highmem-32}"
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2204-lts}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"
# Default boot disk size; raise BOOT_DISK_SIZE for large local datasets or heavy Docker cache on root.
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-200GB}"
BOOT_DISK_TYPE="${BOOT_DISK_TYPE:-pd-balanced}"

# Optional — set in the environment to match your other NodeODM VMs (see describe above).
# Same images as staging live in GCR (not on the staging VM): pull
#   gcr.io/tools-471222/nodeodm-asc-staging:latest
# after: sudo gcloud auth configure-docker gcr.io && sudo docker pull …
# Use the same SERVICE_ACCOUNT as staging (e.g. nodeodm-service@tools-471222.iam.gserviceaccount.com)
# so the VM’s credentials can read that repo; or grant another SA Artifact Registry / Storage read on the project.
TAGS="${TAGS:-}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
NETWORK="${NETWORK:-}"
SUBNET="${SUBNET:-}"

build_args() {
  local -a args=(
    compute instances create "${VM_NAME}"
    --project="${PROJECT_ID}"
    --zone="${ZONE}"
    --machine-type="${MACHINE_TYPE}"
    --image-family="${IMAGE_FAMILY}"
    --image-project="${IMAGE_PROJECT}"
    --boot-disk-size="${BOOT_DISK_SIZE}"
    --boot-disk-type="${BOOT_DISK_TYPE}"
    --shielded-secure-boot
    --shielded-vtpm
    --shielded-integrity-monitoring
    --metadata-from-file="startup-script=${STARTUP_SCRIPT}"
  )
  [[ -n "${TAGS}" ]] && args+=(--tags="${TAGS}")
  if [[ -n "${SERVICE_ACCOUNT}" ]]; then
    args+=(
      --service-account="${SERVICE_ACCOUNT}"
      --scopes=https://www.googleapis.com/auth/cloud-platform
    )
  fi
  [[ -n "${NETWORK}" ]] && args+=(--network="${NETWORK}")
  [[ -n "${SUBNET}" ]] && args+=(--subnet="${SUBNET}")
  printf '%q ' gcloud "${args[@]}"
  echo
}

if [[ "${ALLOW_PROVISION:-}" != "1" ]]; then
  echo "Dry run — no GCP API calls. To create the VM, run:"
  echo "  ALLOW_PROVISION=1 ${0}"
  echo
  echo "Command:"
  build_args
  exit 0
fi

args=(
  compute instances create "${VM_NAME}"
  --project="${PROJECT_ID}"
  --zone="${ZONE}"
  --machine-type="${MACHINE_TYPE}"
  --image-family="${IMAGE_FAMILY}"
  --image-project="${IMAGE_PROJECT}"
  --boot-disk-size="${BOOT_DISK_SIZE}"
  --boot-disk-type="${BOOT_DISK_TYPE}"
  --shielded-secure-boot
  --shielded-vtpm
  --shielded-integrity-monitoring
  --metadata-from-file="startup-script=${STARTUP_SCRIPT}"
)
[[ -n "${TAGS}" ]] && args+=(--tags="${TAGS}")
if [[ -n "${SERVICE_ACCOUNT}" ]]; then
  args+=(
    --service-account="${SERVICE_ACCOUNT}"
    --scopes=https://www.googleapis.com/auth/cloud-platform
  )
fi
[[ -n "${NETWORK}" ]] && args+=(--network="${NETWORK}")
[[ -n "${SUBNET}" ]] && args+=(--subnet="${SUBNET}")

if [[ ! -f "${STARTUP_SCRIPT}" ]]; then
  echo "Missing ${STARTUP_SCRIPT}" >&2
  exit 1
fi

exec gcloud "${args[@]}"
